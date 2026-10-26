// Package gateway is the authenticated loopback HTTP endpoint used by OpenCode.
package gateway

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/upstream"
)

type Config struct {
	Client                *client.Client
	LocalToken            string
	Upstreams             []upstream.Rule
	AllowPrivateUpstreams bool
	MaxBodySize           int64
	MaxConcurrent         int
	RequestTimeout        time.Duration
	OnResult              func(Result)
	OnStart               func(string)
}

type Result struct {
	ID             string       `json:"request_id"`
	Upstream       string       `json:"upstream"`
	Status         int          `json:"status"`
	Stats          client.Stats `json:"transfer"`
	ResponseBytes  int64        `json:"response_bytes"`
	DurationMillis int64        `json:"duration_ms"`
	Failed         bool         `json:"failed"`
	ErrorCode      string       `json:"error_code,omitempty"`
}

type Gateway struct {
	config                                                                          Config
	tokenHash                                                                       [32]byte
	policy                                                                          *upstream.Policy
	mux                                                                             *http.ServeMux
	slots                                                                           chan struct{}
	requests, active, failed, bodyBytes, uploadedBytes, encodedBytes, responseBytes atomic.Int64
}

func New(config Config) (*Gateway, error) {
	if config.Client == nil || config.LocalToken == "" {
		return nil, errors.New("client and local authentication token are required")
	}
	if config.MaxBodySize == 0 {
		config.MaxBodySize = protocol.DefaultMaxBodySize
	}
	if config.MaxBodySize < 1 || config.MaxBodySize > protocol.DefaultMaxBodySize {
		return nil, errors.New("invalid gateway body limit")
	}
	if config.MaxConcurrent == 0 {
		config.MaxConcurrent = 8
	}
	if config.MaxConcurrent < 1 || config.MaxConcurrent > 64 || config.RequestTimeout < 0 {
		return nil, errors.New("invalid gateway concurrency or timeout")
	}
	policy, err := upstream.NewPolicy(config.Upstreams, config.AllowPrivateUpstreams)
	if err != nil {
		return nil, err
	}
	if !policy.Enabled() {
		return nil, errors.New("gateway requires an explicit upstream allowlist")
	}
	g := &Gateway{config: config, policy: policy, tokenHash: sha256.Sum256([]byte(config.LocalToken)), mux: http.NewServeMux(), slots: make(chan struct{}, config.MaxConcurrent)}
	g.mux.HandleFunc("POST /v1/proxy", g.proxy)
	g.mux.HandleFunc("GET /healthz", g.health)
	g.mux.HandleFunc("GET /metrics", g.metrics)
	return g, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	hash := sha256.Sum256([]byte(r.Header.Get("X-DeltaRelay-Local-Token")))
	if subtle.ConstantTimeCompare(hash[:], g.tokenHash[:]) != 1 {
		gatewayError(w, http.StatusUnauthorized, "local gateway authentication failed")
		return
	}
	if r.Header.Get("Origin") != "" {
		gatewayError(w, http.StatusForbidden, "browser-origin requests are not accepted")
		return
	}
	g.mux.ServeHTTP(w, r)
}

func (g *Gateway) proxy(w http.ResponseWriter, r *http.Request) {
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	case <-r.Context().Done():
		return
	}
	started := time.Now()
	g.requests.Add(1)
	g.active.Add(1)
	result := Result{Status: http.StatusBadGateway, Failed: true}
	defer func() {
		g.active.Add(-1)
		if result.Failed {
			g.failed.Add(1)
		}
		g.bodyBytes.Add(result.Stats.BodyBytes)
		g.uploadedBytes.Add(result.Stats.UploadedChunkBytes)
		g.encodedBytes.Add(result.Stats.RequestBodyBytesSent)
		g.responseBytes.Add(result.ResponseBytes)
		result.DurationMillis = time.Since(started).Milliseconds()
		if g.config.OnResult != nil {
			g.config.OnResult(result)
		}
	}()
	target := r.Header.Get("X-DeltaRelay-Target")
	if len(target) > 8192 {
		result.Status = http.StatusBadRequest
		gatewayError(w, result.Status, "target URL exceeds limit")
		return
	}
	rule, err := g.policy.Match(target)
	if err != nil {
		result.Status = http.StatusForbidden
		gatewayError(w, result.Status, err.Error())
		return
	}
	result.Upstream = rule.Name
	id := r.Header.Get("X-DeltaRelay-Request-ID")
	if id == "" {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			gatewayError(w, result.Status, "cannot create request ID")
			return
		}
		id = hex.EncodeToString(random[:])
	}
	if !upstream.ValidRequestID(id) {
		result.Status = http.StatusBadRequest
		gatewayError(w, result.Status, "invalid request ID")
		return
	}
	result.ID = id
	w.Header().Set("X-DeltaRelay-Request-ID", id)
	if g.config.OnStart != nil {
		g.config.OnStart(id)
	}
	if err := upstream.ValidateHeaders(r.Header); err != nil {
		result.Status = http.StatusBadRequest
		gatewayError(w, result.Status, err.Error())
		return
	}
	ctx := r.Context()
	if g.config.RequestTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, g.config.RequestTimeout)
		defer cancel()
	}
	r.Body = http.MaxBytesReader(w, r.Body, g.config.MaxBodySize+(64<<10))
	var body io.Reader = r.Body
	switch r.Header.Get("Content-Encoding") {
	case "", "identity":
	case "gzip":
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			result.Status = http.StatusBadRequest
			gatewayError(w, result.Status, "invalid gzip request")
			return
		}
		defer gz.Close()
		body = gz
	default:
		result.Status = http.StatusUnsupportedMediaType
		gatewayError(w, result.Status, "disable provider request encoding; gateway accepts plain content or gzip, not zstd")
		return
	}
	headers := upstream.CleanHeaders(r.Header)
	headers.Del("Content-Encoding")
	response, stats, err := g.config.Client.Forward(ctx, client.Request{ID: id, Target: target, Method: r.Method, Headers: headers}, body)
	result.Stats = stats
	if err != nil {
		if ctx.Err() != nil {
			result.Status = 499
			return
		}
		if errors.Is(err, client.ErrUploadBudget) {
			result.Status = http.StatusConflict
			result.ErrorCode = "upload_budget"
			gatewayError(w, result.Status, "upload budget exceeded; no provider request was sent; approve initial synchronization or increase the missing-byte budget")
			return
		}
		if errors.Is(err, client.ErrBodyLimit) {
			result.Status = http.StatusBadRequest
			result.ErrorCode = "body_limit"
			gatewayError(w, result.Status, "request exceeds DeltaRelay body limit; no provider request was sent")
			return
		}
		var transport *client.TransportError
		if errors.As(err, &transport) {
			result.Status = http.StatusServiceUnavailable
			result.ErrorCode = "relay_unreachable"
			if transport.MayHaveDispatched {
				gatewayError(w, result.Status, "DeltaRelay exhausted its VPS recovery window; the provider may already have received this request. Recover the saved response using this request ID before sending a new message. No direct-provider fallback")
			} else {
				gatewayError(w, result.Status, "DeltaRelay cannot reach its VPS (VPN, network, or SSH tunnel). No provider request was sent; restore the connection, then resend. No direct-provider fallback")
			}
			return
		}
		result.ErrorCode = "relay_failure"
		var httpErr *client.HTTPError
		if errors.As(err, &httpErr) && (httpErr.Status == http.StatusConflict || httpErr.Status == http.StatusInsufficientStorage || httpErr.Status == http.StatusForbidden) {
			result.Status = httpErr.Status
			if httpErr.Code == "state_mismatch" {
				result.ErrorCode = "relay_state_changed"
			}
		}
		var requestErr *client.RequestError
		if errors.As(err, &requestErr) {
			result.ErrorCode = requestErr.Code
		}
		// Details are intentionally generic: never log or reflect request URLs,
		// provider headers, transport credentials, or potentially secret queries.
		gatewayError(w, result.Status, "delta transfer or forwarding failed; inspect gateway health, upload budget, and VPS configuration; no direct fallback")
		return
	}
	defer response.Body.Close()
	result.Status = response.StatusCode
	w.Header().Set("X-DeltaRelay-Request-ID", id)
	w.Header().Set("X-DeltaRelay-Body-Hash", stats.Hash)
	w.Header().Set("X-DeltaRelay-Body-Bytes", strconv.FormatInt(stats.BodyBytes, 10))
	w.Header().Set("X-DeltaRelay-Uploaded-Bytes", strconv.FormatInt(stats.UploadedChunkBytes, 10))
	w.Header().Set("X-DeltaRelay-Encoded-Upload-Bytes", strconv.FormatInt(stats.RequestBodyBytesSent, 10))
	result.ResponseBytes, err = upstream.CopyResponse(w, response)
	result.Failed = err != nil || response.StatusCode >= 400
	if err != nil {
		result.ErrorCode = "response_transfer_interrupted"
		panic(http.ErrAbortHandler)
	}
}

func (g *Gateway) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	health, err := g.config.Client.Health(ctx)
	if err != nil || !health.Forwarding {
		gatewayError(w, http.StatusServiceUnavailable, "VPS unavailable, incompatible, or forwarding disabled")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ready": true, "version": protocol.RelayVersion, "vps": health})
}

func (g *Gateway) metrics(w http.ResponseWriter, r *http.Request) {
	pending, controlError := g.config.Client.ControlStatus()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"requests": g.requests.Load(), "active": g.active.Load(), "failed": g.failed.Load(),
		"body_bytes": g.bodyBytes.Load(), "uploaded_chunk_bytes": g.uploadedBytes.Load(),
		"encoded_upload_bytes": g.encodedBytes.Load(), "response_bytes": g.responseBytes.Load(),
		"pending_cancellations": int64(pending),
		"control_error":         controlError,
	})
}

func gatewayError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"type": "deltarelay", "message": message}})
}
