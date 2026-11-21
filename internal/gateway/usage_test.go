package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/telemetry"
	"deltarelay/internal/transfer"
	"deltarelay/internal/upstream"
	"deltarelay/internal/usage"
)

func TestCredentialNameMatchingDoesNotGuessAmbiguousOrMissingKeys(t *testing.T) {
	c := openCredentialNames("")
	defer c.close()
	header := http.Header{"Authorization": {"Bearer private-secret"}}
	if key := c.resolve(header); key != nil {
		t.Fatal("resolved a key without a loaded credential list")
	}
	c.mu.Lock()
	c.items = []namedCredential{{hash: sha256.Sum256([]byte("private-secret")), key: usage.Key{ID: strings.Repeat("a", 32), Name: "Personal"}}}
	c.mu.Unlock()
	if key := c.resolve(header); key == nil || key.Name != "Personal" {
		t.Fatalf("%+v", key)
	}
	c.mu.Lock()
	c.items = append(c.items, namedCredential{hash: sha256.Sum256([]byte("private-secret")), key: usage.Key{ID: strings.Repeat("b", 32), Name: "Duplicate"}})
	c.mu.Unlock()
	if key := c.resolve(header); key != nil {
		t.Fatal("ambiguous duplicate secret was attributed to one saved credential")
	}
	if key := c.resolve(http.Header{"X-Api-Key": {"unsaved-secret"}}); key != nil {
		t.Fatal("unsaved credential was invented")
	}
	if keys := c.keys(); len(keys) != 2 || keys[0].Name == "" || keys[1].Name == "" {
		t.Fatalf("saved credential list lost an entry: %+v", keys)
	}
}

type usageRelay struct {
	forwards, statuses atomic.Int32
	t                  *testing.T
}

func (f *usageRelay) Forward(_ context.Context, r client.Request, body io.Reader) (*http.Response, transfer.Stats, error) {
	f.forwards.Add(1)
	b, _ := io.ReadAll(body)
	if !strings.Contains(string(b), "private-prompt") || r.Headers.Get("Authorization") == "" {
		f.t.Error("forwarded payload changed")
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"model\":\"test-model\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10,\"total_tokens\":110}}\n\ndata: [DONE]\n\n"))}, transfer.Stats{BodyBytes: int64(len(b))}, nil
}
func (f *usageRelay) Health(context.Context) (client.Health, error) { return client.Health{}, nil }
func (f *usageRelay) ControlStatus() (int, string)                  { return 0, "" }
func (f *usageRelay) Status(context.Context, string) (protocol.RequestStatus, error) {
	f.statuses.Add(1)
	return protocol.RequestStatus{}, nil
}

func TestLocalKeyNamesAndUsageWithoutCaptureOrRemoteCollection(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/credential" || r.Method != "GET" {
			t.Fatal("unexpected OpenCode endpoint")
		}
		if u, p, ok := r.BasicAuth(); !ok || u != "opencode" || p != "private-service-password" {
			t.Error("missing local authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"id":"personal-record","integrationID":"opencode-go","label":"Personal","active":false,"value":{"type":"key","key":"private-personal-key"}},{"id":"work-record","integrationID":"opencode-go","label":"Work","active":true,"value":{"type":"key","key":"private-work-key"}},{"id":"openai-record","integrationID":"openai","label":"OpenAI","active":true,"value":{"type":"oauth","access":"private-openai-access"}}]}`)
	}))
	defer service.Close()
	dir := t.TempDir()
	registration := filepath.Join(dir, "service.json")
	b, _ := json.Marshal(map[string]string{"url": service.URL, "password": "private-service-password"})
	if err := os.WriteFile(registration, b, 0600); err != nil {
		t.Fatal(err)
	}
	fake := &usageRelay{t: t}
	g, err := New(Config{Client: fake, LocalToken: "local-secret", OpenCodeServiceFile: registration, StatsFile: filepath.Join(dir, "stats.json"), Upstreams: []upstream.Rule{{Name: "go", Origin: "https://provider.example", PathPrefix: "/v1/"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	// Deterministic refresh; production does this on its independent local worker.
	g.credentialNames.refresh(context.Background(), http.DefaultClient, registration)
	for i, secret := range []string{"private-personal-key", "private-work-key", "private-openai-access", "unsaved-private-key"} {
		r := httptest.NewRequest("POST", "http://localhost/proxy", strings.NewReader(`{"model":"test-model","messages":[{"role":"user","content":"private-prompt"}]}`))
		r.Header.Set("X-DeltaRelay-Local-Token", "local-secret")
		r.Header.Set("X-DeltaRelay-Target", "https://provider.example/v1/chat/completions")
		r.Header.Set("X-DeltaRelay-Session-ID", "same-session")
		r.Header.Set("Authorization", "Bearer "+secret)
		r.Header.Set("X-DeltaRelay-Request-ID", "local-usage-request-000"+string(rune('1'+i)))
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "data: [DONE]") {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
	}
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://localhost"+path, nil)
		r.Header.Set("X-DeltaRelay-Local-Token", "local-secret")
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		return w
	}
	w := get("/dashboard/usage")
	var report telemetry.UsageReport
	if json.Unmarshal(w.Body.Bytes(), &report) != nil || report.Requests != 4 || report.SessionCount != 1 || len(report.Keys) != 3 || *report.Metrics.InputTokens != 400 || report.UnknownKeyRequests != 1 {
		t.Fatalf("%s", w.Body)
	}
	if report.Series != nil {
		t.Fatal("usage series was returned without a bucket")
	}
	now := time.Now().UTC()
	w = get(fmt.Sprintf("/dashboard/usage?start=%d&end=%d&bucket=3600000", now.Add(-time.Hour).UnixMilli(), now.Add(time.Hour).UnixMilli()))
	var seriesReport telemetry.UsageReport
	if json.Unmarshal(w.Body.Bytes(), &seriesReport) != nil || seriesReport.Series == nil || len(seriesReport.Series.Points) != 2 || len(seriesReport.Series.Models) != 1 || seriesReport.Series.Models[0].Model != "test-model" || *seriesReport.Series.Models[0].InputTokens != 400 {
		t.Fatalf("%s", w.Body)
	}
	for _, query := range []string{"bucket=0&start=1&end=2", "bucket=abc&start=1&end=2", "bucket=1000"} {
		w = get("/dashboard/usage?" + query)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid bucket %q: %d %s", query, w.Code, w.Body)
		}
	}
	personal := ""
	names := map[string]bool{}
	for _, k := range report.Keys {
		names[k.Name] = true
		if k.Name == "Personal" {
			personal = k.ID
		}
	}
	if personal == "" || !names["OpenAI"] {
		t.Fatalf("saved credentials were ignored: %+v", report.Keys)
	}
	w = get("/dashboard/usage?key=" + personal)
	if json.Unmarshal(w.Body.Bytes(), &report) != nil || report.Requests != 1 || report.Sessions[0].Requests != 1 {
		t.Fatalf("%s", w.Body)
	}
	for _, format := range []string{"csv", "json"} {
		w = get("/dashboard/usage/export?key=" + personal + "&format=" + format)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "Personal") {
			t.Fatalf("%s", w.Body)
		}
		for _, secret := range []string{"private-personal-key", "private-work-key", "private-service-password", "private-prompt", "capture_id", `"hash"`, personal} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatalf("export leaked %s", secret)
			}
		}
	}
	w = get("/dashboard/requests?session=same-session&key=" + personal)
	var page telemetry.RequestPage
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || page.Total != 1 || page.Requests[0].APIKey.Name != "Personal" || page.Requests[0].Usage.State != "complete" {
		t.Fatalf("%s", w.Body)
	}
	if fake.forwards.Load() != 4 || fake.statuses.Load() != 0 {
		t.Fatal("usage caused remote collection or extra provider requests")
	}
}

func TestHistoricalUsageBackfillUsesIntegrationAndUpstream(t *testing.T) {
	current := usage.Key{ID: strings.Repeat("a", 32), Name: "Current"}
	historical := usage.Key{ID: strings.Repeat("b", 32), Name: "Historical"}
	openAI := usage.Key{ID: strings.Repeat("c", 32), Name: "OpenAI"}
	other := usage.Key{ID: strings.Repeat("d", 32), Name: "Other"}
	seed := func(t *testing.T, history *telemetry.Recorder, key *usage.Key, upstream, suffix string) {
		t.Helper()
		id := history.Begin("historical-request-"+suffix, "session", upstream, "primary")
		if key != nil {
			history.AttachAPIKey(id, key)
		}
		history.Finish(id, 200, false, "", transfer.Stats{}, 0, 0)
	}
	newGateway := func(t *testing.T, credentials ...savedCredential) (*Gateway, *telemetry.Recorder) {
		t.Helper()
		history, err := telemetry.Open("")
		if err != nil {
			t.Fatal(err)
		}
		names := &credentialNames{ready: make(chan struct{})}
		close(names.ready)
		for _, credential := range credentials {
			names.items = append(names.items, namedCredential{key: credential.Key, integration: credential.Integration})
		}
		return &Gateway{
			config: Config{
				OpenCodeServiceFile: "test-service.json",
				Upstreams: []upstream.Rule{
					{Name: "opencode", Origin: "https://opencode.ai", PathPrefix: "/inference/"},
					{Name: "openai", Origin: "https://api.openai.com", PathPrefix: "/v1/"},
				},
			},
			history:         history,
			credentialNames: names,
		}, history
	}

	t.Run("unobserved credentials are assigned per upstream", func(t *testing.T) {
		g, history := newGateway(t,
			savedCredential{Key: current, Integration: "opencode-go"},
			savedCredential{Key: historical, Integration: "opencode-go"},
			savedCredential{Key: openAI, Integration: "openai"},
		)
		defer history.Close()
		seed(t, history, &current, "opencode", "current")
		seed(t, history, nil, "opencode", "unknown-opencode")
		seed(t, history, nil, "openai", "unknown-openai")

		g.backfillHistoricalUsageKey()
		used, unknown := history.APIKeyAttribution()
		if len(unknown) != 0 || len(used) != 3 {
			t.Fatalf("used=%v unknown=%v", used, unknown)
		}
		report := history.Usage(telemetry.UsageQuery{})
		if report.UnknownKeyRequests != 0 {
			t.Fatalf("unknown requests remain: %+v", report)
		}
		byName := map[string]int64{}
		for _, credential := range report.Keys {
			byName[credential.Name] = credential.Requests
		}
		if byName["Current"] != 1 || byName["Historical"] != 1 || byName["OpenAI"] != 1 {
			t.Fatalf("unexpected attribution: %+v", byName)
		}

		// The selector keeps every saved credential even while one is filtered.
		request := httptest.NewRequest("GET", "http://localhost/dashboard/usage?key="+current.ID, nil)
		response := httptest.NewRecorder()
		g.dashboardUsage(response, request)
		var filtered telemetry.UsageReport
		if json.Unmarshal(response.Body.Bytes(), &filtered) != nil || filtered.Requests != 1 || len(filtered.Keys) != 3 {
			t.Fatalf("%s", response.Body)
		}
	})

	t.Run("ambiguous credentials on one upstream leave history unknown", func(t *testing.T) {
		g, history := newGateway(t,
			savedCredential{Key: current, Integration: "opencode-go"},
			savedCredential{Key: historical, Integration: "opencode-go"},
			savedCredential{Key: other, Integration: "opencode-go"},
			savedCredential{Key: openAI, Integration: "openai"},
		)
		defer history.Close()
		seed(t, history, &current, "opencode", "current")
		seed(t, history, nil, "opencode", "unknown-one")
		seed(t, history, nil, "opencode", "unknown-two")

		request := httptest.NewRequest("GET", "http://localhost/dashboard/usage", nil)
		response := httptest.NewRecorder()
		g.dashboardUsage(response, request)
		var report telemetry.UsageReport
		if json.Unmarshal(response.Body.Bytes(), &report) != nil || report.Requests != 3 || report.UnknownKeyRequests != 2 || len(report.Keys) != 4 {
			t.Fatalf("saved credentials were not listed before attribution: %s", response.Body)
		}

		g.backfillHistoricalUsageKey()
		_, unknown := history.APIKeyAttribution()
		if unknown["opencode"] != 2 {
			t.Fatalf("ambiguous history was guessed: %v", unknown)
		}
	})
}
