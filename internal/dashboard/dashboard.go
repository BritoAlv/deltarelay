// Package dashboard serves local diagnostics and optional, narrowly scoped
// supervisor controls. Service/provider credentials never cross into the browser.
package dashboard

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const DefaultAuthIntegration = "openai"

// staticPages are the only HTML paths the dashboard exposes. Files under these
// directories are never served directly.
var staticPages = map[string]bool{
	"/measurement":  true,
	"/measurement/": true,
	"/sessions":     true,
	"/sessions/":    true,
	"/controls":     true,
	"/controls/":    true,
	"/system":       true,
	"/system/":      true,
}

type Config struct {
	GatewayURL          string
	LocalToken          string
	Assets              string
	ControlSocket       string
	OpenCodeServiceFile string
	AuthIntegration     string
}

type Handler struct {
	config    Config
	client    *http.Client
	files     http.Handler
	control   *http.Client
	nonce     string
	authMu    sync.Mutex
	authCache AuthStatus
	authNext  time.Time

	catalogMu   sync.Mutex
	catalog     OpenCodeSessions
	catalogErr  error
	catalogNext time.Time
}

func LoopbackHost(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || ip != nil && ip.IsLoopback()
}

func New(config Config) (*Handler, error) {
	u, err := url.Parse(config.GatewayURL)
	if err != nil || u.Scheme != "http" || !LoopbackHost(u.Hostname()) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.Path != "" && u.Path != "/" {
		return nil, errors.New("dashboard requires a loopback HTTP gateway origin")
	}
	if config.LocalToken == "" {
		return nil, errors.New("dashboard requires the local gateway token")
	}
	config.GatewayURL = strings.TrimSuffix(config.GatewayURL, "/")
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	h := &Handler{config: config, client: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	h.nonce = hex.EncodeToString(nonce[:])
	if config.AuthIntegration == "" {
		h.config.AuthIntegration = DefaultAuthIntegration
	}
	if config.ControlSocket != "" {
		if !filepath.IsAbs(config.ControlSocket) {
			return nil, errors.New("control socket must be an absolute private path")
		}
		h.control = controlClient(config.ControlSocket)
	}
	if config.Assets != "" {
		for _, page := range []string{
			"index.html",
			filepath.Join("measurement", "index.html"),
			filepath.Join("sessions", "index.html"),
			filepath.Join("controls", "index.html"),
			filepath.Join("system", "index.html"),
		} {
			info, err := os.Stat(filepath.Join(config.Assets, page))
			if err != nil || !info.Mode().IsRegular() {
				return nil, errors.New("dashboard build not found; run pnpm build first, or use --assets '' for API-only development")
			}
		}
		h.files = http.FileServer(http.Dir(config.Assets))
	}
	return h, nil
}

func (h *Handler) Close() {
	h.client.CloseIdleConnections()
	if h.control != nil {
		h.control.CloseIdleConnections()
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	// Loopback binding alone does not prevent DNS rebinding or cross-origin
	// browser access. Do not add permissive CORS headers here.
	host := r.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	if !LoopbackHost(host) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "local dashboard access only", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		http.Error(w, "cross-origin requests are not accepted", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/api/system/action" || r.URL.Path == "/api/system/settings" || r.URL.Path == "/api/system/setup" && r.Method == http.MethodPost {
		h.writeControl(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "read-only dashboard", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/api/dashboard" {
		h.snapshot(w, r)
		return
	}
	if r.URL.Path == "/api/opencode/sessions" {
		h.openCodeSessions(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/inspection/") {
		h.inspect(w, r)
		return
	}
	if r.URL.Path == "/api/system" {
		h.system(w, r)
		return
	}
	if r.URL.Path == "/api/system/setup" {
		h.setupStatus(w, r)
		return
	}
	if r.URL.Path == "/api/system/journal" {
		h.journal(w, r)
		return
	}
	if h.files != nil {
		path := r.URL.Path
		if path == "/favicon.svg" || strings.HasPrefix(path, "/_astro/") && !strings.HasSuffix(path, "/") {
			h.files.ServeHTTP(w, r)
			return
		}
		if path == "/" || staticPages[path] {
			// Serve the built directory index directly instead of leaking a
			// FileServer redirect for friendly page URLs.
			if path != "/" && !strings.HasSuffix(path, "/") {
				r.URL.Path += "/"
			}
			h.files.ServeHTTP(w, r)
			return
		}
	}
	http.NotFound(w, r)
}

func (h *Handler) snapshot(w http.ResponseWriter, r *http.Request) {
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, h.config.GatewayURL+"/dashboard", nil)
	if err != nil {
		http.Error(w, "invalid gateway configuration", http.StatusInternalServerError)
		return
	}
	// Never copy incoming headers, cookies, query parameters, or credentials.
	request.Header.Set("X-DeltaRelay-Local-Token", h.config.LocalToken)
	response, err := h.client.Do(request)
	if err != nil {
		writeUnavailable(w, http.StatusBadGateway, "gateway_unreachable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		code := "gateway_unavailable"
		if response.StatusCode == http.StatusUnauthorized {
			code = "gateway_authentication"
		} else if response.StatusCode == http.StatusNotFound {
			code = "gateway_upgrade_required"
		}
		writeUnavailable(w, http.StatusBadGateway, code)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
	if err != nil || len(data) > 8<<20 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		writeUnavailable(w, http.StatusBadGateway, "invalid_gateway_response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func writeUnavailable(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `{"error":"`+code+`"}`)
}
