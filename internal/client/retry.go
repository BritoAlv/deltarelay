package client

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"deltarelay/internal/protocol"
)

// retry applies only to reads or operations whose idempotency is enforced by
// this protocol. It must never wrap a provider HTTP request or legacy forward.
func (c *Client) retry(ctx context.Context, operation func() error) error {
	var deadline time.Time
	delay := c.config.RetryMin
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := operation()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if c.config.NoRetry || !retryable(err) {
			return err
		}
		if deadline.IsZero() {
			deadline = time.Now().Add(c.config.RetryWindow)
		}
		wait := delay/2 + time.Duration(rand.Int64N(max(1, int64(delay/2))))
		var status *HTTPError
		if errors.As(err, &status) {
			wait = max(wait, status.RetryAfter)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return err
		}
		if wait > remaining {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if !time.Now().Before(deadline) {
			return err
		}
		c.http.CloseIdleConnections()
		delay = min(c.config.RetryMax, delay*2)
	}
}

func retryable(err error) bool {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var tlsError *tls.CertificateVerificationError
	if errors.As(err, &unknown) || errors.As(err, &hostname) || errors.As(err, &invalid) || errors.As(err, &tlsError) {
		return false
	}
	var status *HTTPError
	if errors.As(err, &status) {
		switch status.Status {
		case 408, 429, 502, 503, 504:
			return true
		}
		return false
	}
	var transport *TransportError
	return errors.As(err, &transport) || errors.Is(err, io.ErrUnexpectedEOF)
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

// The watchdog is per RPC, not a deadline on an entire generation. Activity
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

func (c *Client) addState(req *http.Request) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.stateID != "" {
		req.Header.Set("X-DeltaRelay-State-ID", c.stateID)
	}
}

// rpc reads a whole bounded segment before making any bytes visible to callers.
func (c *Client) rpc(ctx context.Context, method, path string, data []byte, headers http.Header, limit int64, sent, requests *atomic.Int64) (*http.Response, []byte, error) {
	attemptCtx, cancel, touch := c.attempt(ctx)
	defer cancel()
	var reader io.Reader
	if data != nil {
		if sent == nil {
			sent = &atomic.Int64{}
		}
		reader = &countingReader{reader: bytes.NewReader(data), count: sent, touch: touch}
	}
	req, err := http.NewRequestWithContext(attemptCtx, method, c.base+path, reader)
	if err != nil {
		return nil, nil, err
	}
	if headers != nil {
		req.Header = headers.Clone()
	}
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "deltarelay/2")
	if data != nil {
		req.ContentLength = int64(len(data))
		req.Header.Set("Content-Type", "application/json")
	}
	c.addState(req)
	if requests != nil {
		requests.Add(1)
	}
	response, err := c.http.Do(req)
	if err != nil {
		return nil, nil, &TransportError{Err: err}
	}
	defer response.Body.Close()
	response.Body = &activityReader{ReadCloser: response.Body, touch: touch}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, responseError(response)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, nil, &TransportError{Err: err}
	}
	if int64(len(body)) > limit {
		return nil, nil, errors.New("relay response exceeds contract limit")
	}
	return response, body, nil
}

func (c *Client) jsonRPC(ctx context.Context, method, path string, data []byte, result any, sent, requests *atomic.Int64) error {
	return c.retry(ctx, func() error {
		_, body, err := c.rpc(ctx, method, path, data, nil, protocol.MaxManifestBytes, sent, requests)
		if err != nil {
			return err
		}
		return json.Unmarshal(body, result)
	})
}

func (c *Client) Info(ctx context.Context) (protocol.Info, error) {
	var info protocol.Info
	if err := c.jsonRPC(ctx, http.MethodGet, "/v2/info", nil, &info, nil, nil); err != nil {
		return info, err
	}
	if info.Version != protocol.RelayVersion || info.ChunkVersion != protocol.Version || !protocol.ValidHash(info.StateID) {
		return info, errors.New("relay does not implement the DeltaRelay v2 contract; upgrade the server (no legacy forwarding fallback)")
	}
	capabilities := make(map[string]bool, len(info.Capabilities))
	for _, capability := range info.Capabilities {
		capabilities[capability] = true
	}
	for _, required := range []string{"durable-mailbox", "idempotent-submit", "response-offsets", "body-ranges", "explicit-cancel", "receipt-ack"} {
		if !capabilities[required] {
			return info, errors.New("relay is missing a required v2 capability")
		}
	}
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.stateID != "" && c.stateID != info.StateID {
		return info, &HTTPError{Status: 409, Code: "state_mismatch", Detail: "relay state identity changed; refusing automatic request dispatch"}
	}
	if c.stateID == "" {
		if err := c.savePin(info.StateID); err != nil {
			return info, err
		}
		c.stateID = info.StateID
	}
	return info, nil
}
