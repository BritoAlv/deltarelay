// Package server implements the authenticated VPS-side delta protocol.
// Forwarding is disabled unless explicit upstream allowlist rules are supplied.
package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

type Config struct {
	Store                   *store.Store
	Token                   string
	MaxBodySize             int64
	MaxConcurrent           int
	Upstreams               []upstream.Rule
	AllowPrivateUpstreams   bool
	HeaderTimeout           time.Duration
	IdleTimeout             time.Duration
	MaxJournalRecords       int
	Context                 context.Context
	ResponseRetention       time.Duration
	MaxResponseBytes        int64
	MaxResponseStorageBytes int64
	MaxRuntime              time.Duration
}

type Server struct {
	store             *store.Store
	tokenHash         [32]byte
	maxBodySize       int64
	slots             chan struct{}
	mux               *http.ServeMux
	policy            *upstream.Policy
	responseSlots     chan struct{}
	mailbox           *mailbox.Mailbox
	maxJournalRecords int
	jobs              *jobService
}

func New(config Config) (*Server, error) {
	if config.Store == nil || config.Token == "" {
		return nil, errors.New("store and authentication token are required")
	}
	if config.MaxBodySize == 0 {
		config.MaxBodySize = protocol.DefaultMaxBodySize
	}
	if config.MaxBodySize < 0 || config.MaxBodySize > protocol.DefaultMaxBodySize {
		return nil, errors.New("maximum body size must be between 1 and 256 MiB")
	}
	if config.MaxConcurrent == 0 {
		config.MaxConcurrent = 8
	}
	if config.MaxConcurrent < 1 || config.MaxConcurrent > 64 {
		return nil, errors.New("maximum concurrency must be between 1 and 64")
	}
	policy, err := upstream.NewPolicy(config.Upstreams, config.AllowPrivateUpstreams)
	if err != nil {
		return nil, err
	}
	if config.HeaderTimeout == 0 {
		config.HeaderTimeout = 5 * time.Minute
	}
	if config.IdleTimeout == 0 {
		config.IdleTimeout = 15 * time.Minute
	}
	if config.HeaderTimeout < 0 || config.IdleTimeout < 0 {
		return nil, errors.New("timeouts must be positive")
	}
	if config.MaxJournalRecords == 0 {
		config.MaxJournalRecords = 100000
	}
	if config.MaxRuntime == 0 {
		config.MaxRuntime = 2 * time.Hour
	}
	if config.MaxRuntime <= 0 || config.MaxJournalRecords < 1 {
		return nil, errors.New("invalid runtime or journal limit")
	}
	if config.Context == nil {
		config.Context = context.Background()
	}
	box, err := mailbox.Open(filepath.Join(config.Store.Directory(), "mailbox"), mailbox.Config{
		Retention: config.ResponseRetention, MaxBytes: config.MaxResponseStorageBytes, MaxResponseBytes: config.MaxResponseBytes, MaxRecords: config.MaxJournalRecords,
	})
	if err != nil {
		return nil, err
	}
	var requests *journal.Journal
	if policy.Enabled() {
		requests, err = journal.Open(filepath.Join(config.Store.Directory(), "requests"), config.MaxJournalRecords)
		if err != nil {
			return nil, err
		}
	}
	s := &Server{
		store: config.Store, tokenHash: sha256.Sum256([]byte(config.Token)),
		maxBodySize: config.MaxBodySize, slots: make(chan struct{}, config.MaxConcurrent),
		mux:    http.NewServeMux(),
		policy: policy, responseSlots: make(chan struct{}, config.MaxConcurrent*4),
		mailbox: box, maxJournalRecords: config.MaxJournalRecords,
	}
	s.jobs = newJobService(jobServiceConfig{
		Store: config.Store, Mailbox: box, Journal: requests, Policy: policy,
		Upstream: policy.HTTPClient(config.HeaderTimeout), MaxConcurrent: config.MaxConcurrent,
		MaxRuntime: config.MaxRuntime, IdleTimeout: config.IdleTimeout, Context: config.Context,
	})
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		used, limit := s.store.Usage()
		writeJSON(w, http.StatusOK, map[string]any{"version": protocol.Version, "forwarding": policy.Enabled(), "cache_bytes": used, "max_cache_bytes": limit})
	})
	s.mux.HandleFunc("POST /v1/missing", s.missing)
	s.mux.HandleFunc("POST /v1/chunks", s.upload)
	s.mux.HandleFunc("POST /v1/assemble", s.assemble)
	s.mux.HandleFunc("GET /v1/bodies/{hash}", s.body)
	s.mux.HandleFunc("POST /v1/forward", s.forward)
	s.mux.HandleFunc("GET /v2/info", s.info)
	s.mux.HandleFunc("POST /v2/missing", s.missing)
	s.mux.HandleFunc("POST /v2/chunks", s.upload)
	s.mux.HandleFunc("POST /v2/assemble", s.assemble)
	s.mux.HandleFunc("GET /v2/bodies/{hash}", s.body)
	s.mux.HandleFunc("PUT /v2/requests/{id}", s.submit)
	s.mux.HandleFunc("GET /v2/requests/{id}", s.requestStatus)
	s.mux.HandleFunc("GET /v2/requests/{id}/response", s.requestResponse)
	s.mux.HandleFunc("POST /v2/requests/{id}/ack", s.acknowledge)
	s.mux.HandleFunc("POST /v2/requests/{id}/cancel", s.cancelRequest)
	return s, nil
}

// Close cancels running provider jobs and waits for their terminal records.
func (s *Server) Close() {
	s.jobs.Close()
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	provided := r.Header.Get("Authorization")
	if !strings.HasPrefix(provided, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "bearer token required")
		return
	}
	hash := sha256.Sum256([]byte(strings.TrimPrefix(provided, "Bearer ")))
	if subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid bearer token")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v2/") && r.URL.Path != "/v2/info" {
		if r.Header.Get("X-DeltaRelay-State-ID") != s.mailbox.StateID() {
			writeCode(w, http.StatusConflict, "state_mismatch", "relay state identity changed or was not supplied; automatic dispatch refused")
			return
		}
	}
	slots := s.slots
	if r.URL.Path == "/v1/forward" {
		slots = s.jobs.slots
	} else if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v2/requests/") {
		slots = s.responseSlots
	}
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusServiceUnavailable, "server concurrency limit reached")
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) manifest(w http.ResponseWriter, r *http.Request) (protocol.Manifest, bool) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "application/json required")
		return protocol.Manifest{}, false
	}
	reader, closeBody, err := decodedBody(w, r, protocol.MaxManifestBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid content encoding")
		return protocol.Manifest{}, false
	}
	defer closeBody()
	data, err := io.ReadAll(reader)
	if err != nil || len(data) > protocol.MaxManifestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "invalid or oversized manifest body")
		return protocol.Manifest{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest protocol.Manifest
	if err := decoder.Decode(&manifest); err != nil {
		writeError(w, http.StatusBadRequest, "invalid manifest JSON")
		return protocol.Manifest{}, false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeError(w, http.StatusBadRequest, "manifest must contain one JSON object")
		return protocol.Manifest{}, false
	}
	if err := manifest.Validate(s.maxBodySize, protocol.DefaultMaxChunks); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return protocol.Manifest{}, false
	}
	return manifest, true
}

func (s *Server) missing(w http.ResponseWriter, r *http.Request) {
	manifest, ok := s.manifest(w, r)
	if !ok {
		return
	}
	missing := make([]protocol.Chunk, 0)
	seen := make(map[string]bool, len(manifest.Chunks))
	for _, chunk := range manifest.Chunks {
		if r.Context().Err() != nil {
			return
		}
		if !seen[chunk.Hash] {
			seen[chunk.Hash] = true
			if !s.store.HasChunk(chunk) {
				missing = append(missing, chunk)
			}
		}
	}
	writeJSON(w, http.StatusOK, protocol.MissingResponse{Missing: missing})
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Content-Type") != protocol.BatchContentType {
		writeError(w, http.StatusUnsupportedMediaType, "chunk batch content type required")
		return
	}
	reader, closeBody, err := decodedBody(w, r, protocol.MaxUploadBatchBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid content encoding")
		return
	}
	defer closeBody()
	count, err := protocol.ReadBatchHeader(reader)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid or truncated batch header")
		return
	}
	var total int64
	framedSize := int64(protocol.BatchHeaderSize)
	for i := 0; i < count; i++ {
		if r.Context().Err() != nil {
			return
		}
		chunk, data, err := protocol.ReadChunk(reader)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid or truncated chunk frame")
			return
		}
		framedSize += protocol.ChunkHeaderSize + chunk.Size
		if framedSize > protocol.MaxUploadBatchBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "upload batch too large")
			return
		}
		if err := s.store.PutChunk(chunk, data); err != nil {
			if errors.Is(err, store.ErrIntegrity) {
				writeError(w, http.StatusUnprocessableEntity, "chunk SHA-256 mismatch")
			} else if errors.Is(err, store.ErrQuota) {
				writeError(w, http.StatusInsufficientStorage, "cache byte limit reached; no automatic eviction")
			} else {
				writeError(w, http.StatusInternalServerError, "cannot persist chunk")
			}
			return
		}
		total += chunk.Size
	}
	// Consume EOF to reject trailing frames, oversized decoded bodies, truncated
	// gzip trailers, and invalid gzip checksums before acknowledging the batch.
	var extra [1]byte
	n, err := io.ReadFull(reader, extra[:])
	if n != 0 || err != io.EOF {
		writeError(w, http.StatusBadRequest, "trailing or invalid batch data")
		return
	}
	writeJSON(w, http.StatusOK, protocol.UploadResponse{Chunks: count, Bytes: total})
}

func (s *Server) assemble(w http.ResponseWriter, r *http.Request) {
	manifest, ok := s.manifest(w, r)
	if !ok {
		return
	}
	if err := s.store.AssembleContext(r.Context(), manifest); err != nil {
		switch {
		case r.Context().Err() != nil:
			return
		case errors.Is(err, store.ErrUnavailableChunk):
			writeError(w, http.StatusConflict, "chunks missing or corrupt; synchronize again")
		case errors.Is(err, store.ErrIntegrity):
			writeError(w, http.StatusUnprocessableEntity, "reconstructed body SHA-256 mismatch")
		case errors.Is(err, store.ErrQuota):
			writeError(w, http.StatusInsufficientStorage, "cache byte limit reached; no automatic eviction")
		default:
			writeError(w, http.StatusInternalServerError, "cannot persist reconstructed body")
		}
		return
	}
	writeJSON(w, http.StatusOK, protocol.AssembleResponse{Hash: manifest.Hash, Size: manifest.Size})
}

func (s *Server) body(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	if !protocol.ValidHash(hash) {
		writeError(w, http.StatusBadRequest, "invalid body SHA-256")
		return
	}
	f, size, err := s.store.OpenBody(hash)
	if err != nil {
		switch {
		case errors.Is(err, os.ErrNotExist):
			writeError(w, http.StatusNotFound, "body not found")
		case errors.Is(err, store.ErrIntegrity):
			writeError(w, http.StatusConflict, "stored body failed verification")
		default:
			writeError(w, http.StatusInternalServerError, "cannot read stored body")
		}
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", fmt.Sprintf("\"%s\"", hash))
	w.Header().Set("X-DeltaRelay-Body-Size", strconv.FormatInt(size, 10))
	http.ServeContent(w, r, hash, time.Time{}, f)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, protocol.ErrorResponse{Error: message})
}

func writeCode(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, protocol.ErrorResponse{Error: message, Code: code})
}
