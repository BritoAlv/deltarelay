package gateway_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/gateway"
	"deltarelay/internal/protocol"
	"deltarelay/internal/server"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

const localToken = "local-test-token-separate-from-relay"
const relayToken = "remote-relay-test-token"

type fixture struct {
	gateway, vps *httptest.Server
	storage      *store.Store
	directory    string
}

func newFixture(t *testing.T, provider *httptest.Server, idle time.Duration, configure ...func(*gateway.Config)) fixture {
	t.Helper()
	directory := t.TempDir()
	storage, err := store.OpenLimited(directory, 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	rules := []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/v1/"}}
	vps, err := server.New(server.Config{Store: storage, Token: relayToken, Upstreams: rules, AllowPrivateUpstreams: true, IdleTimeout: idle})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vps.Close)
	remote := httptest.NewServer(vps)
	t.Cleanup(remote.Close)
	c, err := client.New(client.Config{URL: remote.URL, Token: relayToken, NoRetry: true, RetryMin: time.Millisecond, RetryMax: 5 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	config := gateway.Config{Client: c, LocalToken: localToken, Upstreams: rules, AllowPrivateUpstreams: true}
	for _, apply := range configure {
		apply(&config)
	}
	g, err := gateway.New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Close)
	local := httptest.NewServer(g)
	t.Cleanup(local.Close)
	return fixture{gateway: local, vps: remote, storage: storage, directory: directory}
}

func proxyRequest(t *testing.T, ctx context.Context, local, target, id string, body []byte) *http.Response {
	t.Helper()
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, local+"/proxy", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer provider-secret")
	r.Header.Set("X-Opencode-Session", "session-example")
	r.Header.Set("X-DeltaRelay-Local-Token", localToken)
	r.Header.Set("X-DeltaRelay-Target", target)
	r.Header.Set("X-DeltaRelay-Request-ID", id)
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func conversation(extra string) []byte {
	var text strings.Builder
	for i := 0; i < 25000; i++ {
		fmt.Fprintf(&text, "tool line %d: result %x; file path src/file_%d.go and exact output\n", i, uint64(i)*0x9e3779b97f4a7c15, i)
	}
	messages := []map[string]string{{"role": "user", "content": text.String()}}
	if extra != "" {
		messages = append(messages, map[string]string{"role": "user", "content": extra})
	}
	body, _ := json.Marshal(map[string]any{"model": "mock", "stream": true, "messages": messages})
	return body
}

func TestEndToEndStreamingAndReuse(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	captured := make(chan []byte, 4)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer provider-secret" || r.Header.Get("X-Opencode-Session") != "session-example" {
			t.Error("provider authentication or routing headers changed")
		}
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-deltarelay-") {
				t.Error("relay credentials/metadata leaked to provider")
			}
		}
		body, _ := io.ReadAll(r.Body)
		captured <- body
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-Id", "provider-request-id")
		_, _ = fmt.Fprint(w, "data: {\"delta\":\"hello\"}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = fmt.Fprint(w, "data: {\"tool_calls\":[{\"name\":\"read\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	body := conversation("")
	response := proxyRequest(t, ctx, f.gateway.URL, provider.URL+"/v1/responses?keep=query", "streaming-request-0001", body)
	if response.StatusCode != 200 {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("HTTP %d: %s", response.StatusCode, data)
	}
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(line, "hello") {
		t.Fatalf("first event was buffered: %q %v", line, err)
	}
	// The provider cannot finish until this channel is closed; receiving its
	// first event above therefore proves both relay hops streamed immediately.
	close(release)
	rest, err := io.ReadAll(reader)
	response.Body.Close()
	if err != nil || !strings.Contains(string(rest), "tool_calls") || !strings.Contains(string(rest), "[DONE]") {
		t.Fatalf("stream changed: %v %s", err, rest)
	}
	if !bytes.Equal(<-captured, body) || response.Header.Get("X-Request-Id") != "provider-request-id" {
		t.Fatal("request bytes or provider response headers changed")
	}
	cold, _ := strconv.ParseInt(response.Header.Get("X-DeltaRelay-Encoded-Upload-Bytes"), 10, 64)
	modified := conversation("new message after the cached conversation")
	response = proxyRequest(t, ctx, f.gateway.URL, provider.URL+"/v1/responses?keep=query", "streaming-request-0002", modified)
	_, err = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(<-captured, modified) || response.Header.Get("X-DeltaRelay-Body-Hash") != protocol.Sum(modified) {
		t.Fatal("modified request reconstruction differs")
	}
	delta, _ := strconv.ParseInt(response.Header.Get("X-DeltaRelay-Encoded-Upload-Bytes"), 10, 64)
	if delta >= cold/2 {
		t.Fatalf("insufficient real JSON upload reuse: cold=%d delta=%d", cold, delta)
	}
	var baseline bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&baseline, gzip.BestSpeed)
	_, _ = gz.Write(modified)
	_ = gz.Close()
	if delta >= int64(baseline.Len())/2 {
		t.Fatal("delta failed to beat a compressed full-request baseline")
	}
	t.Logf("OpenCode-shaped JSON: body=%d cold encoded upload=%d continuation=%d full-request gzip baseline=%d", len(body), cold, delta, baseline.Len())
	entries, err := os.ReadDir(filepath.Join(f.directory, "spool"))
	if err != nil || len(entries) != 0 {
		t.Fatal("forwarding left body spools")
	}
	if _, err := os.Stat(filepath.Join(f.directory, "bodies")); !os.IsNotExist(err) {
		t.Fatal("normal forwarding retained full conversations")
	}
}

func TestCancellationAndRequestReplayAreSafe(t *testing.T) {
	stopped := make(chan struct{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(stopped)
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	ctx, cancel := context.WithCancel(context.Background())
	response := proxyRequest(t, ctx, f.gateway.URL, provider.URL+"/v1/responses", "cancelled-request-0001", []byte(`{"input":"test"}`))
	if _, err := bufio.NewReader(response.Body).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	cancel()
	response.Body.Close()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not reach provider")
	}
	response = proxyRequest(t, context.Background(), f.gateway.URL, provider.URL+"/v1/responses", "cancelled-request-0001", []byte(`{"input":"test"}`))
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadGateway || calls.Load() != 1 {
		t.Fatal("ambiguous request ID was replayed upstream")
	}
}

func TestProviderErrorsAndRedirects(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusTemporaryRedirect} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var followed atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Add(1) }))
			defer target.Close()
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Location", target.URL)
				w.WriteHeader(status)
				_, _ = fmt.Fprint(w, `{"error":{"message":"rate limited"}}`)
			}))
			defer provider.Close()
			f := newFixture(t, provider, 0)
			r := proxyRequest(t, context.Background(), f.gateway.URL, provider.URL+"/v1/responses", "error-status-request-0001", []byte("{}"))
			body, _ := io.ReadAll(r.Body)
			r.Body.Close()
			if status == 429 && (r.StatusCode != 429 || !strings.Contains(string(body), "rate limited")) {
				t.Fatal("provider error changed")
			}
			if status == 307 && (r.StatusCode != 502 || r.Header.Get("Location") != "") {
				t.Fatal("provider redirect escaped relay")
			}
			if followed.Load() != 0 {
				t.Fatal("redirect followed")
			}
		})
	}
}

func TestIdleTimeoutAbortsStream(t *testing.T) {
	stopped := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: partial\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(stopped)
	}))
	defer provider.Close()
	f := newFixture(t, provider, 40*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := proxyRequest(t, ctx, f.gateway.URL, provider.URL+"/v1/responses", "idle-timeout-request-0001", []byte("{}"))
	_, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err == nil {
		t.Fatal("truncated stream appeared successful")
	}
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("idle timeout did not cancel provider")
	}
}

func TestVPSLossIsReportedAndNeverFallsBack(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	f.vps.Close()
	response := proxyRequest(t, context.Background(), f.gateway.URL, provider.URL+"/v1/responses", "vps-lost-request-0001", []byte(`{"input":"test"}`))
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "cannot reach its VPS") || !strings.Contains(string(body), "No provider request was sent") {
		t.Fatalf("VPS loss not reported precisely: %d %s", response.StatusCode, body)
	}
	if calls.Load() != 0 {
		t.Fatal("VPS loss caused a direct provider call")
	}
}

func TestConnectionDropAfterForwardIsAmbiguous(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer provider.Close()
	storage, err := store.OpenLimited(t.TempDir(), 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	rules := []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/v1/"}}
	vps, err := server.New(server.Config{Store: storage, Token: relayToken, Upstreams: rules, AllowPrivateUpstreams: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vps.Close)
	// Read the complete forwarding request, then sever the connection before any
	// response: the provider may or may not have been contacted.
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			vps.ServeHTTP(w, r)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = connection.Close()
		}
	}))
	defer remote.Close()
	c, err := client.New(client.Config{URL: remote.URL, Token: relayToken, NoRetry: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	g, err := gateway.New(gateway.Config{Client: c, LocalToken: localToken, Upstreams: rules, AllowPrivateUpstreams: true})
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(g)
	defer local.Close()
	response := proxyRequest(t, context.Background(), local.URL, provider.URL+"/v1/responses", "dropped-forward-request-0001", []byte(`{"input":"test"}`))
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "may already have received") {
		t.Fatalf("ambiguous forward not reported: %d %s", response.StatusCode, body)
	}
	if calls.Load() != 0 {
		t.Fatal("dropped forward caused a direct provider call")
	}
}

func TestGatewayLocalReadinessDoesNotDependOnVPS(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	// Local liveness must remain observable during a total VPS outage.
	f.vps.Close()
	request, _ := http.NewRequest(http.MethodGet, f.gateway.URL+"/livez", nil)
	request.Header.Set("X-DeltaRelay-Local-Token", localToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&result) != nil ||
		result["alive"] != true || result["version"] != float64(protocol.RelayVersion) {
		t.Fatalf("local readiness depends on the VPS: %d %v", response.StatusCode, result)
	}
}

func TestGatewayRejectsUnauthorizedAndDisallowedTargets(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	r, err := http.Get(f.gateway.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 401 {
		t.Fatal("local authentication bypassed")
	}
	r = proxyRequest(t, context.Background(), f.gateway.URL, "http://169.254.169.254/latest/meta-data", "forbidden-target-0001", []byte("{}"))
	r.Body.Close()
	if r.StatusCode != 403 || calls.Load() != 0 {
		t.Fatal("SSRF target accepted")
	}
}
