package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/gateway"
)

func readDashboard(t *testing.T, local string) gateway.DashboardSnapshot {
	t.Helper()
	r, _ := http.NewRequest("GET", local+"/v1/dashboard", nil)
	r.Header.Set("X-DeltaRelay-Local-Token", localToken)
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("diagnostics failed: %d %v %s", response.StatusCode, err, data)
	}
	for _, secret := range []string{localToken, relayToken, "provider-secret", "private-conversation", "private-provider-response", "?secret=query"} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatalf("diagnostics retained private data: %s", secret)
		}
	}
	var result gateway.DashboardSnapshot
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestDashboardSessionSavingsAndFailureAccounting(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("X-DeltaRelay-Session-ID") != "" || r.Header.Get("X-DeltaRelay-Request-Kind") != "" {
			t.Error("dashboard metadata reached provider")
		}
		_, _ = io.Copy(io.Discard, r.Body)
		if calls.Load() == 3 {
			w.WriteHeader(http.StatusTooManyRequests)
		}
		_, _ = io.WriteString(w, "private-provider-response")
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	body := []byte(strings.Repeat("private-conversation ", 15000))
	for i, session := range []string{"ses_alpha", "ses_alpha", "ses_beta"} {
		r, _ := http.NewRequest("POST", f.gateway.URL+"/v1/proxy", bytes.NewReader(body))
		r.Header.Set("X-DeltaRelay-Local-Token", localToken)
		r.Header.Set("X-DeltaRelay-Target", provider.URL+"/v1/responses?secret=query")
		r.Header.Set("X-DeltaRelay-Request-ID", fmt.Sprintf("dashboard-request-%04d", i))
		r.Header.Set("X-DeltaRelay-Session-ID", session)
		r.Header.Set("X-DeltaRelay-Request-Kind", "compaction")
		r.Header.Set("Authorization", "Bearer provider-secret")
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}
	s := readDashboard(t, f.gateway.URL)
	if s.Version != 1 || !s.Relay.Reachable || !s.Relay.Health.Forwarding || len(s.History.Sessions) != 2 || s.History.Totals.Requests != 3 || s.History.Totals.Active != 0 || s.History.Totals.Failed != 1 || s.History.Totals.BodyBytes != int64(len(body)*3) {
		t.Fatalf("wrong session diagnostics: %+v", s)
	}
	if s.History.Totals.EncodedUploadBytes <= 0 || s.History.Totals.EncodedUploadBytes >= s.History.Totals.BodyBytes || s.History.Totals.ReusedBodyBytes == 0 {
		t.Fatalf("savings missing: %+v", s.History.Totals)
	}
	for _, series := range []string{"hourly", "daily"} {
		buckets := s.History.Traffic.Hourly.Buckets
		if series == "daily" {
			buckets = s.History.Traffic.Daily.Buckets
		}
		var requests, bodyBytes int64
		for _, bucket := range buckets {
			requests += bucket.Requests
			bodyBytes += bucket.BodyBytes
		}
		if requests != 3 || bodyBytes != int64(len(body)*3) {
			t.Fatalf("%s traffic did not aggregate finished requests: requests=%d body=%d", series, requests, bodyBytes)
		}
	}
	if s.History.RecentRequests[1].Transfer.UploadedChunks != 0 || s.History.RecentRequests[0].Kind != "compaction" || s.History.RecentRequests[2].State != "failed" {
		t.Fatal("request details lost reuse, kind, or failure state")
	}
	if len(s.Providers) != 1 || s.Providers[0].LastStatus != 429 || s.Providers[0].LastSeen == nil {
		t.Fatal("provider observations missing")
	}
	if calls.Load() != 3 {
		t.Fatal("diagnostics caused a paid provider request")
	}
	f.vps.Close()
	s = readDashboard(t, f.gateway.URL)
	if s.Relay.Reachable || s.History.Totals.Requests != 3 {
		t.Fatal("VPS outage erased history or appeared healthy")
	}
}

func TestDashboardShowsRunningRequestsWithoutReadingTheirBodies(t *testing.T) {
	release := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	response := proxyRequest(t, ctx, f.gateway.URL, provider.URL+"/v1/responses", "running-dashboard-request-0001", []byte("private-conversation"))
	defer response.Body.Close()
	s := readDashboard(t, f.gateway.URL)
	if s.Gateway.Active != 1 || s.History.Totals.Active != 1 || s.History.Sessions[0].ID != "session-example" || s.History.RecentRequests[0].State != "running" || s.Providers[0].Active != 1 || s.History.Totals.BodyBytes != 0 {
		close(release)
		t.Fatalf("running state not observable: %+v", s)
	}
	close(release)
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if final := readDashboard(t, f.gateway.URL); final.History.Totals.Active != 0 || final.History.Totals.Requests != 1 {
		t.Fatal("completed stream still appears active")
	}
}

func TestDashboardGatewayEndpointRequiresTokenAndRejectsBrowserOrigins(t *testing.T) {
	provider := httptest.NewServer(http.NotFoundHandler())
	defer provider.Close()
	f := newFixture(t, provider, 0)
	for _, origin := range []string{"", "http://attacker.example"} {
		r, _ := http.NewRequest("GET", f.gateway.URL+"/v1/dashboard", nil)
		want := 401
		if origin != "" {
			r.Header.Set("Origin", origin)
			r.Header.Set("X-DeltaRelay-Local-Token", localToken)
			want = 403
		}
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("unsafe diagnostics access: got %d want %d", response.StatusCode, want)
		}
	}
}
