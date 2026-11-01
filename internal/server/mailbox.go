package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

const pollTimeout = 20 * time.Second

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	limits := s.mailbox.Limits()
	used, limit := s.store.Usage()
	writeJSON(w, http.StatusOK, protocol.Info{
		Version: protocol.RelayVersion, ChunkVersion: protocol.Version, StateID: s.mailbox.StateID(), Forwarding: s.policy.Enabled(),
		Capabilities: []string{"durable-mailbox", "idempotent-submit", "response-offsets", "body-ranges", "explicit-cancel", "receipt-ack"},
		MaxBodyBytes: s.maxBodySize, MaxResponseBytes: limits.MaxResponseBytes, MaxResponseStorageBytes: limits.MaxBytes,
		MaxChunkBytes:protocol.MaxChunkSize,MaxManifestBytes:protocol.MaxManifestBytes,MaxBatchBytes:protocol.MaxUploadBatchBytes,MaxBatchChunks:protocol.MaxUploadBatchCount,
		ResponseSegmentBytes:protocol.ResponseSegmentBytes,PollTimeoutSeconds:int(pollTimeout/time.Second),
		ResponseStorageBytes: s.mailbox.Usage(), RetentionSeconds: max(1, int64(limits.Retention/time.Second)), MaxRuntimeSeconds: max(1, int64(s.maxRuntime/time.Second)),
		MaxConcurrent: cap(s.forwardSlots), MaxJournalRecords: s.maxJournalRecords, CacheBytes: used, MaxCacheBytes: limit,
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, result any) bool {
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, 415, "application/json required")
		return false
	}
	reader, closeBody, err := decodedBody(w, r, limit)
	if err != nil {
		writeError(w, 400, "invalid content encoding")
		return false
	}
	defer closeBody()
	data, err := io.ReadAll(reader)
	if err != nil || int64(len(data)) > limit {
		writeError(w, 400, "invalid or oversized JSON body")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(result) != nil || decoder.Decode(&extra) != io.EOF {
		writeError(w, 400, "expected one valid JSON object")
		return false
	}
	return true
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	if !s.policy.Enabled() {
		writeError(w, 503, "provider forwarding is not configured")
		return
	}
	id := r.PathValue("id")
	var input protocol.ForwardRequest
	if !decodeJSON(w, r, protocol.MaxManifestBytes, &input) {
		return
	}
	if input.Version != protocol.RelayVersion || !protocol.ValidRequestID(id) || input.ID != id || input.Method != http.MethodPost {
		writeError(w, 400, "invalid version, request ID or method")
		return
	}
	if err := input.Manifest.Validate(s.maxBodySize, protocol.DefaultMaxChunks); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if upstream.ValidateHeaders(input.Headers) != nil {
		writeError(w, 400, "invalid provider headers")
		return
	}
	if _, err := s.policy.Match(input.Target); err != nil {
		writeError(w, 403, "upstream URL is not allowlisted")
		return
	}
	input.Headers = upstream.CleanHeaders(input.Headers)
	if encoding := input.Headers.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		writeError(w, 400, "decoded provider content required")
		return
	}
	input.Headers.Del("Content-Encoding")
	// Match the legacy fingerprint, so both APIs share the durable claim journal.
	fingerprint, _ := json.Marshal(struct {
		Target  string
		Headers http.Header
		Hash    string
		Size    int64
	}{input.Target, input.Headers, input.Manifest.Hash, input.Manifest.Size})
	digest := protocol.Sum(fingerprint)
	if existing, _, err := s.mailbox.Lookup(id); err == nil {
		if existing.Fingerprint != digest {
			writeCode(w, 409, "request_conflict", "request ID belongs to different content")
			return
		}
		writeJSON(w, 200, existing)
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		s.mailboxError(w, err)
		return
	}
	body, err := s.store.Reconstruct(r.Context(), input.Manifest)
	if err != nil {
		if errors.Is(err, store.ErrUnavailableChunk) {
			writeCode(w, 409, "missing_chunks", "chunks missing or corrupt; synchronize again")
		} else if errors.Is(err, store.ErrIntegrity) {
			writeError(w, 422, "reconstructed body SHA-256 mismatch")
		} else {
			writeError(w, 500, "cannot reconstruct request")
		}
		return
	}
	owned := false
	defer func() {
		if !owned {
			body.Close()
		}
	}()
	select {
	case s.forwardSlots <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, 503, "provider job concurrency limit reached")
		return
	}
	release := true
	defer func() {
		if release {
			<-s.forwardSlots
		}
	}()
	if err := s.mailbox.Sweep(); err != nil {
		s.mailboxError(w, err)
		return
	}
	record, created, err := s.mailbox.Accept(id, digest, input.Manifest.Hash, func() error { return s.journal.Claim(id, digest) })
	if err != nil {
		s.mailboxError(w, err)
		return
	}
	if created {
		s.lifecycle.Lock()
		if s.closing || s.jobsContext.Err() != nil {
			s.lifecycle.Unlock()
			_ = s.mailbox.Finish(id, protocol.Interrupted, "server_shutdown", "")
			writeError(w, 503, "server is shutting down; inspect existing request status")
			return
		}
		ctx, start, err := s.mailbox.Start(id, s.jobsContext, s.maxRuntime)
		if err != nil {
			s.lifecycle.Unlock()
			_ = s.mailbox.Finish(id, protocol.Interrupted, "persistence_failed", "")
			s.mailboxError(w, err)
			return
		}
		if start {
			owned, release = true, false
			s.jobs.Add(1)
			go func() {
				defer s.jobs.Done()
				defer func() { <-s.forwardSlots }()
				defer body.Close()
				s.runJob(ctx, input, body)
			}()
		}
		s.lifecycle.Unlock()
	}
	status := http.StatusOK
	if created {
		status = http.StatusAccepted
	}
	writeJSON(w, status, record)
}

func (s *Server) runJob(ctx context.Context, input protocol.ForwardRequest, body *os.File) {
	state, code := protocol.Failed, "provider_connection_unknown"
	hash := sha256.New()
	defer func() { _ = s.mailbox.Finish(input.ID, state, code, hex.EncodeToString(hash.Sum(nil))) }()
	request, err := http.NewRequestWithContext(ctx, input.Method, input.Target, body)
	if err != nil {
		code = "invalid_provider_request"
		return
	}
	request.Header, request.ContentLength = input.Headers, input.Manifest.Size
	response, err := s.upstream.Do(request)
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
	if err := s.mailbox.SetHeaders(input.ID, response.StatusCode, headers); err != nil {
		code = "response_storage_failed"
		return
	}
	// Provider inactivity is independent of PC reachability. Cancelling this
	// child context cannot be confused with a subscriber's disconnected socket.
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	timer := time.AfterFunc(s.idleTimeout, func() { cancel(); response.Body.Close() })
	defer timer.Stop()
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			if err := s.mailbox.Append(input.ID, buffer[:n]); err != nil {
				code = "response_storage_failed"
				if errors.Is(err, mailbox.ErrFull) {
					code = "response_storage_full"
				}
				return
			}
			_, _ = hash.Write(buffer[:n])
			timer.Reset(s.idleTimeout)
		}
		if readErr != nil {
			if readErr == io.EOF && ctx.Err() == nil && readCtx.Err() == nil {
				state, code = protocol.Completed, ""
			} else {
				code = "provider_stream_interrupted"
				if readCtx.Err() != nil {
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

func (s *Server) requestStatus(w http.ResponseWriter, r *http.Request) {
	if !protocol.ValidRequestID(r.PathValue("id")) {
		writeError(w, 400, "invalid request ID")
		return
	}
	timer := time.NewTimer(pollTimeout)
	defer timer.Stop()
	for {
		record, changed, err := s.mailbox.Lookup(r.PathValue("id"))
		if err != nil {
			s.mailboxError(w, err)
			return
		}
		if r.URL.Query().Get("wait") != "1" || record.Status != 0 || protocol.Terminal(record.State) {
			writeJSON(w, 200, record)
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		case <-timer.C:
			writeJSON(w, 200, record)
			return
		}
	}
}

func (s *Server) requestResponse(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !protocol.ValidRequestID(id) {
		writeError(w, 400, "invalid request ID")
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset < 0 {
		writeError(w, 400, "non-negative byte offset required")
		return
	}
	timer := time.NewTimer(pollTimeout)
	defer timer.Stop()
	for {
		record, data, changed, err := s.mailbox.Read(id, offset)
		if err != nil {
			s.mailboxError(w, err)
			return
		}
		if len(data) != 0 || protocol.Terminal(record.State) {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-DeltaRelay-State-ID", record.StateID)
			w.Header().Set("X-DeltaRelay-Request-ID", id)
			w.Header().Set("X-DeltaRelay-Offset", strconv.FormatInt(offset, 10))
			w.Header().Set("X-DeltaRelay-Segment-Hash", protocol.Sum(data))
			w.Header().Set("Content-Length", strconv.Itoa(len(data)))
			w.WriteHeader(200)
			_, _ = w.Write(data)
			return
		}
		select {
		case <-changed:
		case <-r.Context().Done():
			return
		case <-timer.C:
			w.WriteHeader(204)
			return
		}
	}
}

func (s *Server) acknowledge(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !protocol.ValidRequestID(id) {
		writeError(w, 400, "invalid request ID")
		return
	}
	var receipt protocol.Receipt
	if !decodeJSON(w, r, 4096, &receipt) {
		return
	}
	record, err := s.mailbox.Ack(id, receipt)
	if err != nil {
		s.mailboxError(w, err)
		return
	}
	writeJSON(w, 200, record)
}

func (s *Server) cancelRequest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.policy.Enabled() || !protocol.ValidRequestID(id) {
		writeError(w, 400, "forwarding disabled or invalid request ID")
		return
	}
	record, err := s.mailbox.Cancel(id, func() error { return s.journal.Claim(id, protocol.Sum([]byte("cancel:"+id))) })
	if err != nil {
		s.mailboxError(w, err)
		return
	}
	writeJSON(w, 200, record)
}

func (s *Server) mailboxError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, os.ErrNotExist):
		writeCode(w, 404, "request_not_found", "request ID not found; never redispatch an uncertain request to another relay")
	case errors.Is(err, mailbox.ErrConflict), errors.Is(err, journal.ErrUsed):
		writeCode(w, 409, "request_conflict", "request ID conflicts or has a legacy/uncertain dispatch claim; automatic replay refused")
	case errors.Is(err, mailbox.ErrGone):
		writeCode(w, 410, "response_gone", "response was acknowledged or expired; generation will not be repeated")
	case errors.Is(err, mailbox.ErrFull), errors.Is(err, journal.ErrFull):
		writeCode(w, 507, "storage_full", "response storage or request journal limit reached")
	case errors.Is(err, mailbox.ErrIntegrity):
		writeCode(w, 422, "response_integrity", "saved response failed integrity verification")
	default:
		writeCode(w, 500, "mailbox_storage", "mailbox persistence unavailable; automatic provider replay refused")
	}
}
