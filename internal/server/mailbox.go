package server

import (
	"errors"
	"net/http"
	"os"
	"strconv"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
)

const pollTimeout = 20 * time.Second

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	limits := s.mailbox.Limits()
	used, limit := s.store.Usage()
	writeJSON(w, http.StatusOK, protocol.Info{
		Version: protocol.RelayVersion, ChunkVersion: protocol.Version, StateID: s.mailbox.StateID(), Forwarding: s.policy.Enabled(),
		Capabilities: []string{"durable-mailbox", "idempotent-submit", "response-offsets", "body-ranges", "explicit-cancel", "receipt-ack"},
		MaxBodyBytes: s.maxBodySize, MaxResponseBytes: limits.MaxResponseBytes, MaxResponseStorageBytes: limits.MaxBytes,
		MaxChunkBytes: protocol.MaxChunkSize, MaxManifestBytes: protocol.MaxManifestBytes, MaxBatchBytes: protocol.MaxUploadBatchBytes, MaxBatchChunks: protocol.MaxUploadBatchCount,
		ResponseSegmentBytes: protocol.ResponseSegmentBytes, PollTimeoutSeconds: int(pollTimeout / time.Second),
		ResponseStorageBytes: s.mailbox.Usage(), RetentionSeconds: max(1, int64(limits.Retention/time.Second)), MaxRuntimeSeconds: max(1, int64(s.jobs.MaxRuntime()/time.Second)),
		MaxConcurrent: s.jobs.MaxConcurrent(), MaxJournalRecords: s.maxJournalRecords, CacheBytes: used, MaxCacheBytes: limit,
	})
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	if !s.jobs.Enabled() {
		writeError(w, 503, "provider forwarding is not configured")
		return
	}
	id := r.PathValue("id")
	var input protocol.ForwardRequest
	if !decodeJSON(w, r, protocol.MaxManifestBytes, &input) {
		return
	}
	if !validProviderEnvelope(input, protocol.RelayVersion, id) {
		writeError(w, 400, "invalid version, request ID or method")
		return
	}
	input, fingerprint, err := prepareProviderRequest(s.policy, s.maxBodySize, input)
	if err != nil {
		s.providerValidationError(w, err, false)
		return
	}
	record, created, err := s.jobs.Submit(r.Context(), input, fingerprint)
	if err != nil {
		s.submissionError(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusAccepted
	}
	writeJSON(w, status, record)
}

func (s *Server) submissionError(w http.ResponseWriter, err error) {
	var reconstruction *reconstructError
	switch {
	case errors.Is(err, errForwardingDisabled):
		writeError(w, 503, err.Error())
	case errors.Is(err, errJobLimit):
		w.Header().Set("Retry-After", "1")
		writeError(w, 503, err.Error())
	case errors.Is(err, errShuttingDown):
		writeError(w, 503, err.Error())
	case errors.Is(err, errDifferentContent):
		writeCode(w, 409, "request_conflict", err.Error())
	case errors.As(err, &reconstruction):
		switch {
		case errors.Is(reconstruction.cause, store.ErrUnavailableChunk):
			writeCode(w, 409, "missing_chunks", "chunks missing or corrupt; synchronize again")
		case errors.Is(reconstruction.cause, store.ErrIntegrity):
			writeError(w, 422, "reconstructed body SHA-256 mismatch")
		default:
			writeError(w, 500, "cannot reconstruct request")
		}
	default:
		s.mailboxError(w, err)
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
	if !s.jobs.Enabled() || !protocol.ValidRequestID(id) {
		writeError(w, 400, "forwarding disabled or invalid request ID")
		return
	}
	record, err := s.jobs.Cancel(id)
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
