package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

// forward keeps the legacy response lifetime tied to the requesting client. It
// shares validation, header normalization, and claim fingerprints with durable
// submission but deliberately does not use the durable background job service.
func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	if !s.jobs.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "provider forwarding is not configured")
		return
	}
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "application/json required")
		return
	}
	var input protocol.ForwardRequest
	switch decodeBoundedJSON(w, r, protocol.MaxManifestBytes, &input) {
	case decodeEncoding:
		writeError(w, http.StatusBadRequest, "invalid forwarding encoding")
		return
	case decodeTooLarge:
		writeError(w, http.StatusRequestEntityTooLarge, "invalid or oversized forwarding metadata")
		return
	case decodeSyntax:
		writeError(w, http.StatusBadRequest, "invalid forwarding metadata")
		return
	case decodeTrailing:
		writeError(w, http.StatusBadRequest, "expected one forwarding object")
		return
	}
	if !validProviderEnvelope(input, protocol.Version, "") {
		writeError(w, http.StatusBadRequest, "invalid version, method, or request ID")
		return
	}
	input, fingerprint, err := prepareProviderRequest(s.policy, s.maxBodySize, input)
	if err != nil {
		s.providerValidationError(w, err, true)
		return
	}
	body, err := s.store.Reconstruct(r.Context(), input.Manifest)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrUnavailableChunk):
			writeError(w, http.StatusConflict, "chunks missing or corrupt; synchronize again")
		case errors.Is(err, store.ErrIntegrity):
			writeError(w, http.StatusUnprocessableEntity, "reconstructed body SHA-256 mismatch")
		default:
			writeError(w, http.StatusInternalServerError, "cannot reconstruct forwarding body")
		}
		return
	}
	defer body.Close()
	if r.Context().Err() != nil {
		return
	}
	if err := s.jobs.Claim(input.ID, fingerprint); err != nil {
		switch {
		case errors.Is(err, journal.ErrUsed):
			writeError(w, http.StatusConflict, err.Error())
		case errors.Is(err, journal.ErrFull):
			writeError(w, http.StatusInsufficientStorage, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "cannot persist request claim; provider was not called")
		}
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, input.Method, input.Target, body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid upstream request")
		return
	}
	request.Header = input.Headers
	request.ContentLength = input.Manifest.Size
	response, err := s.jobs.upstream.Do(request)
	if err != nil {
		if ctx.Err() == nil {
			writeError(w, http.StatusBadGateway, "provider connection failed; request may have been sent; automatic replay refused")
		}
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		writeError(w, http.StatusBadGateway, "provider redirect refused; no direct-provider fallback")
		return
	}
	timer := time.AfterFunc(s.jobs.idleTimeout, cancel)
	defer timer.Stop()
	response.Body = &activityBody{ReadCloser: response.Body, timer: timer, idle: s.jobs.idleTimeout}
	w.Header().Set("X-DeltaRelay-Upstream", "1")
	w.Header().Set("X-DeltaRelay-Body-Hash", input.Manifest.Hash)
	w.Header().Set("X-DeltaRelay-Request-ID", input.ID)
	if _, err := upstream.CopyResponse(w, response); err != nil {
		panic(http.ErrAbortHandler)
	}
}

type activityBody struct {
	io.ReadCloser
	timer *time.Timer
	idle  time.Duration
}

func (r *activityBody) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.timer.Reset(r.idle)
	}
	return n, err
}
