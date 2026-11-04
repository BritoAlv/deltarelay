package dashboard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func journalFixture() journalPage {
	return journalPage{Version: 1, Oldest: 1, Newest: 2, Entries: []journalEntry{
		{Sequence: 1, Time: "2026-11-04T12:00:00.123Z", Component: "provider", Trigger: "manual", Operation: "aaaaaaaaaaaaaaaa", Execution: "bbbbbbbb", Stream: "command", Text: "$ gh codespace ssh -c example"},
		{Sequence: 2, Time: "2026-11-04T12:00:01Z", Component: "provider", Trigger: "manual", Operation: "aaaaaaaaaaaaaaaa", Execution: "bbbbbbbb", Stream: "stderr", Text: "actual diagnostic: SSH connection refused\nsecond line <script>not HTML</script>"},
	}}
}

func TestJournalIsBoundedReadOnlyAndIndependentFromGateway(t *testing.T) {
	var calls atomic.Int32
	socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/journal" || r.URL.RawQuery != "after=1&limit=2" {
			t.Errorf("unexpected supervisor request: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-DeltaRelay-Control") != "" {
			t.Error("browser credentials reached the supervisor")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(journalFixture())
	}))
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "gateway-private", ControlSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "http://localhost/api/system/journal?limit=2&after=01", nil)
		r.Header.Set("Authorization", "Bearer browser-private")
		r.Header.Set("Cookie", "private-cookie")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "gateway-private") {
			t.Fatalf("journal unavailable or unsafe: %d %s", w.Code, w.Body)
		}
		if method == "HEAD" && w.Body.Len() != 0 || method == "GET" && !strings.Contains(w.Body.String(), "SSH connection refused") {
			t.Fatal(w.Body)
		}
	}
	for _, query := range []string{"?command=evil", "?path=/etc/passwd", "?after=1&before=2", "?after=1&after=2", "?after=-1", "?after=1e3", "?after=9007199254740992", "?after=", "?limit=0", "?limit=101"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system/journal"+query, nil))
		if w.Code != 400 {
			t.Fatalf("invalid query accepted: %s %d", query, w.Code)
		}
	}
	for _, method := range []string{"POST", "DELETE"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "http://localhost/api/system/journal", strings.NewReader(`{"command":"evil"}`)))
		if w.Code != 405 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://localhost/api/system/journal", nil)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 || calls.Load() != 2 {
		t.Fatalf("unsafe request reached journal: %d calls=%d", w.Code, calls.Load())
	}
}

func TestJournalRejectsInvalidResponsesAndReportsOldSupervisor(t *testing.T) {
	for _, kind := range []string{"old", "version", "order", "stream", "time", "too-many", "oversized-text", "private-extra"} {
		t.Run(kind, func(t *testing.T) {
			page := journalFixture()
			switch kind {
			case "version":
				page.Version = 2
			case "order":
				page.Entries[1].Sequence = 1
			case "stream":
				page.Entries[1].Stream = "shell"
			case "time":
				page.Entries[1].Time = "bad"
			case "too-many":
				page.Entries = make([]journalEntry, 101)
			case "oversized-text":
				page.Entries[1].Text = strings.Repeat("x", 4097)
			}
			socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if kind == "old" {
					w.WriteHeader(404)
					return
				}
				data, _ := json.Marshal(page)
				if kind == "private-extra" {
					data = append(data[:len(data)-1], []byte(`,"private":"not-forwarded"}`)...)
				}
				_, _ = w.Write(data)
			}))
			h, err := New(Config{GatewayURL: "http://localhost:1", LocalToken: "secret", ControlSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system/journal", nil))
			want := 502
			if kind == "old" {
				want = 503
			} else if kind == "private-extra" {
				want = 200
			}
			if w.Code != want || strings.Contains(w.Body.String(), "not-forwarded") {
				t.Fatalf("invalid journal response: %d %s", w.Code, w.Body)
			}
		})
	}
}
