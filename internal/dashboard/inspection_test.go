package dashboard

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInspectionProxyAcceptsOnlyValidatedCaptureRoutes(t *testing.T) {
	id := strings.Repeat("a", 32)
	var calls atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.Header.Get("X-DeltaRelay-Local-Token") != "private-local-test-token" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" {
			t.Errorf("unsafe inspection proxy request: %+v", r)
		}
		if strings.HasSuffix(r.URL.Path, "/download") {
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = io.WriteString(w, "captured-bytes")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":1}`)
	}))
	defer remote.Close()
	h := newHandler(t, remote.URL)
	valid := []string{
		"/api/inspection/" + id,
		"/api/inspection/" + id + "/chunks?start=0&limit=128&inventory=0",
		"/api/inspection/" + id + "/attempts/12",
		"/api/inspection/" + id + "/artifacts/body?offset=0&limit=4096",
		"/api/inspection/" + id + "/artifacts/attempt-3?decode=1&offset=10&limit=20",
		"/api/inspection/" + id + "/artifacts/body/download?decode=1",
	}
	for _, path := range valid {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://127.0.0.1:8790"+path, nil)
		r.Header.Set("Authorization", "Bearer browser-credential")
		r.Header.Set("Cookie", "browser-cookie")
		h.ServeHTTP(w, r)
		if w.Code != 200 || strings.Contains(w.Body.String(), "private-local-test-token") {
			t.Fatalf("valid inspection route rejected or leaked: %s %d %s", path, w.Code, w.Body.String())
		}
	}
	invalid := []string{
		"/api/inspection/../../dashboard",
		"/api/inspection/" + id + "/artifacts/body?url=http://attacker.example",
		"/api/inspection/" + id + "/chunks?limit=100000",
		"/api/inspection/" + id + "/chunks?start=-1",
		"/api/inspection/" + id + "/attempts/x",
		"/api/inspection/" + id + "/artifacts/capture",
		"/api/inspection/" + id + "/artifacts/body?offset=0&offset=1",
	}
	before := calls.Load()
	for _, path := range invalid {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790"+path, nil))
		if w.Code == 200 {
			t.Fatalf("invalid inspection route accepted: %s", path)
		}
	}
	if calls.Load() != before {
		t.Fatal("invalid inspection parameters reached gateway")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "http://127.0.0.1:8790/api/inspection/"+id, nil))
	if w.Code != 405 {
		t.Fatal("inspection proxy accepted a write")
	}
}

func TestInspectionProxyPreservesKnownCaptureErrorsOnly(t *testing.T) {
	id := strings.Repeat("c", 32)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/attempts/1") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":"attempt_not_captured"}`)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":"private upstream detail"}`)
	}))
	defer remote.Close()
	h := newHandler(t, remote.URL)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/inspection/"+id+"/attempts/1", nil))
	if w.Code != 404 || !strings.Contains(w.Body.String(), "attempt_not_captured") || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("known capture error was lost or trusted: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/inspection/"+id, nil))
	if w.Code != 502 || !strings.Contains(w.Body.String(), "capture_unavailable") || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("unknown upstream error leaked: %d %s", w.Code, w.Body.String())
	}
}

func TestInspectionProxyDoesNotTrustUpstreamHeaders(t *testing.T) {
	id := strings.Repeat("b", 32)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="../../private"`)
		w.Header().Set("Location", "http://attacker.example")
		_, _ = io.WriteString(w, `{"malicious":"<script>alert(1)</script>"}`)
	}))
	defer remote.Close()
	h := newHandler(t, remote.URL)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/inspection/"+id+"/artifacts/body/download", nil))
	if w.Code != 502 || w.Header().Get("Location") != "" || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("mismatched upstream download was trusted: %d %+v", w.Code, w.Header())
	}
}
