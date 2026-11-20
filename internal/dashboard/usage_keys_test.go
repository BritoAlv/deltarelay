package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const savedGoKeys = `{"data":[
  {"id":"cred_old","integrationID":"opencode-go","label":"Old account","active":false,"value":{"type":"key","key":"private-old-key","metadata":{"server":"https://untrusted.example","orgID":"wrk_private"}}},
  {"id":"cred_new","integrationID":"opencode-go","label":"New account","active":true,"value":{"type":"key","key":"private-new-key"}},
  {"id":"cred_unrelated","integrationID":"another-provider","active":true,"value":{"type":"key","key":"unrelated-key"}},
  {"id":"cred_oauth","integrationID":"opencode","active":true,"value":{"type":"oauth","access":"private-access","refresh":"private-refresh"}}
]}`

func keyUsageResponse(percent int) string {
	return fmt.Sprintf(`{"usage":{
		"rolling":{"status":"ok","percent":%d,"resetsAt":"2026-11-20T23:22:11.140Z"},
		"weekly":{"status":"ok","percent":64,"resetsAt":"2026-11-23T00:00:00.000Z"},
		"monthly":{"status":"rate-limited","percent":100,"resetsAt":"2026-12-12T23:18:07.000Z"}
	},"workspace":{"id":"wrk_private"}}`, percent)
}

type keyUsageTransport struct {
	local    http.RoundTripper
	localURL string
	usage    http.HandlerFunc
}

func (transport keyUsageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.String() == goUsageURL {
		w := httptest.NewRecorder()
		transport.usage(w, r)
		return w.Result(), nil
	}
	if r.URL.Scheme+"://"+r.URL.Host == transport.localURL {
		return transport.local.RoundTrip(r)
	}
	return nil, errors.New("unexpected usage destination")
}

func newGoKeyUsageHandler(t *testing.T, credentials, usage http.HandlerFunc) *Handler {
	t.Helper()
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, password, ok := r.BasicAuth(); !ok || user != "opencode" || password != "private-service-password" || r.Method != http.MethodGet {
			t.Error("invalid credential discovery authentication or method")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/credential":
			credentials(w, r)
		case "/api/experimental/usage/limits":
			_, _ = io.WriteString(w, `{"data":null}`)
		default:
			t.Error("usage polling must not activate, resolve, or refresh credentials")
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(service.Close)
	h, err := New(Config{GatewayURL: "http://127.0.0.1:1", LocalToken: "local-token", OpenCodeServiceFile: serviceFile(t, service.URL, "private-service-password")})
	if err != nil {
		t.Fatal(err)
	}
	transport := h.client.Transport.(*http.Transport)
	t.Cleanup(transport.CloseIdleConnections)
	h.client.Transport = keyUsageTransport{local: transport, localURL: service.URL, usage: usage}
	t.Cleanup(h.Close)
	return h
}

func refreshKeyUsage(t *testing.T, h *Handler) []GoAccountUsage {
	t.Helper()
	expireUsage(h)
	_, _ = h.goAllowances(context.Background())
	waitForUsageRefresh(t, h)
	_, accounts := h.goAllowances(context.Background())
	return accounts
}

func TestGoUsageDiscoversEverySavedKeyAndKeepsSecretsServerSide(t *testing.T) {
	var calls atomic.Int32
	h := newGoKeyUsageHandler(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, savedGoKeys)
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.Header.Get("Accept") != "application/json" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Opencode-Org-Id") != "" {
			t.Error("unexpected key usage method or headers")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Header.Get("Authorization") {
		case "Bearer private-old-key":
			_, _ = io.WriteString(w, keyUsageResponse(8))
		case "Bearer private-new-key":
			_, _ = io.WriteString(w, keyUsageResponse(22))
		default:
			t.Error("unrelated credential or service password sent to usage endpoint")
			w.WriteHeader(http.StatusUnauthorized)
		}
	})
	accounts := refreshKeyUsage(t, h)
	if len(accounts) != 2 || accounts[0].Active || !accounts[1].Active || accounts[0].Label != "Old account" || accounts[1].Label != "New account" {
		t.Fatalf("saved or active key was not discovered: %+v", accounts)
	}
	if len(accounts[0].ID) != 32 || len(accounts[1].ID) != 32 || accounts[0].ID == accounts[1].ID {
		t.Fatal("account views need distinct opaque identities")
	}
	for i, percent := range []float64{8, 22} {
		account := accounts[i]
		if account.State != "ready" || account.Allowance == nil || account.Allowance.Rolling.Percent != percent || !account.Allowance.Monthly.Limited || account.Allowance.Stale || account.Allowance.CheckedAt.IsZero() {
			t.Fatalf("wrong allowance for key %d: %+v", i, account)
		}
		if !account.Allowance.Rolling.ResetsAt.Equal(time.Date(2026, 11, 20, 23, 22, 11, 140_000_000, time.UTC)) {
			t.Fatal("key reset timestamp was not parsed")
		}
	}
	_, _ = h.goAllowances(context.Background())
	if calls.Load() != 2 {
		t.Fatal("each saved key must be read once per cache window")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://localhost/api/system", nil)
	r.Header.Set("Authorization", "Bearer browser-credential")
	h.ServeHTTP(w, r)
	var status SystemStatus
	if json.Unmarshal(w.Body.Bytes(), &status) != nil || len(status.GoAccounts) != 2 || status.Go != nil {
		t.Fatalf("system status lost per-key usage: %s", w.Body)
	}
	for _, secret := range []string{"private-old-key", "private-new-key", "unrelated-key", "private-access", "private-refresh", "private-service-password", "cred_old", "cred_new", "wrk_private", "untrusted.example", "browser-credential", "keyHash"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("system usage leaked %q", secret)
		}
	}
}

func TestGoUsageIsolatedFailuresDiscoveryFailureAndKeyReplacement(t *testing.T) {
	var credentials atomic.Value
	credentials.Store(savedGoKeys)
	var failOld, failDiscovery atomic.Bool
	h := newGoKeyUsageHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if failDiscovery.Load() {
			http.Error(w, "private discovery error", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, credentials.Load().(string))
	}, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Header.Get("Authorization") {
		case "Bearer private-old-key":
			if failOld.Load() {
				http.Error(w, "private failure", http.StatusBadGateway)
				return
			}
			_, _ = io.WriteString(w, keyUsageResponse(8))
		case "Bearer private-new-key":
			_, _ = io.WriteString(w, keyUsageResponse(22))
		default:
			http.Error(w, "replacement key unavailable", http.StatusServiceUnavailable)
		}
	})
	first := refreshKeyUsage(t, h)
	failOld.Store(true)
	accounts := refreshKeyUsage(t, h)
	if len(accounts) != 2 || accounts[0].State != "unavailable" || accounts[0].Allowance == nil || !accounts[0].Allowance.Stale || !accounts[0].Allowance.CheckedAt.Equal(first[0].Allowance.CheckedAt) {
		t.Fatalf("failed key did not retain its stale observation: %+v", accounts)
	}
	if accounts[1].State != "ready" || accounts[1].Allowance.Stale {
		t.Fatal("one failed key hid the successful key")
	}
	accounts[0].Allowance.Rolling.Percent = 99
	_, cached := h.goAllowances(context.Background())
	if cached[0].Allowance.Rolling.Percent != 8 {
		t.Fatal("returned allowances alias the private cache")
	}
	failDiscovery.Store(true)
	accounts = refreshKeyUsage(t, h)
	if len(accounts) != 2 || !accounts[0].Allowance.Stale || !accounts[1].Allowance.Stale {
		t.Fatal("credential discovery failure lost or freshened old observations")
	}
	failDiscovery.Store(false)
	// Same credential ID, different secret: do not reuse the old key's quota.
	credentials.Store(`{"data":[{"id":"cred_old","integrationID":"opencode-go","label":"Replacement","active":true,"value":{"type":"key","key":"replacement-key"}}]}`)
	accounts = refreshKeyUsage(t, h)
	if len(accounts) != 1 || accounts[0].Label != "Replacement" || accounts[0].State != "unavailable" || accounts[0].Allowance != nil {
		t.Fatalf("removed/replaced keys retained another key's usage: %+v", accounts)
	}
	if accounts[0].ID != first[0].ID {
		t.Fatal("renaming or updating a saved account changed its view identity")
	}
	credentials.Store(`{"data":[]}`)
	if accounts = refreshKeyUsage(t, h); len(accounts) != 0 {
		t.Fatal("removed keys remain on the dashboard")
	}
}

func TestGoKeyUsageValidationAndIndependentErrorStates(t *testing.T) {
	for _, tt := range []struct {
		name   string
		status int
		body   string
		state  string
	}{
		{"valid", 200, keyUsageResponse(8), "ready"},
		{"rejected", 401, "private error body", "invalid_key"},
		{"denied", 403, "private error body", "forbidden"},
		{"throttled", 429, "private error body", "unavailable"},
		{"redirect", 302, "", "unavailable"},
		{"missing", 200, `{}`, "unavailable"},
		{"malformed", 200, `<html>private error</html>`, "unavailable"},
		{"oversized", 200, strings.Repeat(" ", (1<<20)+1), "unavailable"},
		{"missing window", 200, strings.Replace(keyUsageResponse(8), `"weekly":`, `"other":`, 1), "unavailable"},
		{"missing percent", 200, strings.Replace(keyUsageResponse(8), `"percent":8`, `"other":8`, 1), "unavailable"},
		{"negative percent", 200, keyUsageResponse(-1), "unavailable"},
		{"over limit percent", 200, keyUsageResponse(101), "unavailable"},
		{"bad reset", 200, strings.Replace(keyUsageResponse(8), "2026-11-20T23:22:11.140Z", "invalid", 1), "unavailable"},
		{"unknown status", 200, strings.Replace(keyUsageResponse(8), `"status":"ok"`, `"status":"unknown"`, 1), "unavailable"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := newGoKeyUsageHandler(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"data":[{"id":"console-key","integrationID":"opencode","label":"","active":true,"value":{"type":"key","key":"private-console-key"}}]}`)
			}, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.String() != goUsageURL {
					t.Error("followed a usage redirect")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Location", "https://untrusted.example/usage")
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.body)
			})
			accounts := refreshKeyUsage(t, h)
			if len(accounts) != 1 || accounts[0].Label != "API key 1" || accounts[0].State != tt.state || (accounts[0].Allowance != nil) != (tt.state == "ready") {
				t.Fatalf("invalid key result: %+v", accounts)
			}
		})
	}
}

func TestGoKeyUsageLabelsAreBoundedAndDoNotExposeTheKey(t *testing.T) {
	h := newGoKeyUsageHandler(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"data":[
			{"id":"one","integrationID":"opencode-go","label":"private-key\n","value":{"type":"key","key":"private-key"}},
			{"id":"two","integrationID":"opencode-go","label":" \n ","value":{"type":"key","key":"other-key"}},
			{"id":"three","integrationID":"opencode-go","label":"`+strings.Repeat("界", 100)+`","value":{"type":"key","key":"third-key"}}
		]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, keyUsageResponse(8))
	})
	accounts := refreshKeyUsage(t, h)
	if len(accounts) != 3 || accounts[0].Label != "[redacted]" || accounts[1].Label != "API key 2" || len([]rune(accounts[2].Label)) != 80 {
		t.Fatalf("key labels were not sanitized: %+v", accounts)
	}
}

func TestSystemDoesNotWaitForMultipleKeyUsageRequests(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	var calls atomic.Int32
	h := newGoKeyUsageHandler(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, savedGoKeys)
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		started <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, keyUsageResponse(8))
	})
	defer unblock()
	_, _ = h.goAllowances(context.Background())
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("saved keys were not checked concurrently")
		}
	}
	for range 3 {
		done := make(chan int, 1)
		go func() {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/api/system", nil))
			done <- w.Code
		}()
		select {
		case status := <-done:
			if status != http.StatusOK {
				t.Fatal(status)
			}
		case <-time.After(time.Second):
			t.Fatal("system status waited for a key usage request")
		}
	}
	if calls.Load() != 2 {
		t.Fatal("concurrent dashboard polls duplicated usage requests")
	}
	unblock()
	waitForUsageRefresh(t, h)
	_, accounts := h.goAllowances(context.Background())
	if len(accounts) != 2 || accounts[0].State != "ready" || accounts[1].State != "ready" {
		t.Fatal("background key usage was not published")
	}
}
