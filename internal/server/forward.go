package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	if !s.policy.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "provider forwarding is not configured")
		return
	}
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "application/json required")
		return
	}
	reader, closeBody, err := decodedBody(w, r, protocol.MaxManifestBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid forwarding encoding")
		return
	}
	defer closeBody()
	data, err := io.ReadAll(reader)
	if err != nil || len(data) > protocol.MaxManifestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "invalid or oversized forwarding metadata")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input protocol.ForwardRequest
	if decoder.Decode(&input) != nil {
		writeError(w, http.StatusBadRequest, "invalid forwarding metadata")
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		writeError(w, http.StatusBadRequest, "expected one forwarding object")
		return
	}
	if input.Version != protocol.Version || input.Method != http.MethodPost || !protocol.ValidRequestID(input.ID) {
		writeError(w, http.StatusBadRequest, "invalid version, method, or request ID")
		return
	}
	if err := input.Manifest.Validate(s.maxBodySize, protocol.DefaultMaxChunks); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := upstream.ValidateHeaders(input.Headers); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := s.policy.Match(input.Target); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	input.Headers = upstream.CleanHeaders(input.Headers)
	if encoding := input.Headers.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		writeError(w, http.StatusBadRequest, "forwarding requires decoded content")
		return
	}
	input.Headers.Del("Content-Encoding")
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
	fingerprint, _ := json.Marshal(struct {
		Target  string
		Headers http.Header
		Hash    string
		Size    int64
	}{input.Target, input.Headers, input.Manifest.Hash, input.Manifest.Size})
	if err := s.journal.Claim(input.ID, protocol.Sum(fingerprint)); err != nil {
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
	response, err := s.upstream.Do(request)
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
	timer := time.AfterFunc(s.idleTimeout, cancel)
	defer timer.Stop()
	response.Body = &activityBody{ReadCloser: response.Body, timer: timer, idle: s.idleTimeout}
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
