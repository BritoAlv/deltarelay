package gateway_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestVersionedGatewayRoutesDoNotExistOrDispatch(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	t.Cleanup(provider.Close)
	f := newFixture(t, provider, time.Second)
	for _, prefix := range []string{"/v1", "/v2"} {
		for _, route := range []string{"POST /proxy", "GET /dashboard", "GET /inspection/" + strings.Repeat("a", 32)} {
			method, path, _ := strings.Cut(route, " ")
			r, err := http.NewRequest(method, f.gateway.URL+prefix+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("X-DeltaRelay-Local-Token", localToken)
			r.Header.Set("X-DeltaRelay-Target", provider.URL+"/v1/responses")
			response, err := http.DefaultClient.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNotFound || response.Header.Get("Location") != "" {
				t.Fatalf("removed route %s%s still exists: %d", prefix, path, response.StatusCode)
			}
		}
	}
	if calls.Load() != 0 {
		t.Fatal("removed gateway route dispatched provider work")
	}
}
