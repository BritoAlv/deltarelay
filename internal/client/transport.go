package client

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"deltarelay/internal/inspection"
	"deltarelay/internal/protocol"
)

// attemptSpec describes the endpoint-specific parts of one HTTP attempt.
// Retry policy stays above this layer; every call to execute is exactly one
// attempt. Fields that do not apply to an operation are left at their zero
// value so the differences remain visible at each call site.
type attemptSpec struct {
	method             string
	path               string
	contentType        string
	data               []byte
	headers            http.Header
	compressible       bool
	cacheSlot          bool
	userAgent          string
	acceptedStatus     func(int) bool
	responseLimit      int64
	responseLimitError error
	transportContext   string
	sent               *atomic.Int64
	requests           *atomic.Int64
}

// attemptResponse is a fully read, bounded response. Keeping the complete body
// here lets every caller release its connection and watchdog before proceeding.
type attemptResponse struct {
	inspectionIndex int
	status          int
	header          http.Header
	body            []byte
}

func acceptedOK(status int) bool  { return status == http.StatusOK }
func accepted2xx(status int) bool { return status >= 200 && status < 300 }

// execute performs one authenticated HTTP attempt: cache-slot admission,
// optional compression, state headers, watchdog activity, redirect policy,
// bounded response reading, transport-error conversion, and cleanup. Redirect
// policy is installed once in New and is shared by every attempt.
func (c *Client) execute(ctx context.Context, spec attemptSpec) (attemptResponse, error) {
	if err := ctx.Err(); err != nil {
		return attemptResponse{}, err
	}
	releaseSlot := func() {}
	if spec.cacheSlot {
		select {
		case c.cacheSlots <- struct{}{}:
		case <-ctx.Done():
			return attemptResponse{}, ctx.Err()
		}
		var once sync.Once
		releaseSlot = func() { once.Do(func() { <-c.cacheSlots }) }
	}
	data := spec.data
	compressed := false
	if spec.compressible && !c.config.NoCompression {
		var buffer bytes.Buffer
		gz, err := gzip.NewWriterLevel(&buffer, gzip.BestSpeed)
		if err != nil {
			releaseSlot()
			return attemptResponse{}, err
		}
		if _, err := gz.Write(data); err != nil {
			releaseSlot()
			return attemptResponse{}, err
		}
		if err := gz.Close(); err != nil {
			releaseSlot()
			return attemptResponse{}, err
		}
		if buffer.Len() < len(data) {
			data, compressed = buffer.Bytes(), true
		}
	}
	attemptCtx, cancel, touch := c.attempt(ctx)
	release := func() {
		cancel()
		releaseSlot()
	}
	// Until a response exists, the deferred cleanup owns the watchdog and slot.
	// Once it exists, wrapping its body transfers that ownership to Body.Close.
	haveResponse := false
	defer func() {
		if !haveResponse {
			release()
		}
	}()
	var reader io.Reader
	var observed *countingReader
	if spec.data != nil {
		observed = &countingReader{reader: bytes.NewReader(data), count: spec.sent, touch: touch, inspectionIndex: -1}
		reader = observed
	}
	req, err := http.NewRequestWithContext(attemptCtx, spec.method, c.base+spec.path, reader)
	if err != nil {
		return attemptResponse{}, err
	}
	if spec.headers != nil {
		req.Header = spec.headers.Clone()
	}
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", spec.userAgent)
	if spec.data != nil {
		req.ContentLength = int64(len(data))
		if spec.contentType != "" {
			req.Header.Set("Content-Type", spec.contentType)
		}
	}
	if compressed {
		req.Header.Set("Content-Encoding", "gzip")
	}
	c.addState(req)
	if spec.requests != nil {
		spec.requests.Add(1)
	}
	capture := inspection.FromContext(ctx)
	inspectionIndex, observedStatus, outcome := -1, 0, "transport_error"
	if capture != nil && spec.sent != nil && spec.requests != nil {
		operation := "control"
		switch spec.path {
		case "/v2/missing":
			operation = "inventory"
		case "/v2/chunks":
			operation = "chunks"
		case "/v2/assemble":
			operation = "assemble"
		default:
			// Path-based rather than method-based: a future dispatch method must
			// still get the redacted projection, never an accidental raw capture.
			if strings.HasPrefix(spec.path, "/v2/requests/") {
				operation = "dispatch"
			}
		}
		encoding := "identity"
		if compressed {
			encoding = "gzip"
		}
		inspectionIndex = capture.BeginAttempt(ctx, operation, spec.method, spec.path, spec.contentType, encoding, spec.data, data, true)
		if observed != nil {
			observed.capture, observed.inspectionIndex = capture, inspectionIndex
		}
		defer func() { capture.EndAttempt(inspectionIndex, observedStatus, outcome) }()
	}
	response, err := c.http.Do(req)
	if err != nil {
		// Do not expose request URLs, transport credentials, or response bodies.
		if spec.transportContext != "" {
			err = fmt.Errorf("%s: %w", spec.transportContext, err)
		}
		return attemptResponse{}, &TransportError{Err: err}
	}
	haveResponse = true
	observedStatus = response.StatusCode
	response.Body = &activityReader{ReadCloser: response.Body, touch: touch}
	response.Body = &releaseBody{ReadCloser: response.Body, release: release}
	defer response.Body.Close()
	if spec.acceptedStatus != nil && !spec.acceptedStatus(response.StatusCode) {
		outcome = "http_error"
		return attemptResponse{}, responseError(response)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, spec.responseLimit+1))
	if err != nil {
		outcome = "response_read_error"
		return attemptResponse{}, &TransportError{Err: err}
	}
	if int64(len(body)) > spec.responseLimit {
		outcome = "response_limit"
		if spec.responseLimitError != nil {
			return attemptResponse{}, spec.responseLimitError
		}
		return attemptResponse{}, errors.New("relay response exceeds size limit")
	}
	outcome = "response_ok"
	return attemptResponse{inspectionIndex: inspectionIndex, status: response.StatusCode, header: response.Header, body: body}, nil
}

func (c *Client) addState(req *http.Request) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.stateID != "" {
		req.Header.Set("X-DeltaRelay-State-ID", c.stateID)
	}
}

// rpc reads a whole bounded segment before making any bytes visible to callers.
func (c *Client) rpc(ctx context.Context, method, path string, data []byte, headers http.Header, limit int64, sent, requests *atomic.Int64) (attemptResponse, error) {
	spec := attemptSpec{
		method:             method,
		path:               path,
		data:               data,
		headers:            headers,
		userAgent:          "deltarelay/2",
		acceptedStatus:     accepted2xx,
		responseLimit:      limit,
		responseLimitError: errors.New("relay response exceeds contract limit"),
		sent:               sent,
		requests:           requests,
	}
	if data != nil {
		spec.contentType = "application/json"
	}
	return c.execute(ctx, spec)
}

func responseError(response *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	var detail protocol.ErrorResponse
	if json.Unmarshal(data, &detail) != nil || detail.Error == "" {
		detail.Error = http.StatusText(response.StatusCode)
	}
	delay := time.Duration(0)
	if seconds, err := strconv.ParseInt(response.Header.Get("Retry-After"), 10, 64); err == nil && seconds >= 0 && seconds <= 86400 {
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
		delay = max(0, time.Until(at))
	}
	return &HTTPError{Status: response.StatusCode, Detail: detail.Error, Code: detail.Code, RetryAfter: delay}
}

type releaseBody struct {
	io.ReadCloser
	once    sync.Once
	release func()
}

func (b *releaseBody) Close() error {
	b.once.Do(b.release)
	return b.ReadCloser.Close()
}

type activityReader struct {
	io.ReadCloser
	touch func()
}

func (r *activityReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.touch()
	}
	return n, err
}

type countingReader struct {
	reader          io.Reader
	count           *atomic.Int64
	touch           func()
	capture         *inspection.Capture
	inspectionIndex int
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		r.capture.Consume(r.inspectionIndex, n)
		if r.count != nil {
			r.count.Add(int64(n))
		}
		if r.touch != nil {
			r.touch()
		}
	}
	return n, err
}

// The watchdog is per attempt, not a deadline on an entire generation. Activity
// resets it; status/response long polls are bounded to 20s by the contract.
func (c *Client) attempt(ctx context.Context) (context.Context, context.CancelFunc, func()) {
	child, cancel := context.WithCancel(ctx)
	var mu sync.Mutex
	stopped := false
	timer := time.AfterFunc(c.config.StallTimeout, cancel)
	touch := func() {
		mu.Lock()
		defer mu.Unlock()
		if !stopped {
			timer.Reset(c.config.StallTimeout)
		}
	}
	stop := func() { mu.Lock(); stopped = true; timer.Stop(); mu.Unlock(); cancel() }
	return child, stop, touch
}
