package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

var (
	errForwardingDisabled = errors.New("provider forwarding is not configured")
	errJobLimit           = errors.New("provider job concurrency limit reached")
	errShuttingDown       = errors.New("server is shutting down; inspect existing request status")
	errDifferentContent   = errors.New("request ID belongs to different content")
)

// reconstructError separates storage reconstruction failures from mailbox and
// journal failures so HTTP callers can keep their endpoint-specific mapping.
type reconstructError struct{ cause error }

func (e *reconstructError) Error() string { return e.cause.Error() }
func (e *reconstructError) Unwrap() error { return e.cause }

type jobServiceConfig struct {
	Store         *store.Store
	Mailbox       *mailbox.Mailbox
	Journal       *journal.Journal
	Policy        *upstream.Policy
	Upstream      *http.Client
	MaxConcurrent int
	MaxRuntime    time.Duration
	IdleTimeout   time.Duration
	Context       context.Context
}

// jobService owns provider-job submission, admission, execution, cancellation,
// and shutdown.
type jobService struct {
	store       *store.Store
	mailbox     *mailbox.Mailbox
	journal     *journal.Journal
	policy      *upstream.Policy
	upstream    *http.Client
	slots       chan struct{}
	maxRuntime  time.Duration
	idleTimeout time.Duration
	context     context.Context
	stop        context.CancelFunc
	jobs        sync.WaitGroup
	lifecycle   sync.Mutex
	closing     bool
	closeOnce   sync.Once
}

func newJobService(config jobServiceConfig) *jobService {
	jobsContext, stopJobs := context.WithCancel(config.Context)
	j := &jobService{
		store: config.Store, mailbox: config.Mailbox, journal: config.Journal,
		policy: config.Policy, upstream: config.Upstream,
		slots: make(chan struct{}, config.MaxConcurrent), maxRuntime: config.MaxRuntime,
		idleTimeout: config.IdleTimeout, context: jobsContext, stop: stopJobs,
	}
	j.jobs.Add(1)
	go func() {
		defer j.jobs.Done()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-jobsContext.Done():
				return
			case <-ticker.C:
				_ = j.mailbox.Sweep()
			}
		}
	}()
	return j
}

func (j *jobService) Enabled() bool             { return j.policy.Enabled() }
func (j *jobService) MaxConcurrent() int        { return cap(j.slots) }
func (j *jobService) MaxRuntime() time.Duration { return j.maxRuntime }

// Submit owns durable submission from replay lookup through terminal job
// ownership. It never regenerates an existing request: same-content retries
// return the stored record, while conflicts and uncertain claims are errors.
func (j *jobService) Submit(ctx context.Context, input protocol.ForwardRequest, fingerprint string) (protocol.RequestStatus, bool, error) {
	if !j.Enabled() {
		return protocol.RequestStatus{}, false, errForwardingDisabled
	}
	existing, _, err := j.mailbox.Lookup(input.ID)
	switch {
	case err == nil:
		if existing.Fingerprint != fingerprint {
			return protocol.RequestStatus{}, false, errDifferentContent
		}
		return existing, false, nil
	case !errors.Is(err, os.ErrNotExist):
		return protocol.RequestStatus{}, false, err
	}
	body, err := j.store.Reconstruct(ctx, input.Manifest)
	if err != nil {
		return protocol.RequestStatus{}, false, &reconstructError{cause: err}
	}
	bodyOwned := false
	defer func() {
		if !bodyOwned {
			_ = body.Close()
		}
	}()
	releaseSlot := true
	select {
	case j.slots <- struct{}{}:
		defer func() {
			if releaseSlot {
				<-j.slots
			}
		}()
	default:
		return protocol.RequestStatus{}, false, errJobLimit
	}
	if err := j.mailbox.Sweep(); err != nil {
		return protocol.RequestStatus{}, false, err
	}
	// Acceptance and cancellation are serialized by the mailbox claim callback:
	// a cancellation that arrives first leaves a tombstone that Accept conflicts
	// with, and a cancellation that arrives later receives the persisted record.
	record, created, err := j.mailbox.Accept(input.ID, fingerprint, input.Manifest.Hash, func() error {
		return j.journal.Claim(input.ID, fingerprint)
	})
	if err != nil {
		return protocol.RequestStatus{}, false, err
	}
	if !created {
		return record, false, nil
	}
	j.lifecycle.Lock()
	if j.closing || j.context.Err() != nil {
		j.lifecycle.Unlock()
		_ = j.mailbox.Finish(input.ID, protocol.Interrupted, "server_shutdown", "")
		return record, true, errShuttingDown
	}
	jobContext, start, err := j.mailbox.Start(input.ID, j.context, j.maxRuntime)
	if err != nil {
		j.lifecycle.Unlock()
		_ = j.mailbox.Finish(input.ID, protocol.Interrupted, "persistence_failed", "")
		return record, true, err
	}
	if start {
		bodyOwned, releaseSlot = true, false
		j.jobs.Add(1)
		go func() {
			defer j.jobs.Done()
			defer func() { <-j.slots }()
			defer body.Close()
			j.run(jobContext, input, body)
		}()
	}
	j.lifecycle.Unlock()
	return record, true, nil
}

// Cancel persists an explicit cancellation tombstone. The mailbox serializes it
// with acceptance and invokes the same journal claim used by submission.
func (j *jobService) Cancel(id string) (protocol.RequestStatus, error) {
	if !j.Enabled() || j.journal == nil {
		return protocol.RequestStatus{}, errForwardingDisabled
	}
	return j.mailbox.Cancel(id, func() error {
		return j.journal.Claim(id, protocol.Sum([]byte("cancel:"+id)))
	})
}

func (j *jobService) run(ctx context.Context, input protocol.ForwardRequest, body *os.File) {
	state, code := protocol.Failed, "provider_connection_unknown"
	hash := sha256.New()
	defer func() { _ = j.mailbox.Finish(input.ID, state, code, hex.EncodeToString(hash.Sum(nil))) }()
	request, err := http.NewRequestWithContext(ctx, input.Method, input.Target, body)
	if err != nil {
		code = "invalid_provider_request"
		return
	}
	request.Header, request.ContentLength = input.Headers, input.Manifest.Size
	response, err := j.upstream.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			state, code = protocol.Interrupted, "job_deadline_or_shutdown"
		}
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		code = "provider_redirect_refused"
		return
	}
	headers := upstream.CleanHeaders(response.Header)
	if upstream.ValidateHeaders(headers) != nil {
		code = "provider_headers_invalid"
		return
	}
	if err := j.mailbox.SetHeaders(input.ID, response.StatusCode, headers); err != nil {
		code = "response_storage_failed"
		return
	}
	// Provider inactivity is independent of PC reachability. Cancelling this
	// child context cannot be confused with a subscriber's disconnected socket.
	readContext, cancel := context.WithCancel(ctx)
	defer cancel()
	timer := time.AfterFunc(j.idleTimeout, func() { cancel(); response.Body.Close() })
	defer timer.Stop()
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			if err := j.mailbox.Append(input.ID, buffer[:n]); err != nil {
				code = "response_storage_failed"
				if errors.Is(err, mailbox.ErrFull) {
					code = "response_storage_full"
				}
				return
			}
			_, _ = hash.Write(buffer[:n])
			timer.Reset(j.idleTimeout)
		}
		if readErr != nil {
			if readErr == io.EOF && ctx.Err() == nil && readContext.Err() == nil {
				state, code = protocol.Completed, ""
			} else {
				code = "provider_stream_interrupted"
				if readContext.Err() != nil {
					code = "provider_idle_timeout"
				}
				if ctx.Err() != nil {
					state, code = protocol.Interrupted, "job_deadline_or_shutdown"
				}
			}
			return
		}
	}
}

// Close stops admission, cancels running jobs and mailbox contexts, and waits
// for terminal records in the same order as the previous server lifecycle.
func (j *jobService) Close() {
	j.closeOnce.Do(func() {
		j.lifecycle.Lock()
		j.closing = true
		j.stop()
		j.mailbox.Close()
		j.lifecycle.Unlock()
		j.jobs.Wait()
	})
}
