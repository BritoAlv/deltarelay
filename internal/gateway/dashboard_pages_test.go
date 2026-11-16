package gateway_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"deltarelay/internal/gateway"
	"deltarelay/internal/telemetry"
)

func TestCompactDashboardAndAuthenticatedRequestPages(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "response")
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	for i := 0; i < 11; i++ {
		r, _ := http.NewRequest("POST", f.gateway.URL+"/proxy", strings.NewReader("body"))
		r.Header.Set("X-DeltaRelay-Local-Token", localToken)
		r.Header.Set("X-DeltaRelay-Target", provider.URL+"/v1/responses")
		r.Header.Set("X-DeltaRelay-Request-ID", fmt.Sprintf("paged-request-%04d", i))
		r.Header.Set("X-DeltaRelay-Session-ID", "session")
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("proxy request failed: %d", response.StatusCode)
		}
	}
	get := func(path, token string, destination any) int {
		t.Helper()
		r, _ := http.NewRequest("GET", f.gateway.URL+path, nil)
		r.Header.Set("X-DeltaRelay-Local-Token", token)
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if destination != nil && response.StatusCode == http.StatusOK {
			if err := json.NewDecoder(response.Body).Decode(destination); err != nil {
				t.Fatal(err)
			}
		}
		return response.StatusCode
	}
	now := time.Now()
	path := fmt.Sprintf("/dashboard?compact=1&exact=1&start=%d&end=%d&bucket=3600000", now.Add(-time.Hour).UnixMilli(), now.Add(time.Second).UnixMilli())
	var compact gateway.DashboardSnapshot
	if get(path, localToken, &compact) != http.StatusOK || !compact.RequestsPaged || compact.Overview == nil || compact.History.Totals.Requests != 11 || len(compact.History.RecentRequests) != 0 || compact.Providers[0].LastStatus != 200 {
		t.Fatalf("incorrect compact response: %+v", compact)
	}
	var requests int64
	for _, point := range compact.Overview.Points {
		requests += point.Requests
	}
	if requests != 11 {
		t.Fatalf("range omitted requests: %+v", compact.Overview)
	}
	var first, second telemetry.RequestPage
	if get("/dashboard/requests?session=session&limit=8", localToken, &first) != http.StatusOK || len(first.Requests) != 8 || first.Total != 11 || first.NextBefore == 0 {
		t.Fatalf("incorrect first page: %+v", first)
	}
	if get(fmt.Sprintf("/dashboard/requests?session=session&limit=8&before=%d", first.NextBefore), localToken, &second) != http.StatusOK || len(second.Requests) != 3 || second.NextBefore != 0 {
		t.Fatalf("incorrect last page: %+v", second)
	}
	for _, path := range []string{
		"/dashboard/requests",
		"/dashboard/requests?session=session&limit=101",
		"/dashboard/requests?session=session&before=-1",
		"/dashboard/requests?session=../private",
	} {
		if get(path, localToken, nil) != http.StatusBadRequest {
			t.Errorf("accepted invalid request page: %s", path)
		}
	}
	if get("/dashboard/requests?session=session", "", nil) != http.StatusUnauthorized {
		t.Fatal("request page bypassed gateway authentication")
	}
	full := readDashboard(t, f.gateway.URL)
	if len(full.History.RecentRequests) != 11 || full.History.Totals != compact.History.Totals {
		t.Fatal("read queries lost history")
	}
}
