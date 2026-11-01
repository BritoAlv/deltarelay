package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"deltarelay/testdata/contracts"
)

func TestSystemSerializationAndSupervisorContracts(t *testing.T) {
	for _, c := range contracts.Cases(t, "system-cases.json") {
		t.Run(c.Name, func(t *testing.T) {
			if c.Valid {
				data := c.Payload(t, "system-v2.json")
				var state SystemStatus
				if err := json.Unmarshal(data, &state); err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(state)
				if err != nil {
					t.Fatal(err)
				}
				contracts.EqualJSON(t, encoded, data)
			}
			if c.Boundary != "both" {
				return // Auth and the browser nonce are owned by the Go producer.
			}
			if c.SupervisorFixture != "" {
				c.Fixture = c.SupervisorFixture
			}
			if _, ok := decodeSupervisorStatus(c.Payload(t, "system-v2.json")); ok != c.Valid {
				t.Fatalf("supervisor validity = %v, want %v", ok, c.Valid)
			}
		})
	}
}

func TestSupervisorFixtureEnrichmentAndLegacyRouting(t *testing.T) {
	for _, version := range []string{"1", "1-early", "2"} {
		t.Run("v"+version, func(t *testing.T) {
			fixture := contracts.Read(t, "supervisor-v"+version+".json")
			body := `{"component":"remote","action":"restart"}`
			if strings.HasPrefix(version, "1") {
				body = `{"component":"codespace","action":"restart"}`
			}
			socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/status" {
					_, _ = w.Write(fixture)
					return
				}
				data, _ := io.ReadAll(r.Body)
				if string(data) != body {
					t.Errorf("action target changed: %s", data)
				}
				w.WriteHeader(202)
				_, _ = io.WriteString(w, `{"accepted":true}`)
			}))
			h, err := New(Config{GatewayURL: "http://localhost:1", LocalToken: "synthetic-token", ControlSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			h.nonce = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
			if w.Code != http.StatusOK {
				t.Fatal(w.Code)
			}
			contracts.EqualJSON(t, w.Body.Bytes(), contracts.Read(t, "system-v"+version+".json"))
			// The proxy never rewrites actions to a newer target while v1 runs.
			r := httptest.NewRequest("POST", "http://localhost/api/system/action", strings.NewReader(body))
			r.Header.Set("Origin", "http://localhost")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-DeltaRelay-Control", h.nonce)
			w = httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 202 {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

func TestUnmanagedSystemMatchesSharedContract(t *testing.T) {
	h := newHandler(t, "http://localhost:1")
	h.nonce = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
	var state SystemStatus
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	state.CollectedAt = "2026-11-01T12:00:00Z" // Only the collection clock varies.
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	contracts.EqualJSON(t, encoded, contracts.Read(t, "system-unmanaged-v2.json"))
}

func TestMalformedSupervisorStatusStaysUnavailable(t *testing.T) {
	valid := string(contracts.Read(t, "supervisor-v2.json"))
	for name, data := range map[string]string{
		"missing-fields":  `{ "version": 2, "managed": true }`,
		"trailing-object": valid + `{}`,
		"oversized-body":  valid + strings.Repeat(" ", 65536),
	} {
		t.Run(name, func(t *testing.T) {
			socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, data) }))
			h, err := New(Config{GatewayURL: "http://localhost:1", LocalToken: "synthetic-token", ControlSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
			var state SystemStatus
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || state.Managed || state.Error != "supervisor_unavailable" || state.CSRFToken == "" {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}
