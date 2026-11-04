package dashboard

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func newHandler(t *testing.T, gateway string) *Handler {
	t.Helper()
	assets := t.TempDir()
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("<!doctype html><title>DeltaRelay</title>"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(assets, "_astro"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "_astro", "app.js"), []byte("export {}"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, page := range []string{"measurement", "sessions", "controls", "system"} {
		if err := os.Mkdir(filepath.Join(assets, page), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(assets, page, "index.html"), []byte("<!doctype html><title>DeltaRelay "+page+"</title>"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	h, err := New(Config{GatewayURL: gateway, LocalToken: "private-local-test-token", Assets: assets})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	return h
}

func TestReadOnlyProxyKeepsCredentialsOnServer(t *testing.T) {
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.String() != "/dashboard" || r.Header.Get("X-DeltaRelay-Local-Token") != "private-local-test-token" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" {
			t.Errorf("unexpected upstream request: %v %v %v", r.Method, r.URL, r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Secret", "must-not-be-forwarded")
		_, _ = io.WriteString(w, `{"version":1}`)
	}))
	defer remote.Close()
	h := newHandler(t, remote.URL)
	request := httptest.NewRequest("GET", "http://127.0.0.1:8790/api/dashboard?target=evil", nil)
	request.Header.Set("Authorization", "Bearer browser-credential")
	request.Header.Set("Cookie", "browser-cookie")
	request.Header.Set("X-DeltaRelay-Local-Token", "browser-token")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 200 || response.Body.String() != `{"version":1}` || response.Header().Get("X-Secret") != "" || strings.Contains(response.Body.String(), "token") {
		t.Fatalf("bad proxy response: %d %v %s", response.Code, response.Header(), response.Body)
	}
	if calls.Load() != 1 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("missing diagnostic isolation")
	}
	for _, path := range []string{"/", "/measurement", "/measurement/", "/sessions", "/sessions/", "/controls", "/controls/", "/system", "/system/", "/_astro/app.js"} {
		response := httptest.NewRecorder()
		h.ServeHTTP(response, httptest.NewRequest("GET", "http://localhost:8790"+path, nil))
		if response.Code != 200 || strings.Contains(response.Body.String(), "private-local-test-token") || response.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("static asset %s leaked credentials or lacked CSP: %d", path, response.Code)
		}
	}
	for _, path := range []string{"/measurement/private", "/sessions/private", "/controls/private", "/system/private"} {
		response = httptest.NewRecorder()
		h.ServeHTTP(response, httptest.NewRequest("GET", "http://localhost:8790"+path, nil))
		if response.Code == 200 {
			t.Fatalf("unlisted subpath %s was served", path)
		}
	}
}

func TestRejectsRemoteOriginsDNSRebindingWritesAndOtherRoutes(t *testing.T) {
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer remote.Close()
	h := newHandler(t, remote.URL)
	cases := []struct {
		method, path, host, origin, site string
		status                           int
	}{
		{"GET", "/api/dashboard", "attacker.example:8790", "", "", 403},
		{"GET", "/api/dashboard", "127.0.0.1:8790", "https://attacker.example", "", 403},
		{"GET", "/api/dashboard", "127.0.0.1:8790", "", "cross-site", 403},
		{"POST", "/api/dashboard", "127.0.0.1:8790", "", "", 405},
		{"PUT", "/api/dashboard", "127.0.0.1:8790", "", "", 405},
		{"GET", "/api/requests/request/cancel", "127.0.0.1:8790", "", "", 404},
		{"GET", "/proxy", "127.0.0.1:8790", "", "", 404},
		{"GET", "/package.json", "127.0.0.1:8790", "", "", 404},
		{"GET", "/_astro/", "127.0.0.1:8790", "", "", 404},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(tc.method, "http://127.0.0.1:8790"+tc.path, nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%+v: got %d", tc, w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("forbidden route reached gateway")
	}
}

func TestUnavailableGatewayAndRedirectDoNotLeakDetails(t *testing.T) {
	for _, status := range []int{401, 404, 500, 302} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "http://evil.example")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, "private failure body")
			}))
			defer remote.Close()
			h := newHandler(t, remote.URL)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/dashboard", nil))
			if w.Code != 502 || strings.Contains(w.Body.String(), "private") || w.Header().Get("Location") != "" {
				t.Fatalf("remote error leaked: %d %s", w.Code, w.Body.String())
			}
		})
	}
	remote := httptest.NewServer(http.NotFoundHandler())
	h := newHandler(t, remote.URL)
	remote.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/dashboard", nil))
	if w.Code != 502 || !strings.Contains(w.Body.String(), "gateway_unreachable") {
		t.Fatal("gateway outage not reported")
	}
}

func TestRejectsNonLoopbackGatewayAndMissingBuild(t *testing.T) {
	for _, gateway := range []string{"https://example.com", "http://127.0.0.1@evil.example", "http://127.0.0.1:8788/private", "http://localhost?token=secret", "http://localhost#fragment"} {
		if _, err := New(Config{GatewayURL: gateway, LocalToken: "token"}); err == nil {
			t.Fatalf("accepted unsafe gateway %q", gateway)
		}
	}
	if _, err := New(Config{GatewayURL: "http://localhost:8788", LocalToken: "token", Assets: t.TempDir()}); err == nil {
		t.Fatal("accepted missing Astro build")
	}
	rootOnly := t.TempDir()
	if err := os.WriteFile(filepath.Join(rootOnly, "index.html"), []byte("<!doctype html>"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{GatewayURL: "http://localhost:8788", LocalToken: "token", Assets: rootOnly}); err == nil {
		t.Fatal("accepted incomplete Astro build without measurement page")
	}
	h, err := New(Config{GatewayURL: "http://[::1]:8788", LocalToken: "token"})
	if err != nil {
		t.Fatal("IPv6 loopback rejected")
	}
	h.Close()
}
