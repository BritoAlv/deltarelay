package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"deltarelay/internal/protocol"
	"deltarelay/internal/upstream"
)

type Request struct {
	ID      string
	Target  string
	Method  string
	Headers http.Header
}

type RequestError struct{ ID, State, Code string }

func (e *RequestError) Error() string {
	return fmt.Sprintf("relay request %s is %s (%s); generation was not replayed", e.ID, e.State, e.Code)
}

// Forward submits a durable operation, then exposes an opaque provider response.
// The local stream stays open across PC-to-VPS outages. The caller must close
// Body and keep ctx alive. Successful streaming does NOT acknowledge durable
// local storage: responses remain on the VPS until explicit ACK or expiry.
func (c *Client) Forward(ctx context.Context, request Request, body io.Reader) (*http.Response, Stats, error) {
	if !protocol.ValidRequestID(request.ID) || request.Method != http.MethodPost {
		return nil, Stats{}, errors.New("invalid forwarding request ID or method")
	}
	if err := upstream.ValidateHeaders(request.Headers); err != nil {
		return nil, Stats{}, err
	}
	started := time.Now()
	stats, manifest, err := c.sync(ctx, body, false)
	if err != nil {
		return nil, stats, err
	}
	data, err := json.Marshal(protocol.ForwardRequest{Version: protocol.RelayVersion, ID: request.ID, Target: request.Target, Method: request.Method, Headers: request.Headers, Manifest: manifest})
	if err != nil {
		return nil, stats, err
	}
	if len(data) > protocol.MaxManifestBytes {
		return nil, stats, errors.New("forwarding metadata exceeds protocol limit")
	}
	var sent, requests atomic.Int64
	var record protocol.RequestStatus
	err = c.jsonRPC(ctx, http.MethodPut, "/v2/requests/"+request.ID, data, &record, &sent, &requests)
	stats.RequestBodyBytesSent += sent.Load()
	stats.Requests += requests.Load()
	stats.DurationMillis = time.Since(started).Milliseconds()
	if err != nil {
		if ctx.Err() != nil {
			_ = c.QueueCancel(request.ID)
		}
		var transport *TransportError
		if errors.As(err, &transport) {
			transport.MayHaveDispatched = true
		}
		return nil, stats, err
	}
	if err := c.validateStatus(record, request.ID, manifest.Hash); err != nil {
		return nil, stats, err
	}
	response, err := c.resume(ctx, request.ID, manifest.Hash, 0, nil, true)
	if err != nil && ctx.Err() != nil {
		_ = c.QueueCancel(request.ID)
	}
	return response, stats, err
}

func (c *Client) ensureState(ctx context.Context) error {
	c.stateMu.Lock()
	known := c.stateID != ""
	c.stateMu.Unlock()
	if !known {
		_, err := c.Info(ctx)
		return err
	}
	return nil
}

func (c *Client) validateStatus(r protocol.RequestStatus, id, bodyHash string) error {
	c.stateMu.Lock()
	stateID := c.stateID
	c.stateMu.Unlock()
	if r.ID != id || r.StateID != stateID || (bodyHash != "" && r.BodyHash != bodyHash) || r.Bytes < 0 {
		return errors.New("request acknowledgment does not match ID, relay state or original body")
	}
	switch r.State {
	case protocol.Accepted, protocol.Running, protocol.Completed, protocol.Failed, protocol.Cancelled, protocol.Interrupted:
	default:
		return errors.New("unknown request state")
	}
	if r.State == protocol.Completed && (!protocol.ValidHash(r.Hash) || r.Status < 200 || r.Status > 599) {
		return errors.New("invalid completed-response metadata")
	}
	return nil
}

func (c *Client) Status(ctx context.Context, id string) (protocol.RequestStatus, error) {
	return c.status(ctx, id, false)
}
func (c *Client) status(ctx context.Context, id string, wait bool) (protocol.RequestStatus, error) {
	var record protocol.RequestStatus
	if !protocol.ValidRequestID(id) {
		return record, errors.New("invalid request ID")
	}
	if err := c.ensureState(ctx); err != nil {
		return record, err
	}
	path := "/v2/requests/" + id
	if wait {
		path += "?wait=1"
	}
	if err := c.jsonRPC(ctx, http.MethodGet, path, nil, &record, nil, nil); err != nil {
		return record, err
	}
	return record, c.validateStatus(record, id, "")
}

// Resume only reads an existing operation. A missing ID is never submitted.
func (c *Client) Resume(ctx context.Context, id string) (*http.Response, error) {
	return c.resume(ctx, id, "", 0, nil, false)
}

func (c *Client) resume(ctx context.Context, id, bodyHash string, offset int64, digest hash.Hash, cancelRemote bool) (*http.Response, error) {
	for {
		record, err := c.status(ctx, id, true)
		if err != nil {
			return nil, err
		}
		if err := c.validateStatus(record, id, bodyHash); err != nil {
			return nil, err
		}
		if record.Acknowledged || record.Expired {
			return nil, &HTTPError{Status: 410, Code: "response_gone", Detail: "saved response acknowledged or expired"}
		}
		if protocol.Terminal(record.State) && record.State != protocol.Completed {
			return nil, &RequestError{ID: id, State: record.State, Code: record.ErrorCode}
		}
		if record.Status == 0 {
			if protocol.Terminal(record.State) {
				return nil, &RequestError{ID: id, State: record.State, Code: record.ErrorCode}
			}
			continue
		}
		if record.Status < 200 || record.Status > 599 || offset > record.Bytes || upstream.ValidateHeaders(record.Headers) != nil {
			return nil, errors.New("invalid response metadata or resume offset")
		}
		if digest == nil {
			digest = sha256.New()
		}
		bodyCtx, cancel := context.WithCancel(ctx)
		b := &resumableBody{client: c, ctx: bodyCtx, cancel: cancel, id: id, bodyHash: record.BodyHash, offset: offset, digest: digest, done: make(chan struct{}), cancelRemote: cancelRemote}
		go func() {
			select {
			case <-ctx.Done():
				if cancelRemote && !b.complete.Load() {
					_ = c.QueueCancel(id)
				}
				cancel()
			case <-b.done:
			}
		}()
		headers := record.Headers.Clone()
		headers.Set("X-DeltaRelay-Upstream", "1")
		headers.Set("X-DeltaRelay-Body-Hash", record.BodyHash)
		headers.Set("X-DeltaRelay-Request-ID", id)
		return &http.Response{StatusCode: record.Status, Status: http.StatusText(record.Status), Header: headers, Body: b, ContentLength: -1}, nil
	}
}

type resumableBody struct {
	client           *Client
	ctx              context.Context
	cancel           context.CancelFunc
	id, bodyHash     string
	offset           int64
	digest           hash.Hash
	buffer           []byte
	complete, failed atomic.Bool
	closeOnce        sync.Once
	done             chan struct{}
	cancelRemote     bool
}

func (b *resumableBody) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for {
		if err := b.ctx.Err(); err != nil { b.failed.Store(true); return 0,err }
		if len(b.buffer) != 0 {
			n := copy(p, b.buffer)
			b.buffer = b.buffer[n:]
			b.offset += int64(n)
			_, _ = b.digest.Write(p[:n])
			return n, nil
		}
		if b.complete.Load() {
			return 0, io.EOF
		}
		if b.failed.Load() {
			return 0, errors.New("response stream already failed")
		}
		var response *http.Response
		var data []byte
		err := b.client.retry(b.ctx, func() error {
			var err error
			response, data, err = b.client.rpc(b.ctx, http.MethodGet, "/v2/requests/"+b.id+"/response?offset="+strconv.FormatInt(b.offset, 10), nil, nil, protocol.ResponseSegmentBytes, nil, nil)
			return err
		})
		if err != nil {
			b.failed.Store(true)
			return 0, err
		}
		if response.StatusCode == http.StatusNoContent {
			continue
		}
		b.client.stateMu.Lock()
		stateID := b.client.stateID
		b.client.stateMu.Unlock()
		if response.Header.Get("X-DeltaRelay-State-ID") != stateID || response.Header.Get("X-DeltaRelay-Request-ID") != b.id || response.Header.Get("X-DeltaRelay-Offset") != strconv.FormatInt(b.offset, 10) || response.Header.Get("X-DeltaRelay-Segment-Hash") != protocol.Sum(data) {
			b.failed.Store(true)
			return 0, errors.New("response segment identity, offset or checksum mismatch")
		}
		if len(data) != 0 {
			b.buffer = data
			continue
		}
		record, err := b.client.Status(b.ctx, b.id)
		if err != nil {
			b.failed.Store(true)
			return 0, err
		}
		if err := b.client.validateStatus(record, b.id, b.bodyHash); err != nil {
			b.failed.Store(true)
			return 0, err
		}
		if record.State != protocol.Completed {
			b.failed.Store(true)
			return 0, &RequestError{ID: b.id, State: record.State, Code: record.ErrorCode}
		}
		if record.Bytes != b.offset || record.Hash != hex.EncodeToString(b.digest.Sum(nil)) {
			b.failed.Store(true)
			return 0, errors.New("complete response length or SHA-256 mismatch")
		}
		b.complete.Store(true)
		return 0, io.EOF
	}
}

func (b *resumableBody) Close() error {
	b.closeOnce.Do(func() {
		close(b.done)
		if b.cancelRemote && !b.complete.Load() && (!b.failed.Load() || b.ctx.Err() != nil) {
			_ = b.client.QueueCancel(b.id)
		}
		b.cancel()
	})
	return nil
}

func (c *Client) Ack(ctx context.Context, id string, receipt protocol.Receipt) error {
	if !protocol.ValidRequestID(id) || !protocol.ValidHash(receipt.Hash) || receipt.Size < 0 {
		return errors.New("invalid request ID or receipt")
	}
	if err := c.ensureState(ctx); err != nil {
		return err
	}
	data, _ := json.Marshal(receipt)
	var status protocol.RequestStatus
	if err := c.jsonRPC(ctx, http.MethodPost, "/v2/requests/"+id+"/ack", data, &status, nil, nil); err != nil {
		return err
	}
	return c.validateStatus(status, id, "")
}

func (c *Client) Cancel(ctx context.Context, id string) error {
	if err := c.ensureState(ctx); err != nil {
		return err
	}
	if err := c.QueueCancel(id); err != nil {
		return err
	}
	// The persistent worker owns retries. Callers can inspect pending controls.
	return nil
}

type Health struct {
	Version                 int    `json:"version"`
	StateID                 string `json:"state_id"`
	Forwarding              bool   `json:"forwarding"`
	CacheBytes              int64  `json:"cache_bytes"`
	MaxCacheBytes           int64  `json:"max_cache_bytes"`
	ResponseStorageBytes    int64  `json:"response_storage_bytes"`
	MaxResponseStorageBytes int64  `json:"max_response_storage_bytes"`
	PendingCancellations    int    `json:"pending_cancellations"`
	ControlError            string `json:"control_error,omitempty"`
}

func (c *Client) Health(ctx context.Context) (Health, error) {
	info, err := c.Info(ctx)
	pending, controlError := c.ControlStatus()
	return Health{Version: info.Version, StateID: info.StateID, Forwarding: info.Forwarding, CacheBytes: info.CacheBytes, MaxCacheBytes: info.MaxCacheBytes,
		ResponseStorageBytes: info.ResponseStorageBytes, MaxResponseStorageBytes: info.MaxResponseStorageBytes, PendingCancellations: pending, ControlError: controlError}, err
}
