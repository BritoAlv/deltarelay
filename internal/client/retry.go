package client

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"sync/atomic"
	"time"

	"deltarelay/internal/inspection"
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

func (c *Client) jsonRPC(ctx context.Context, method, path string, data []byte, result any, sent, requests *atomic.Int64) error {
	return c.retry(ctx, func() error {
		response, err := c.rpc(ctx, method, path, data, nil, protocol.MaxManifestBytes, sent, requests)
		if err != nil {
			return err
		}
		err = json.Unmarshal(response.body, result)
		if err != nil {
			inspection.FromContext(ctx).RefineOutcome(response.inspectionIndex, "invalid_response")
		}
		return err
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
