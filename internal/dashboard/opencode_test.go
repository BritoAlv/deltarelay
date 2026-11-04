package dashboard

import (
	"encoding/json"
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
)

func serviceFile(t *testing.T, url, password string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "service.json")
	data, err := json.Marshal(map[string]string{"url": url, "password": password})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOpenCodeSessionCatalogIsBoundedSanitizedAndCached(t *testing.T) {
	created := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC).UnixMilli()
	updated := created + 60_000
	var calls atomic.Int32
	var fail atomic.Bool
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/session" || r.Method != http.MethodGet {
			t.Errorf("unexpected OpenCode request: %s %s", r.Method, r.URL)
		}
		if user, password, ok := r.BasicAuth(); !ok || user != "opencode" || password != "private-opencode-test" {
			t.Errorf("unexpected OpenCode authentication: %q %q %v", user, password, ok)
		}
		if r.URL.Query().Get("limit") != "100" {
			t.Errorf("unexpected OpenCode limit: %s", r.URL.RawQuery)
		}
		if fail.Load() {
			http.Error(w, "private failure body", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("cursor") == "page-2" {
			_, _ = io.WriteString(w, `{"data":[{"id":"ses_page_two","title":"Second page","time":{"created":`+itoa(created+120_000)+`,"updated":`+itoa(updated+120_000)+`},"location":{"directory":"/home/person/projects/other"},"agent":"build","model":{"id":"model-b","providerID":"provider-b"},"cost":1,"tokens":{"input":1},"permissions":[]}],"cursor":{"next":""}}`)
			return
		}
		_, _ = io.WriteString(w, `{"data":[`+
			`{"id":"ses_first","title":"  First\nsession\u0007 \u202e title  ","time":{"created":`+itoa(created)+`,"updated":`+itoa(updated)+`},"location":{"directory":"/home/person/projects/deltarelay/"},"agent":"plan","model":{"id":"model-a","providerID":"provider-a"},"cost":12.5,"tokens":{"input":99},"permissions":[{"action":"browser"}]},`+
			`{"id":"ses_second","title":"Second\nline","time":{"created":`+itoa(created+1_000)+`,"updated":`+itoa(updated+2_000)+`},"location":{"directory":"/home/person/projects/other"},"agent":"build","model":{"id":"model-b","providerID":"provider-b"}}`+
			`],"cursor":{"next":"page-2"}}`)
	}))
	defer remote.Close()
	h := newHandler(t, "http://localhost:1")
	h.config.OpenCodeServiceFile = serviceFile(t, remote.URL, "private-opencode-test")

	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/opencode/sessions", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("catalog status = %d: %s", response.Code, response.Body.String())
	}
	var catalog OpenCodeSessions
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Version != 1 || len(catalog.Sessions) != 3 || catalog.Truncated || catalog.Stale {
		t.Fatalf("unexpected catalog: %+v", catalog)
	}
	if catalog.Sessions[0].ID != "ses_page_two" || catalog.Sessions[0].Project != "other" || catalog.Sessions[0].Model != "provider-b/model-b" {
		t.Fatalf("unexpected first session: %+v", catalog.Sessions[0])
	}
	if catalog.Sessions[1].ID != "ses_second" || catalog.Sessions[1].Title != "Second line" {
		t.Fatalf("unexpected second session: %+v", catalog.Sessions[1])
	}
	if catalog.Sessions[2].ID != "ses_first" || catalog.Sessions[2].Title != "First session title" || catalog.Sessions[2].Project != "deltarelay" {
		t.Fatalf("unexpected sanitized session: %+v", catalog.Sessions[2])
	}
	body := response.Body.String()
	for _, forbidden := range []string{"private-opencode-test", `"cost"`, `"tokens"`, `"permissions"`, `"projectID"`, "private failure body"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("catalog leaked %q: %s", forbidden, body)
		}
	}

	// A second request inside the cache window must not contact OpenCode again.
	response = httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/opencode/sessions", nil))
	if response.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("catalog cache miss: status=%d calls=%d", response.Code, calls.Load())
	}

	// Expire the cache and fail OpenCode: the last successful catalog stays
	// visible and is marked stale rather than disappearing.
	h.catalogNext = time.Now().Add(-time.Second)
	fail.Store(true)
	response = httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/opencode/sessions", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("stale catalog status = %d: %s", response.Code, response.Body.String())
	}
	var stale OpenCodeSessions
	if err := json.Unmarshal(response.Body.Bytes(), &stale); err != nil {
		t.Fatal(err)
	}
	if !stale.Stale || len(stale.Sessions) != 3 {
		t.Fatalf("stale catalog lost data: %+v", stale)
	}
}

func TestOpenCodeSessionCatalogRejectsMissingAndMalformedServices(t *testing.T) {
	h := newHandler(t, "http://localhost:1")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/opencode/sessions", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "opencode_not_configured") {
		t.Fatalf("missing service status = %d: %s", response.Code, response.Body.String())
	}

	for name, handler := range map[string]http.HandlerFunc{
		"invalid-json": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":`)
		},
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "http://evil.example")
			w.WriteHeader(http.StatusFound)
		},
		"invalid-session": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"id":"../private","time":{"created":1,"updated":1}}],"cursor":{"next":""}}`)
		},
		"cursor-loop": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[],"cursor":{"next":"same"}}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			remote := httptest.NewServer(handler)
			defer remote.Close()
			h := newHandler(t, "http://localhost:1")
			h.config.OpenCodeServiceFile = serviceFile(t, remote.URL, "secret")
			response := httptest.NewRecorder()
			h.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/opencode/sessions", nil))
			if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "opencode_unavailable") {
				t.Fatalf("%s status = %d: %s", name, response.Code, response.Body.String())
			}
		})
	}
}

func TestOpenCodeSessionCatalogSupportsHeadAndRejectsWrites(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[],"cursor":{"next":""}}`)
	}))
	defer remote.Close()
	h := newHandler(t, "http://localhost:1")
	h.config.OpenCodeServiceFile = serviceFile(t, remote.URL, "secret")

	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("HEAD", "http://127.0.0.1:8790/api/opencode/sessions", nil))
	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("HEAD catalog status = %d body=%q", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest("POST", "http://127.0.0.1:8790/api/opencode/sessions", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST catalog status = %d", response.Code)
	}
}

func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}
