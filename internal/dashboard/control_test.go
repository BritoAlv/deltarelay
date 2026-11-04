package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/testdata/contracts"
)

func unixServer(t *testing.T, handler http.Handler) string {
	t.Helper()
	// The approved TMPDIR can be long; Unix socket paths have a 108-byte limit.
	directory, err := os.MkdirTemp("", "drctl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(directory) })
	socket := filepath.Join(directory, "s")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return socket
}

func TestSystemControlsSurviveGatewayOutageAndRejectCrossSiteWrites(t *testing.T) {
	var actions atomic.Int32
	fixture := contracts.Read(t, "supervisor-v2.json")
	socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-DeltaRelay-Control") != "" || r.URL.RawQuery != "" {
			t.Error("browser headers, credentials, or query reached supervisor")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/status" {
			_, _ = w.Write(fixture)
			return
		}
		actions.Add(1)
		if r.URL.Path != "/action" || r.Method != "POST" {
			t.Error("wrong control operation")
		}
		w.WriteHeader(202)
		_, _ = io.WriteString(w, `{"accepted":true,"private":"must not be forwarded"}`)
	}))
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "secret-gateway", ControlSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/system", nil))
	var status SystemStatus
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil || !status.Managed || status.CSRFToken == "" || strings.Contains(w.Body.String(), "secret-gateway") {
		t.Fatalf("controls unavailable with gateway down: %d %s", w.Code, w.Body)
	}
	if status.InternetState != "unknown" || status.InternetCheckedAt != nil {
		t.Fatalf("internet reachability not preserved: %s", w.Body)
	}
	for _, tc := range []struct {
		origin, nonce, content, site, query string
		want                                int
	}{
		{"", h.nonce, "application/json", "", "", 403},
		{"http://evil.example", h.nonce, "application/json", "", "", 403},
		{"http://127.0.0.1:8791", h.nonce, "application/json", "same-site", "", 403},
		{"http://127.0.0.1:8790", "wrong", "application/json", "same-origin", "", 403},
		{"http://127.0.0.1:8790", h.nonce, "text/plain", "same-origin", "", 403},
		{"http://127.0.0.1:8790", h.nonce, "application/json", "cross-site", "", 403},
		{"http://127.0.0.1:8790", h.nonce, "application/json", "same-origin", "?command=evil", 400},
		{"http://127.0.0.1:8790", h.nonce, "application/json", "same-origin", "", 202},
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8790/api/system/action"+tc.query, strings.NewReader(`{"component":"tunnel","action":"restart","confirmed":true}`))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-DeltaRelay-Control", tc.nonce)
		r.Header.Set("Content-Type", tc.content)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		r.Header.Set("Authorization", "Bearer browser-secret")
		r.Header.Set("Cookie", "browser-cookie")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("bad control isolation: %d %s", w.Code, w.Body)
		}
	}
	if actions.Load() != 1 {
		t.Fatal("forbidden control request reached supervisor")
	}
}

func TestSystemWithoutSupervisorIsExplicitAndReadOnly(t *testing.T) {
	h := newHandler(t, "http://127.0.0.1:1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost:8790/api/system", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"managed":false`) || !strings.Contains(w.Body.String(), "controls_not_configured") {
		t.Fatal(w.Body)
	}
	r := httptest.NewRequest("POST", "http://localhost:8790/api/system/action", strings.NewReader(`{}`))
	r.Header.Set("Origin", "http://localhost:8790")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-DeltaRelay-Control", h.nonce)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestRemoteProviderStatusAndMetadataFiltering(t *testing.T) {
	for _, tc := range []struct {
		name, snapshot, id, state string
		managed                   bool
	}{
		{"custom", `{"version":2,"managed":true,"components":[],"remote":{"id":"custom_host","label":"My VPS","host_state":"unknown","capabilities":["relay.ensure"],"command":["private-command"],"config_file":"private-path"}}`, "custom_host", "unknown", true},
		{"old-version", `{"version":1,"managed":true,"components":[],"codespace_state":"Shutdown"}`, "configured", "unknown", false},
		{"unknown-capability", `{"version":2,"managed":true,"components":[],"remote":{"id":"custom_host","label":"VPS","host_state":"running","capabilities":["execute"]}}`, "configured", "unknown", false},
		{"duplicate-capability", `{"version":2,"managed":true,"components":[],"remote":{"id":"custom_host","label":"VPS","host_state":"running","capabilities":["host.wake","host.wake"]}}`, "configured", "unknown", false},
		{"vendor-state", `{"version":2,"managed":true,"components":[],"remote":{"id":"custom_host","label":"VPS","host_state":"Available","capabilities":[]}}`, "configured", "unknown", false},
		{"bad-label", `{"version":2,"managed":true,"components":[],"remote":{"id":"custom_host","label":"VPS\nprivate","host_state":"running","capabilities":[]}}`, "configured", "unknown", false},
		{"future-version", `{"version":3,"managed":true,"components":[]}`, "configured", "unknown", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Override only fields relevant to status validation and filtering.
			var base, changes map[string]any
			if err := json.Unmarshal(contracts.Read(t, "supervisor-v2.json"), &base); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(tc.snapshot), &changes); err != nil {
				t.Fatal(err)
			}
			for key, value := range changes {
				base[key] = value
			}
			fixture, err := json.Marshal(base)
			if err != nil {
				t.Fatal(err)
			}
			socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(fixture)
			}))
			h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "private-token", ControlSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
			var state SystemStatus
			if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
				t.Fatal(err)
			}
			if state.Managed != tc.managed || state.Remote.ID != tc.id || state.Remote.HostState != tc.state {
				t.Fatalf("unexpected remote status: %s", w.Body)
			}
			for _, secret := range []string{"private-command", "private-path", "private-token", "codespace_state"} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatalf("private or unsupported field leaked: %s", w.Body)
				}
			}
		})
	}
}

func TestControlUnavailableAndOversizedRequest(t *testing.T) {
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "token", ControlSocket: filepath.Join(t.TempDir(), "missing.sock")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
	if !strings.Contains(w.Body.String(), "supervisor_unavailable") {
		t.Fatal(w.Body)
	}
	r := httptest.NewRequest("POST", "http://localhost/api/system/action", strings.NewReader(strings.Repeat("a", 4097)))
	r.Header.Set("Origin", "http://localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-DeltaRelay-Control", h.nonce)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func writeRegistration(t *testing.T, endpoint string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "service.json")
	data, _ := json.Marshal(map[string]string{"url": endpoint, "password": "private-service-password"})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOAuthExpiryMetadataNeverLeaksSecretsOrRefreshes(t *testing.T) {
	for _, state := range []string{"valid", "expires_soon", "expired_pending_refresh", "needs_auth", "not_oauth", "expiry_unknown"} {
		t.Run(state, func(t *testing.T) {
			expires := time.Now().Add(time.Hour).UnixMilli()
			kind := "oauth"
			switch state {
			case "expires_soon":
				expires = time.Now().Add(time.Minute).UnixMilli()
			case "expired_pending_refresh":
				expires = time.Now().Add(-time.Minute).UnixMilli()
			case "not_oauth":
				kind = "key"
			case "expiry_unknown":
				expires = 0
			}
			var calls atomic.Int32
			service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				user, password, ok := r.BasicAuth()
				if r.Method != "GET" || !ok || user != "opencode" || password != "private-service-password" {
					t.Error("bad private service authentication")
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/credential":
					_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{
						map[string]any{"id": "other", "integrationID": "another", "active": true, "value": map[string]any{"type": "oauth", "expires": 1}},
						map[string]any{"id": "inactive", "integrationID": "openai", "active": false, "value": map[string]any{"type": "oauth", "expires": 1}},
						map[string]any{"id": "active", "integrationID": "openai", "active": true, "value": map[string]any{"type": kind, "expires": expires, "access": "access-secret", "refresh": "refresh-secret", "key": "key-secret"}},
					}})
				case "/api/integration/openai":
					status := ""
					if state == "needs_auth" {
						status = "needs_auth"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"connections": []any{map[string]any{"id": "active", "status": map[string]string{"status": status}}}}})
				default:
					t.Error("unexpected API call; polling must never resolve credentials or refresh OAuth")
				}
			}))
			defer service.Close()
			h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-secret", OpenCodeServiceFile: writeRegistration(t, service.URL)})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
			var value SystemStatus
			if json.Unmarshal(w.Body.Bytes(), &value) != nil || value.Auth.State != state || value.Auth.Stale {
				t.Fatalf("wrong expiry metadata: %s", w.Body)
			}
			for _, secret := range []string{"local-secret", "access-secret", "refresh-secret", "key-secret", "private-service-password", "inactive"} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatalf("credential leaked: %s", secret)
				}
			}
			if value.Auth.ExpiresAt != nil && value.Auth.ExpiresAt.UnixMilli() != expires {
				t.Fatal("expiry units changed")
			}
			before := calls.Load()
			_ = h.authStatus(context.Background())
			if calls.Load() != before {
				t.Fatal("auth metadata not cached")
			}
			service.Close()
			h.authNext = time.Time{}
			stale := h.authStatus(context.Background())
			if !stale.Stale || stale.State != "unavailable" || (stale.ExpiresAt == nil) != (value.Auth.ExpiresAt == nil) {
				t.Fatal("failed read discarded cached expiry or claimed success")
			}
		})
	}
}

func TestAuthRefusesUnsafeRegistrationAndRedirects(t *testing.T) {
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(302)
	}))
	defer redirect.Close()
	for _, kind := range []string{"remote", "public", "symlink", "redirect"} {
		path := writeRegistration(t, redirect.URL)
		switch kind {
		case "remote":
			path = writeRegistration(t, "http://evil.example")
		case "public":
			_ = os.Chmod(path, 0644)
		case "symlink":
			alias := path + ".link"
			_ = os.Symlink(path, alias)
			path = alias
		}
		h, err := New(Config{GatewayURL: "http://localhost:1", LocalToken: "token", OpenCodeServiceFile: path})
		if err != nil {
			t.Fatal(err)
		}
		if status := h.authStatus(context.Background()); status.State != "unavailable" || !status.Stale {
			t.Fatal(kind, status)
		}
		h.Close()
	}
	if calls.Load() != 0 {
		t.Fatal("redirect leaked service credentials")
	}
}
