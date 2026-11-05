package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRemoteSetupDoesNotNeedGatewayAndUsesProtectedControlAPI(t *testing.T) {
	var installs atomic.Int32
	socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/setup" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-DeltaRelay-Control") != "" {
			t.Error("unexpected setup path or browser credentials reached supervisor")
		}
		if r.Method == "GET" {
			_, _ = io.WriteString(w, `{"version":1,"available":true,"required":true,"busy":false,"last_error":"","target":null,"relay_token":"not-for-browser"}`)
			return
		}
		installs.Add(1)
		var data map[string]any
		if json.NewDecoder(r.Body).Decode(&data) != nil || data["target"] != "my-host" || data["confirmed"] != true {
			t.Error("setup request not preserved")
		}
		w.WriteHeader(202)
		_, _ = io.WriteString(w, `{"accepted":true,"secret":"not-for-browser"}`)
	}))
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-secret", ControlSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8790/api/system/setup", nil))
	var state SetupStatus
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || !state.Available || !state.Required || strings.Contains(w.Body.String(), "not-for-browser") {
		t.Fatalf("bad setup status: %d %s", w.Code, w.Body)
	}
	for _, test := range []struct {
		origin, nonce, query string
		want                 int
	}{
		{"", h.nonce, "", 403},
		{"http://evil.example", h.nonce, "", 403},
		{"http://127.0.0.1:8790", "bad", "", 403},
		{"http://127.0.0.1:8790", h.nonce, "?command=bad", 400},
		{"http://127.0.0.1:8790", h.nonce, "", 202},
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8790/api/system/setup"+test.query, strings.NewReader(`{"provider":"ssh","target":"my-host","remote_directory":"~/relay","ssh_port":22,"remote_port":8787,"confirmed":true}`))
		r.Header.Set("Origin", test.origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-DeltaRelay-Control", test.nonce)
		r.Header.Set("Authorization", "Bearer browser-secret")
		r.Header.Set("Cookie", "browser-cookie")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != test.want || strings.Contains(w.Body.String(), "not-for-browser") {
			t.Fatalf("bad setup authorization: %d %s", w.Code, w.Body)
		}
	}
	if installs.Load() != 1 {
		t.Fatal("unauthorized setup reached supervisor")
	}
}

func TestRemoteSetupRejectsIncompleteOrIncompatibleStatus(t *testing.T) {
	for _, data := range []string{
		`{"version":1,"available":true}`,
		`{"version":2,"available":true,"required":true,"busy":false,"last_error":"","target":null}`,
		`{"version":1,"available":true,"required":false,"busy":false,"last_error":"","target":null}`,
		`{"version":1,"available":true,"required":true,"busy":null,"last_error":"","target":null}`,
		`{"version":1,"available":true,"required":true,"busy":false,"last_error":"","target":{"provider":"shell","target":"host","remote_directory":"~/relay","ssh_port":22,"remote_port":8787}}`,
	} {
		t.Run(data, func(t *testing.T) {
			socket := unixServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, data) }))
			h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "secret", ControlSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system/setup", nil))
			if w.Code != 502 {
				t.Fatalf("invalid setup status accepted: %d %s", w.Code, w.Body)
			}
		})
	}
}
