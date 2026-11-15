// Package gate provides an attach-only, fail-closed proxy to an independently
// managed OpenCode v2 service. It never manages the service's lifecycle.
package gate

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const unavailableMessage = "DeltaRelay's local OpenCode service is not available. Start the OpenCode service, then retry."

type Config struct {
	ServiceFile        string
	Gateway            string
	LocalToken         string
	WorkspaceDirectory string
	HealthCache        time.Duration
	Password           string
	Log                io.Writer
}

type registration struct {
	Version  string `json:"version"`
	URL      string `json:"url"`
	PID      int    `json:"pid"`
	Password string `json:"password"`
}

type Gate struct {
	config        Config
	client        *http.Client
	transport     *http.Transport
	mu            sync.Mutex
	checked       time.Time
	cached        Status
	identity      registration
	flight        *healthFlight
	localChecked  time.Time
	localCached   Status
	localIdentity registration
	localFlight   *healthFlight
	logMu         sync.Mutex
}

// ValidateListen requires a literal loopback address, avoiding DNS rebinding.
func ValidateListen(address string) error {
	host, port, err := net.SplitHostPort(address)
	ip := net.ParseIP(host)
	n, portErr := strconv.Atoi(port)
	if err != nil || ip == nil || !ip.IsLoopback() || portErr != nil || n < 0 || n > 65535 {
		return errors.New("gate must listen on a literal loopback address and valid port")
	}
	return nil
}

func loopbackURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("invalid loopback URL")
	}
	ip := net.ParseIP(u.Hostname())
	port, portErr := strconv.Atoi(u.Port())
	if u.Scheme != "http" || ip == nil || !ip.IsLoopback() || portErr != nil || port < 1 || port > 65535 || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("URL must be a loopback HTTP origin with an explicit port")
	}
	return u, nil
}

func New(config Config) (*Gate, error) {
	if config.ServiceFile == "" || config.LocalToken == "" || strings.ContainsAny(config.LocalToken, "\r\n") || config.HealthCache < 0 {
		return nil, errors.New("gate requires a service file, local token, and nonnegative health cache")
	}
	if _, err := loopbackURL(config.Gateway); err != nil {
		return nil, errors.New("gateway must be a loopback HTTP origin")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // Never send local credentials via environment proxies.
	transport.ResponseHeaderTimeout = 10 * time.Second
	g := &Gate{config: config, transport: transport}
	g.client = &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return g, nil
}

func (g *Gate) Close() {
	g.transport.CloseIdleConnections()
}

func (g *Gate) readRegistration() (registration, error) {
	var r registration
	// Check the path before opening, so an accidental FIFO/device cannot
	// block the HTTP handler. Validate the opened file again below.
	info, err := os.Stat(g.config.ServiceFile)
	if err != nil || !info.Mode().IsRegular() {
		return r, errors.New("registration unavailable or not a regular file")
	}
	f, err := os.Open(g.config.ServiceFile)
	if err != nil {
		return r, errors.New("registration unavailable")
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0177 != 0 || info.Size() > 16384 {
		return r, errors.New("registration must be a private regular file (0600 or stricter)")
	}
	decoder := json.NewDecoder(io.LimitReader(f, 16385))
	if decoder.Decode(&r) != nil || decoder.Decode(new(any)) != io.EOF {
		return registration{}, errors.New("invalid registration")
	}
	if !strings.HasPrefix(r.Version, "2.") || r.PID <= 0 || r.Password == "" || len(r.Password) > 4096 || strings.ContainsAny(r.Password, "\r\n") {
		return registration{}, errors.New("invalid registration identity")
	}
	if _, err := loopbackURL(r.URL); err != nil {
		return registration{}, err
	}
	return r, nil
}

func (g *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	if g.handleLiveness(w, r) {
		return
	}
	if g.config.Password != "" && !g.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="deltarelay-gate"`)
		http.Error(w, "authentication required", http.StatusUnauthorized)
		g.log(r, 401, time.Since(started), "authentication_required")
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
		status, _ := g.health(r.Context())
		writeStatus(w, status)
		code := http.StatusOK
		if !status.Ready {
			code = http.StatusServiceUnavailable
		}
		g.log(r, code, time.Since(started), status.Reason)
		return
	}
	// Attach-only means Varro must reach the same local sessions as Desktop/TUI.
	// Relay readiness gates model requests inside the gateway, not session
	// creation, history, events, or filesystem operations. Probing the gateway
	// here would turn a relay outage into a Varro-wide 503 before the existing
	// recovery window can keep a submitted prompt waiting.
	status, identity := g.localHealth(r.Context())
	if !status.Ready {
		writeStatus(w, status)
		g.log(r, 503, time.Since(started), status.Reason)
		return
	}
	g.proxy(w, r, identity, started)
}

// handleLiveness answers the supervisor's local-only probe without consulting
// the backend or the health cache. It is checked before optional client Basic
// auth so Varro credentials never gate supervisor liveness.
func (g *Gate) handleLiveness(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/livez" || r.Method != http.MethodGet {
		return false
	}
	if r.URL.RawQuery != "" || r.ContentLength != 0 {
		http.Error(w, "invalid liveness request", http.StatusBadRequest)
		return true
	}
	want := sha256.Sum256([]byte(g.config.LocalToken))
	got := sha256.Sum256([]byte(r.Header.Get("X-DeltaRelay-Local-Token")))
	if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		http.Error(w, "invalid local token", http.StatusUnauthorized)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(struct {
		Alive   bool `json:"alive"`
		Version int  `json:"version"`
	}{Alive: true, Version: 1})
	return true
}

func writeStatus(w http.ResponseWriter, status Status) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if !status.Ready {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(status)
}

func (g *Gate) invalidate() {
	g.mu.Lock()
	g.checked = time.Time{}
	g.mu.Unlock()
}

// Refresh only health probes; user requests are never replayed.
func (g *Gate) serviceJSON(ctx context.Context, identity registration, path string, result any) (registration, bool, error) {
	for attempt := 0; attempt < 2; attempt++ {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(identity.URL, "/")+path, nil)
		request.SetBasicAuth("opencode", identity.Password)
		response, err := g.client.Do(request)
		if err == nil {
			if response.StatusCode == http.StatusOK {
				err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(result)
				response.Body.Close()
				return identity, false, err
			}
			code := response.StatusCode
			response.Body.Close()
			if code != http.StatusUnauthorized && code != http.StatusForbidden {
				return identity, false, errors.New("service unhealthy")
			}
		}
		if attempt == 0 {
			identity, err = g.readRegistration()
			if err != nil {
				return identity, true, err
			}
		}
	}
	return identity, false, errors.New("service unavailable")
}
