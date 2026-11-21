package dashboard

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDashboardProjectionProxyAllowlist(t *testing.T) {
	for _, tc := range []struct {
		browser, upstream string
	}{
		{"/api/dashboard?compact=1&start=1&end=20&bucket=1&host=alpha&exact=1&now=20&target=evil&token=private", "/dashboard?bucket=1&compact=1&end=20&exact=1&host=alpha&now=20&start=1"},
		{"/api/dashboard/requests?session=&host=alpha&limit=8&before=20&target=evil&compact=1", "/dashboard/requests?before=20&host=alpha&limit=8&session="},
		{"/api/dashboard/usage?start=1&end=20&bucket=1&host=alpha&format=csv&target=evil", "/dashboard/usage?bucket=1&end=20&host=alpha&start=1"},
		{"/api/dashboard/usage/export?start=1&end=20&bucket=1&format=csv&host=alpha&target=evil", "/dashboard/usage/export?end=20&format=csv&host=alpha&start=1"},
	} {
		t.Run(tc.browser, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.String() != tc.upstream || r.Header.Get("X-DeltaRelay-Local-Token") != "private-local-test-token" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Errorf("unsafe proxy request: %s", r.URL)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"ok":true}`)
			}))
			defer remote.Close()
			h := newHandler(t, remote.URL)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790"+tc.browser, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("projection proxy failed: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestDashboardProxyRejectsInvalidQueriesWithoutLeakingBody(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "private upstream detail")
	}))
	defer remote.Close()
	h := newHandler(t, remote.URL)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/dashboard/requests?limit=999", nil))
	if w.Code != http.StatusBadRequest || w.Body.String() != "invalid dashboard query\n" {
		t.Fatalf("bad error propagation: %d %s", w.Code, w.Body)
	}
}
