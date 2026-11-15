package dashboard

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"deltarelay/testdata/contracts"
)

func TestStateHistoryContractAndDecoder(t *testing.T) {
	for _, c := range contracts.Cases(t, "state-history-cases.json") {
		t.Run(c.Name, func(t *testing.T) {
			data := c.Payload(t, "state-history-v1.json")
			history, ok := decodeSystemHistory(data)
			if ok != c.Valid {
				t.Fatalf("validity = %v, want %v", ok, c.Valid)
			}
			if !c.Valid {
				return
			}
			encoded, err := json.Marshal(history)
			if err != nil {
				t.Fatal(err)
			}
			contracts.EqualJSON(t, encoded, data)
		})
	}
}

func TestStateHistoryEndpointIsBoundedAndStripsSupervisorExtras(t *testing.T) {
	fixture := contracts.Read(t, "state-history-v1.json")
	var calls atomic.Int32
	socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/history" || r.URL.RawQuery != "bucket=3600&end=1700003600&start=1700000000" {
			t.Errorf("unexpected supervisor request: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-DeltaRelay-Control") != "" {
			t.Error("browser credentials reached the supervisor")
		}
		var value map[string]any
		if json.Unmarshal(fixture, &value) != nil {
			t.Fatal("invalid fixture")
		}
		value["private"] = "must-not-be-forwarded"
		data, _ := json.Marshal(value)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	}))
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "gateway-private", ControlSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "http://localhost/api/system/history?start=1700000000&end=1700003600&bucket=3600", nil)
		r.Header.Set("Authorization", "Bearer browser-private")
		r.Header.Set("Cookie", "private-cookie")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "must-not-be-forwarded") {
			t.Fatalf("history unavailable or unsafe: %d %s", w.Code, w.Body)
		}
		if method == "HEAD" && w.Body.Len() != 0 || method == "GET" && !strings.Contains(w.Body.String(), `"connected":6600`) {
			t.Fatal(w.Body)
		}
	}
	for _, query := range []string{
		"", "?start=1&end=2", "?start=1&end=2&bucket=1&extra=1",
		"?start=1&end=2&bucket=1&bucket=1", "?start=-1&end=2&bucket=1",
		"?start=1&end=2&bucket=0", "?start=1&end=2&bucket=1e3",
		"?start=1&end=999999999999&bucket=1",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system/history"+query, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid query accepted: %s %d", query, w.Code)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("invalid queries reached the supervisor: %d", calls.Load())
	}
	for _, method := range []string{"POST", "DELETE"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "http://localhost/api/system/history?start=1&end=2&bucket=1", strings.NewReader(`{"command":"evil"}`)))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://localhost/api/system/history?start=1&end=2&bucket=1", nil)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden || calls.Load() != 2 {
		t.Fatalf("unsafe request reached history: %d calls=%d", w.Code, calls.Load())
	}
}

func TestStateHistoryRejectsInvalidResponsesAndReportsOldSupervisor(t *testing.T) {
	fixture := contracts.Read(t, "state-history-v1.json")
	for _, kind := range []string{"old", "version", "time", "totals", "private", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			var value map[string]any
			if json.Unmarshal(fixture, &value) != nil {
				t.Fatal("invalid fixture")
			}
			switch kind {
			case "version":
				value["version"] = 2
			case "time":
				value["generated_at"] = "yesterday"
			case "totals":
				value["totals"] = map[string]any{"connected": 1}
			case "private":
				value["private"] = "not-forwarded"
			}
			data, _ := json.Marshal(value)
			socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if kind == "old" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				if kind == "oversized" {
					_, _ = w.Write(bytes.Repeat([]byte(" "), maxHistoryBody+2))
					return
				}
				_, _ = w.Write(data)
			}))
			h, err := New(Config{GatewayURL: "http://localhost:1", LocalToken: "secret", ControlSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system/history?start=1&end=2&bucket=1", nil))
			want := http.StatusBadGateway
			if kind == "old" {
				want = http.StatusServiceUnavailable
			} else if kind == "private" {
				want = http.StatusOK
			}
			if w.Code != want || strings.Contains(w.Body.String(), "not-forwarded") {
				t.Fatalf("invalid history response: %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestStateHistoryRequiresSupervisorConfiguration(t *testing.T) {
	h := newHandler(t, "http://localhost:1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system/history?start=1&end=2&bucket=1", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "controls_not_configured") {
		t.Fatalf("unexpected unconfigured response: %d %s", w.Code, w.Body)
	}
}

func TestHistoryQueryCanonicalization(t *testing.T) {
	query, ok := historyQuery("end=200&bucket=10&start=100")
	if !ok || query != "bucket=10&end=200&start=100" {
		t.Fatalf("unexpected canonical query: %q %v", query, ok)
	}
	if _, ok := historyQuery("start=100&end=200&bucket=10&start=101"); ok {
		t.Fatal("duplicate parameter accepted")
	}
}
