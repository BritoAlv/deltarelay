package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const usageResponse = `{
  "location": {"directory": "/private/tmp/project"},
  "data": {
    "workspace": {"id": "wrk_private", "name": "Private workspace", "usageURL": "https://opencode.ai/console/wrk_private/activity/overview"},
    "go": {
      "rolling": {"percent": 8, "limited": false, "resetsAt": 1794615131000},
      "weekly": {"percent": 22, "limited": false, "resetsAt": 1794787200000},
      "monthly": {"percent": 11, "limited": true, "resetsAt": 1797117487000}
    },
    "budgets": []
  }
}`

func waitForUsageRefresh(t *testing.T, h *Handler) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.usageMu.Lock()
		refreshing := h.usageRefreshing
		h.usageMu.Unlock()
		if !refreshing {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Go usage refresh did not complete")
}

func expireUsage(h *Handler) {
	h.usageMu.Lock()
	h.usageNext = time.Time{}
	h.usageMu.Unlock()
}

func TestGoAllowanceIsParsedCachedAndSanitized(t *testing.T) {
	var calls atomic.Int32
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if user, password, ok := r.BasicAuth(); !ok || user != "opencode" || password != "private-usage-test" {
			t.Error("bad private service authentication")
		}
		if r.URL.Path != "/api/experimental/usage/limits" {
			t.Errorf("unexpected usage request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, usageResponse)
	}))
	defer service.Close()
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-token", OpenCodeServiceFile: serviceFile(t, service.URL, "private-usage-test")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()

	_ = h.goAllowance(context.Background())
	waitForUsageRefresh(t, h)
	usage := h.goAllowance(context.Background())
	if usage == nil || usage.Rolling.Percent != 8 || usage.Weekly.Percent != 22 || usage.Monthly.Percent != 11 || !usage.Monthly.Limited || usage.Stale || usage.CheckedAt.IsZero() {
		t.Fatalf("unexpected Go allowance: %+v", usage)
	}
	if got := time.UnixMilli(1794615131000).UTC(); !usage.Rolling.ResetsAt.Equal(got) {
		t.Fatalf("wrong reset time: %s", usage.Rolling.ResetsAt)
	}
	encoded, err := json.Marshal(usage)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"wrk_private", "Private workspace", "private-usage-test"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("usage leaked %q: %s", secret, encoded)
		}
	}

	// The second read inside the cache window must not call OpenCode again.
	before := calls.Load()
	_ = h.goAllowance(context.Background())
	if calls.Load() != before {
		t.Fatal("Go allowance was not cached")
	}
}

func TestGoAllowanceKeepsLastObservationOnFailureAndHandlesMissingGo(t *testing.T) {
	var fail atomic.Bool
	var missing atomic.Bool
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/experimental/usage/limits" {
			http.NotFound(w, r)
			return
		}
		if fail.Load() {
			http.Error(w, "private failure body", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if missing.Load() {
			_, _ = io.WriteString(w, `{"data": null}`)
			return
		}
		_, _ = io.WriteString(w, usageResponse)
	}))
	defer service.Close()
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-token", OpenCodeServiceFile: serviceFile(t, service.URL, "private-usage-test")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()

	_ = h.goAllowance(context.Background())
	waitForUsageRefresh(t, h)
	first := h.goAllowance(context.Background())
	if first == nil {
		t.Fatal("missing initial allowance")
	}
	fail.Store(true)
	expireUsage(h)
	stale := h.goAllowance(context.Background())
	if stale == nil || !stale.Stale || stale.Rolling.Percent != first.Rolling.Percent {
		t.Fatalf("failed refresh lost the last observation: %+v", stale)
	}
	waitForUsageRefresh(t, h)
	if stale = h.goAllowance(context.Background()); stale == nil || !stale.Stale {
		t.Fatal("failed refresh did not mark cached usage stale")
	}

	fail.Store(false)
	missing.Store(true)
	expireUsage(h)
	_ = h.goAllowance(context.Background())
	waitForUsageRefresh(t, h)
	if usage := h.goAllowance(context.Background()); usage != nil {
		t.Fatalf("missing Go subscription should stay neutral: %+v", usage)
	}
}

func TestSystemEndpointIncludesGoAllowanceWithoutServiceSecrets(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/credential":
			_, _ = io.WriteString(w, `{"data":[]}`)
		case "/api/experimental/usage/limits":
			_, _ = io.WriteString(w, usageResponse)
		default:
			http.NotFound(w, r)
		}
	}))
	defer service.Close()
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-token", OpenCodeServiceFile: serviceFile(t, service.URL, "private-usage-test")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()

	_ = h.goAllowance(context.Background())
	waitForUsageRefresh(t, h)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var status SystemStatus
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Go == nil || status.Go.Rolling.Percent != 8 || status.Auth.State != "not_connected" {
		t.Fatalf("system response lost Go allowance or auth metadata: %s", w.Body)
	}
	for _, secret := range []string{"wrk_private", "private-usage-test", "private failure body"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("system response leaked %q: %s", secret, w.Body)
		}
	}
}

func TestSystemDoesNotWaitForGoUsage(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	var calls atomic.Int32
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/experimental/usage/limits" {
			_, _ = io.WriteString(w, `{"data":[]}`)
			return
		}
		calls.Add(1)
		started <- struct{}{}
		<-release
		_, _ = io.WriteString(w, usageResponse)
	}))
	defer service.Close()
	defer unblock()
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-token", OpenCodeServiceFile: serviceFile(t, service.URL, "private-usage-test")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()

	requestStatus := func() SystemStatus {
		t.Helper()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
			done <- w
		}()
		select {
		case w := <-done:
			var status SystemStatus
			if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &status) != nil {
				t.Fatalf("invalid system response: %s", w.Body)
			}
			return status
		case <-time.After(time.Second):
			t.Fatal("system status waited for Go usage")
			return SystemStatus{}
		}
	}
	if status := requestStatus(); status.Go != nil || status.Auth.State != "not_connected" {
		t.Fatalf("cold cache must not prevent other status from rendering: %+v", status)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background usage refresh did not start")
	}
	for range 5 {
		requestStatus()
	}
	if calls.Load() != 1 {
		t.Fatal("concurrent requests started duplicate usage lookups")
	}
	// An expired observation remains available while the service is blocked.
	h.usageMu.Lock()
	h.usageCache = &GoAllowance{Rolling: AllowanceMeter{Percent: 7}}
	h.usageMu.Unlock()
	if status := requestStatus(); status.Go == nil || !status.Go.Stale || status.Go.Rolling.Percent != 7 {
		t.Fatalf("in-flight refresh did not preserve stale usage: %+v", status.Go)
	}
	unblock()
	waitForUsageRefresh(t, h)
	if status := requestStatus(); status.Go == nil || status.Go.Stale || status.Go.Rolling.Percent != 8 {
		t.Fatalf("background usage was not published: %+v", status.Go)
	}
}
