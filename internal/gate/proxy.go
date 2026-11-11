package gate

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"time"
)

func (g *Gate) authorized(r *http.Request) bool {
	user, password, ok := r.BasicAuth()
	want, got := sha256.Sum256([]byte(g.config.Password)), sha256.Sum256([]byte(password))
	return ok && user == "opencode" && subtle.ConstantTimeCompare(want[:], got[:]) == 1
}

func (g *Gate) proxy(w http.ResponseWriter, r *http.Request, identity registration, started time.Time) {
	upstream, _ := loopbackURL(identity.URL)
	proxy := &httputil.ReverseProxy{
		Transport:     noRetryTransport{g.transport},
		FlushInterval: -1,
		// Suppress standard proxy errors, which can contain secret URLs.
		ErrorLog: log.New(discard{}, "", 0),
		Rewrite: func(p *httputil.ProxyRequest) {
			p.SetURL(upstream)
			p.Out.Host = upstream.Host
			p.Out.Header.Del("Authorization")
			p.Out.Header.Del("Proxy-Authorization")
			p.Out.Header.Del("X-DeltaRelay-Local-Token")
			p.Out.SetBasicAuth("opencode", identity.Password)
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode == 401 || response.StatusCode == 403 {
				g.invalidate()
				// Refresh registration now, but never replay a submitted prompt.
				_, _ = g.readRegistration()
				response.Body.Close()
				return errUpstream{}
			}
			g.log(r, response.StatusCode, time.Since(started), "")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, _ error) {
			g.invalidate()
			_, _ = g.readRegistration()
			var status Status
			status.fail("service_down")
			g.log(r, 503, time.Since(started), status.Reason)
			writeStatus(w, status)
		},
	}
	// Clear replay callbacks as defense in depth; the fresh transport above
	// prevents retries even for bodyless or idempotency-marked requests.
	out := r.Clone(r.Context())
	out.GetBody = nil
	proxy.ServeHTTP(w, out)
}

// net/http may retry on reused connections, even for POST with an idempotency
// key. A fresh transport for each forwarded request prevents that ambiguity.
// CloseIdleConnections also closes the connection when a stream becomes idle;
// it does not interrupt active HTTP, SSE, or WebSocket responses.
type noRetryTransport struct{ base *http.Transport }

func (t noRetryTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	transport := t.base.Clone()
	// Generation endpoints may not send headers until a model finishes.
	// Only health probes have a deadline; forwarded requests follow the
	// client's cancellation rather than an arbitrary response-header cutoff.
	transport.ResponseHeaderTimeout = 0
	response, err := transport.RoundTrip(r)
	transport.CloseIdleConnections()
	return response, err
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

type errUpstream struct{}

func (errUpstream) Error() string { return "service authentication failed" }

func (g *Gate) log(r *http.Request, status int, duration time.Duration, reason string) {
	if g.config.Log == nil {
		return
	}
	g.logMu.Lock()
	defer g.logMu.Unlock()
	_ = json.NewEncoder(g.config.Log).Encode(struct {
		Method     string `json:"method"`
		Path       string `json:"path"`
		Status     int    `json:"status"`
		DurationMS int64  `json:"duration_ms"`
		Reason     string `json:"reason,omitempty"`
	}{r.Method, r.URL.Path, status, duration.Milliseconds(), reason})
}
