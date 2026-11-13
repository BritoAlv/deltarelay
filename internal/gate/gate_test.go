package gate

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixture struct {
	g            *Gate
	service      *httptest.Server
	gateway      *httptest.Server
	file         string
	forwarding   atomic.Bool
	gatewayReady atomic.Bool
	plugin       atomic.Bool
	calls        atomic.Int32
	infoCalls    atomic.Int32
	healthCalls  atomic.Int32
	logs         bytes.Buffer
}

func setup(t *testing.T, handler http.HandlerFunc) *fixture {
	t.Helper()
	f := &fixture{file: filepath.Join(t.TempDir(), "service.json")}
	f.forwarding.Store(true)
	f.gatewayReady.Store(true)
	f.plugin.Store(true)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.healthCalls.Add(1)
		if r.URL.Path != "/healthz" || r.Header.Get("X-DeltaRelay-Local-Token") != "local-secret" {
			t.Error("invalid gateway probe")
		}
		fmt.Fprintf(w, `{"ready":%t,"vps":{"forwarding":%t}}`, f.gatewayReady.Load(), f.forwarding.Load())
	}))
	t.Cleanup(gateway.Close)
	f.gateway = gateway
	f.service = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "opencode" || password != "service-secret" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/info":
			f.infoCalls.Add(1)
			io.WriteString(w, `{"version":"2.2.6"}`)
		case "/api/plugin":
			if r.URL.Query().Get("location[directory]") != "/workspace with spaces" {
				t.Error("missing workspace scope")
			}
			status := "error"
			if f.plugin.Load() {
				status = "active"
			}
			fmt.Fprintf(w, `{"data":[{"id":"deltarelay","state":{"status":%q}}]}`, status)
		default:
			f.calls.Add(1)
			if handler != nil {
				handler(w, r)
			} else {
				io.WriteString(w, "proxied")
			}
		}
	}))
	t.Cleanup(f.service.Close)
	f.register(t, f.service.URL, "service-secret")
	var err error
	f.g, err = New(Config{ServiceFile: f.file, Gateway: gateway.URL, LocalToken: "local-secret", WorkspaceDirectory: "/workspace with spaces", Log: &f.logs})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.g.Close)
	return f
}

func (f *fixture) register(t *testing.T, url, password string) {
	t.Helper()
	data, _ := json.Marshal(registration{Version: "2.2.6", URL: url, PID: 123, Password: password})
	if err := os.WriteFile(f.file, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func request(g *Gate, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	g.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	return w
}

func TestProxy(t *testing.T) {
	f := setup(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.RequestURI() != "/api/session/test/prompt?secret=query-secret" || string(body) != "prompt-secret" {
			t.Error("request changed")
		}
		if r.Host == "example.com" || !strings.HasPrefix(r.Host, "127.0.0.1:") {
			t.Error("upstream Host not rewritten")
		}
		if r.Header.Get("X-Hop") != "" || r.Header.Get("X-DeltaRelay-Local-Token") != "" {
			t.Error("private/hop headers leaked")
		}
		w.Header().Set("Connection", "X-Response-Hop")
		w.Header().Set("X-Response-Hop", "remove")
		io.WriteString(w, "ok")
	})
	r := httptest.NewRequest("POST", "/api/session/test/prompt?secret=query-secret", strings.NewReader("prompt-secret"))
	r.Header.Set("Authorization", "Bearer client-secret")
	r.Header.Set("Connection", "X-Hop")
	r.Header.Set("X-Hop", "remove")
	r.Header.Set("X-DeltaRelay-Local-Token", "never-forward")
	w := httptest.NewRecorder()
	f.g.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "ok" || w.Header().Get("X-Response-Hop") != "" {
		t.Fatalf("unexpected response: %d %s headers=%v", w.Code, w.Body, w.Header())
	}
	for _, secret := range []string{"service-secret", "local-secret", "client-secret", "query-secret", "prompt-secret"} {
		if strings.Contains(f.logs.String(), secret) {
			t.Fatal("logs leaked a secret")
		}
	}
}

func TestUnhealthy(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		change       func(*testing.T, *fixture)
	}{
		{"gateway", "gateway_down", func(t *testing.T, f *fixture) { f.gatewayReady.Store(false) }},
		{"gateway unreachable", "gateway_down", func(t *testing.T, f *fixture) { f.gateway.Close() }},
		{"forwarding", "gateway_down", func(t *testing.T, f *fixture) { f.forwarding.Store(false) }},
		{"service", "service_down", func(t *testing.T, f *fixture) { f.service.Close() }},
		{"plugin", "plugin_unavailable", func(t *testing.T, f *fixture) { f.plugin.Store(false) }},
		{"missing", "registration_invalid", func(t *testing.T, f *fixture) { os.Remove(f.file) }},
		{"permissions", "registration_invalid", func(t *testing.T, f *fixture) { os.Chmod(f.file, 0644) }},
		{"malformed", "registration_invalid", func(t *testing.T, f *fixture) { os.WriteFile(f.file, []byte("broken"), 0600) }},
		{"trailing JSON", "registration_invalid", func(t *testing.T, f *fixture) {
			data, _ := os.ReadFile(f.file)
			os.WriteFile(f.file, append(data, []byte(" {}")...), 0600)
		}},
		{"directory", "registration_invalid", func(t *testing.T, f *fixture) { f.g.config.ServiceFile = t.TempDir() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t, nil)
			tc.change(t, f)
			w := request(f.g, "/api/session")
			var s Status
			json.Unmarshal(w.Body.Bytes(), &s)
			if w.Code != 503 || s.Reason != tc.reason || s.Error != "backend_unavailable" || f.calls.Load() != 0 {
				t.Fatalf("unexpected result: %d %s", w.Code, w.Body)
			}
			if w.Header().Get("Content-Type") != "application/json" {
				t.Fatal("not JSON")
			}
		})
	}
}

func TestHealthLocalAndCache(t *testing.T) {
	f := setup(t, nil)
	f.g.config.HealthCache = time.Hour
	for range 2 {
		w := request(f.g, "/healthz")
		var s Status
		json.Unmarshal(w.Body.Bytes(), &s)
		if w.Code != 200 || !s.Ready || s.Plugin == nil || !s.Plugin.Ready {
			t.Fatalf("unexpected health: %s", w.Body)
		}
	}
	if f.calls.Load() != 0 || f.infoCalls.Load() != 1 {
		t.Fatal("health proxied or cache missed")
	}
	os.Chmod(f.file, 0644)
	if w := request(f.g, "/healthz"); w.Code != 503 {
		t.Fatal("cache concealed invalid registration")
	}
}

func TestFailuresNotCached(t *testing.T) {
	f := setup(t, nil)
	f.g.config.HealthCache = time.Hour
	f.forwarding.Store(false)
	if request(f.g, "/healthz").Code != 503 {
		t.Fatal("expected failure")
	}
	f.forwarding.Store(true)
	if request(f.g, "/healthz").Code != 200 {
		t.Fatal("failure was cached")
	}
}

func TestOptionalPlugin(t *testing.T) {
	f := setup(t, nil)
	f.g.config.WorkspaceDirectory = ""
	f.plugin.Store(false)
	if w := request(f.g, "/healthz"); w.Code != 200 || strings.Contains(w.Body.String(), `"plugin"`) {
		t.Fatalf("plugin not skipped: %s", w.Body)
	}
}

func TestLivenessIsLocalOnlyAndIgnoresClientAuth(t *testing.T) {
	f := setup(t, nil)
	f.g.config.Password = "gate-secret"
	f.g.config.HealthCache = time.Hour
	r := httptest.NewRequest("GET", "/livez", nil)
	r.Header.Set("X-DeltaRelay-Local-Token", "local-secret")
	w := httptest.NewRecorder()
	f.g.ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" || w.Body.String() != "{\"alive\":true,\"version\":1}\n" {
		t.Fatalf("unexpected liveness response: %d %s", w.Code, w.Body)
	}
	if f.calls.Load() != 0 || f.infoCalls.Load() != 0 || f.healthCalls.Load() != 0 {
		t.Fatal("liveness touched the backend")
	}
	if !f.g.checked.IsZero() || f.g.cached.Ready {
		t.Fatal("liveness populated the health cache")
	}
	if w := request(f.g, "/healthz"); w.Code != 401 {
		t.Fatal("liveness disabled client authentication")
	}
	// A real health request still caches and probes normally afterward.
	health := httptest.NewRequest("GET", "/healthz", nil)
	health.SetBasicAuth("opencode", "gate-secret")
	w = httptest.NewRecorder()
	f.g.ServeHTTP(w, health)
	if w.Code != 200 || f.healthCalls.Load() != 1 || f.g.checked.IsZero() {
		t.Fatalf("health behavior changed: %d %s probes=%d", w.Code, w.Body, f.healthCalls.Load())
	}
	for _, secret := range []string{"local-secret", "gate-secret", "service-secret"} {
		if strings.Contains(f.logs.String(), secret) {
			t.Fatal("liveness logs leaked a secret")
		}
	}
}

func TestLivenessRejectsMissingOrWrongTokenAndInvalidRequestShape(t *testing.T) {
	f := setup(t, nil)
	for name, setupRequest := range map[string]func(*http.Request){
		"missing": func(*http.Request) {},
		"wrong":   func(r *http.Request) { r.Header.Set("X-DeltaRelay-Local-Token", "wrong") },
		"query": func(r *http.Request) {
			r.URL.RawQuery = "token=local-secret"
			r.Header.Set("X-DeltaRelay-Local-Token", "local-secret")
		},
		"body": func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader("secret"))
			r.ContentLength = 6
			r.Header.Set("X-DeltaRelay-Local-Token", "local-secret")
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/livez", nil)
			setupRequest(r)
			w := httptest.NewRecorder()
			f.g.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized && w.Code != http.StatusBadRequest {
				t.Fatalf("invalid liveness request accepted: %d %s", w.Code, w.Body)
			}
		})
	}
	if f.calls.Load() != 0 || f.infoCalls.Load() != 0 || f.healthCalls.Load() != 0 {
		t.Fatal("invalid liveness request reached the backend")
	}
}

func TestRestart(t *testing.T) {
	f := setup(t, nil)
	f.g.config.HealthCache = time.Hour
	if request(f.g, "/api/session").Code != 200 {
		t.Fatal("initial request failed")
	}
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, password, _ := r.BasicAuth()
		if password != "rotated-secret" {
			t.Error("stale password")
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/info":
			io.WriteString(w, `{"version":"2.3.0"}`)
		case "/api/plugin":
			io.WriteString(w, `{"data":[{"id":"deltarelay","state":{"status":"active"}}]}`)
		default:
			io.WriteString(w, "restarted")
		}
	}))
	defer service.Close()
	f.service.Close()
	f.register(t, service.URL, "rotated-secret")
	if w := request(f.g, "/api/session"); w.Code != 200 || w.Body.String() != "restarted" {
		t.Fatalf("did not follow restart: %d %s", w.Code, w.Body)
	}
}

func TestProbeReloadsRegistration(t *testing.T) {
	for _, code := range []int{401, 403, 0} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			f := setup(t, nil)
			var hits atomic.Int32
			stale := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				f.register(t, f.service.URL, "service-secret")
				if code == 0 {
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
					return
				}
				w.WriteHeader(code)
			}))
			defer stale.Close()
			f.register(t, stale.URL, "old-secret")
			if w := request(f.g, "/api/session"); w.Code != 200 {
				t.Fatalf("probe failed to refresh: %s", w.Body)
			}
			if hits.Load() != 1 {
				t.Fatal("unexpected probe retries")
			}
		})
	}
}

func TestPromptNeverRetried(t *testing.T) {
	for _, code := range []int{401, 403, 0} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			f := setup(t, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				if code == 0 {
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
					return
				}
				w.WriteHeader(code)
			})
			r := httptest.NewRequest("POST", "/api/session/s/prompt", strings.NewReader("prompt"))
			r.Header.Set("Idempotency-Key", "test")
			w := httptest.NewRecorder()
			f.g.ServeHTTP(w, r)
			if w.Code != 503 || f.calls.Load() != 1 {
				t.Fatalf("prompt replayed or not failed closed: code=%d calls=%d", w.Code, f.calls.Load())
			}
		})
	}
}

func TestSSE(t *testing.T) {
	release := make(chan struct{})
	f := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
		io.WriteString(w, "data: second\n\n")
	})
	server := httptest.NewServer(f.g)
	defer server.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(server.URL + "/api/event")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("SSE buffered: %q %v", line, err)
	}
	f.forwarding.Store(false)
	if request(f.g, "/healthz").Code != 503 {
		t.Fatal("new request not blocked")
	}
	close(release)
	if line, err := reader.ReadString('\n'); err != nil || line != "\n" {
		t.Fatalf("missing SSE delimiter: %q %v", line, err)
	}
	if line, err := reader.ReadString('\n'); err != nil || line != "data: second\n" {
		t.Fatalf("existing stream interrupted: %q %v", line, err)
	}
}

func TestWebSocket(t *testing.T) {
	f := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			t.Error("missing upgrade")
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprint(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		rw.Flush()
		io.Copy(conn, conn)
	})
	server := httptest.NewServer(f.g)
	defer server.Close()
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "GET /api/pty/test/connect HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	reader := bufio.NewReader(conn)
	r, err := http.ReadResponse(reader, nil)
	if err != nil || r.StatusCode != 101 {
		t.Fatalf("upgrade failed: %v %v", r, err)
	}
	// A masked WebSocket text frame, echoed byte-for-byte through the tunnel.
	frame := []byte{0x81, 0x82, 1, 2, 3, 4, 'h' ^ 1, 'i' ^ 2}
	conn.Write(frame)
	got := make([]byte, len(frame))
	if _, err := io.ReadFull(reader, got); err != nil || !bytes.Equal(got, frame) {
		t.Fatalf("duplex tunnel failed: %x %v", got, err)
	}
}

func TestRegistrationValidation(t *testing.T) {
	for _, raw := range []string{
		`{"version":"1.2.3","pid":1,"url":"http://127.0.0.1:4096","password":"x"}`,
		`{"version":"2.2.6","pid":0,"url":"http://127.0.0.1:4096","password":"x"}`,
		`{"version":"2.2.6","pid":1,"url":"http://127.0.0.1:4096","password":""}`,
	} {
		f := setup(t, nil)
		os.WriteFile(f.file, []byte(raw), 0600)
		if request(f.g, "/healthz").Code != 503 {
			t.Fatal("accepted invalid identity")
		}
	}
	for _, raw := range []string{"https://127.0.0.1:4096", "http://example.com:4096", "http://localhost:4096", "http://127.0.0.1", "http://127.0.0.1:4096/foo", "http://a:b@127.0.0.1:4096", "http://127.0.0.1:4096?x=y", "http://127.0.0.1:4096#secret", "http://127.0.0.1:4096?"} {
		if _, err := loopbackURL(raw); err == nil {
			t.Fatalf("accepted unsafe URL %s", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:4096", "http://[::1]:4096"} {
		if _, err := loopbackURL(raw); err != nil {
			t.Fatalf("valid URL rejected: %v", err)
		}
	}
}

func TestListen(t *testing.T) {
	for _, raw := range []string{":18789", "0.0.0.0:18789", "[::]:18789", "192.168.1.1:18789", "localhost:18789", "127.0.0.1:65536"} {
		if ValidateListen(raw) == nil {
			t.Fatalf("unsafe listen accepted: %s", raw)
		}
	}
	for _, raw := range []string{"127.0.0.1:18789", "[::1]:18789"} {
		if err := ValidateListen(raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGatePassword(t *testing.T) {
	f := setup(t, nil)
	f.g.config.Password = "gate-secret"
	if request(f.g, "/healthz").Code != 401 {
		t.Fatal("unauthenticated request accepted")
	}
	r := httptest.NewRequest("GET", "/api/session", nil)
	r.SetBasicAuth("opencode", "gate-secret")
	w := httptest.NewRecorder()
	f.g.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("gate password failed: %s", w.Body)
	}
}

func TestConcurrentRequestsShareHealthProbe(t *testing.T) {
	f := setup(t, nil)
	var probes atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes.Add(1)
		// Model the relay round trip. Startup requests should pay this once,
		// concurrently, not once per request while holding a shared lock.
		select {
		case <-time.After(150 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, `{"ready":true,"vps":{"forwarding":true}}`)
	}))
	defer gateway.Close()
	f.g.config.Gateway = gateway.URL
	const count = 24
	start := make(chan struct{})
	var ready, done sync.WaitGroup
	ready.Add(count)
	done.Add(count)
	for range count {
		go func() {
			defer done.Done()
			ready.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			w := httptest.NewRecorder()
			f.g.ServeHTTP(w, httptest.NewRequest("GET", "/api/session", nil).WithContext(ctx))
			if w.Code != 200 {
				t.Errorf("concurrent request failed: %d %s", w.Code, w.Body)
			}
		}()
	}
	ready.Wait()
	close(start)
	done.Wait()
	if got := probes.Load(); got != 1 {
		t.Fatalf("startup health probes serialized or duplicated: got %d, want 1", got)
	}
	// Sharing in-flight work must not become caching when configured as zero.
	if request(f.g, "/healthz").Code != 200 || probes.Load() != 2 {
		t.Fatal("completed health result was cached")
	}
}

func TestHealthWaiterCancellation(t *testing.T) {
	f := setup(t, nil)
	entered, release := make(chan struct{}), make(chan struct{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		io.WriteString(w, `{"ready":true,"vps":{"forwarding":true}}`)
	}))
	defer gateway.Close()
	f.g.config.Gateway = gateway.URL
	leaderDone := make(chan struct{})
	defer func() { close(release); <-leaderDone }()
	go func() { defer close(leaderDone); request(f.g, "/healthz") }()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		status, _ := f.g.health(ctx)
		if status.Ready {
			t.Error("canceled waiter succeeded")
		}
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("canceled request blocked behind health lock")
	}
}

func TestProxyDoesNotApplyHealthHeaderTimeout(t *testing.T) {
	f := setup(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(50 * time.Millisecond):
			io.WriteString(w, "generated")
		case <-r.Context().Done():
		}
	})
	f.g.transport.ResponseHeaderTimeout = time.Millisecond
	w := httptest.NewRecorder()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := httptest.NewRequest("POST", "/api/experimental/generate/text", strings.NewReader("prompt")).WithContext(ctx)
	f.g.proxy(w, r, registration{URL: f.service.URL, Password: "service-secret"}, time.Now())
	if w.Code != 200 || w.Body.String() != "generated" {
		t.Fatalf("generation inherited health timeout: %d %s", w.Code, w.Body)
	}
}
