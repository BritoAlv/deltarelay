package gateway_test

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"deltarelay/internal/gateway"
	"deltarelay/internal/inspection"
)

func TestOptInRequestInspectionAndCredentialIsolation(t *testing.T) {
	var calls atomic.Int32
	body := []byte(`{"messages":[{"content":"private-conversation é"}],"number":9007199254740993}`)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		got, _ := io.ReadAll(r.Body)
		if !bytes.Equal(got, body) || r.Header.Get("Authorization") != "Bearer provider-secret" {
			t.Error("capture changed forwarded request")
		}
		_, _ = io.WriteString(w, "private-provider-response")
	}))
	defer provider.Close()
	dir := t.TempDir()
	f := newFixture(t, provider, 0, func(c *gateway.Config) { c.Inspection.Dir = dir })
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write(body)
	_ = gz.Close()
	r, _ := http.NewRequest("POST", f.gateway.URL+"/proxy", &compressed)
	r.Header.Set("Content-Encoding", "gzip")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-DeltaRelay-Local-Token", localToken)
	r.Header.Set("X-DeltaRelay-Target", provider.URL+"/v1/responses?secret=query")
	r.Header.Set("X-DeltaRelay-Request-ID", "captured-request-0001")
	r.Header.Set("Authorization", "Bearer provider-secret")
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	snapshot := readDashboard(t, f.gateway.URL)
	if snapshot.Inspection == nil || !snapshot.Inspection.Enabled || snapshot.Inspection.Captures != 1 || snapshot.Inspection.UsedBytes <= 0 || len(snapshot.History.RecentRequests) != 1 {
		t.Fatalf("capture capability or usage missing: %+v", snapshot.Inspection)
	}
	retained := snapshot.History.RecentRequests[0]
	if retained.CaptureID == "" {
		t.Fatal("capture is not linked to request observation")
	}
	get := func(path string, token, origin string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest("GET", f.gateway.URL+path, nil)
		req.Header.Set("X-DeltaRelay-Local-Token", token)
		req.Header.Set("Origin", origin)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	path := "/inspection/" + retained.CaptureID
	code, data := get(path, localToken, "")
	var detail inspection.Detail
	if code != 200 || json.Unmarshal(data, &detail) != nil || detail.RequestID != retained.ID || detail.Sequence != retained.Sequence {
		t.Fatal("inspection identity mismatch")
	}
	code, data = get(path+"/artifacts/body/download", localToken, "")
	if code != 200 || !bytes.Equal(data, body) {
		t.Fatal("original view is not decoded source bytes")
	}
	for _, attempt := range detail.Attempts {
		if attempt.Operation != "dispatch" {
			continue
		}
		if attempt.Payload == nil || attempt.Payload.Representation != "redacted" {
			t.Fatal("dispatch projection not marked")
		}
		_, data = get(path+"/artifacts/"+attempt.Payload.ID+"/download", localToken, "")
		for _, secret := range []string{localToken, relayToken, "provider-secret", "secret=query", provider.URL, "private-provider-response"} {
			if bytes.Contains(data, []byte(secret)) {
				t.Fatalf("inspection leaked %s", secret)
			}
		}
	}
	for _, test := range []struct {
		token, origin string
		want          int
	}{{"", "", 401}, {localToken, "http://attacker.example", 403}} {
		if code, _ := get(path, test.token, test.origin); code != test.want {
			t.Fatal("inspection bypassed gateway authentication/origin policy")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("inspection sent additional provider requests")
	}
	files, _ := os.ReadDir(filepath.Join(dir, retained.CaptureID))
	for _, file := range files {
		data, _ := os.ReadFile(filepath.Join(dir, retained.CaptureID, file.Name()))
		if strings.Contains(string(data), "provider-secret") || strings.Contains(string(data), "secret=query") || strings.Contains(string(data), "private-provider-response") {
			t.Fatal("provider credential, target or response reached capture disk")
		}
	}
}

func TestInspectionIsOptInAndDisabledByDefault(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("disabled inspection attempted a provider request")
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	if snapshot := readDashboard(t, f.gateway.URL); snapshot.Inspection != nil {
		t.Fatalf("capture status exposed while disabled: %+v", snapshot.Inspection)
	}
	request, _ := http.NewRequest(http.MethodGet, f.gateway.URL+"/inspection/"+strings.Repeat("a", 32), nil)
	request.Header.Set("X-DeltaRelay-Local-Token", localToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusNotFound || !bytes.Contains(data, []byte("capture_disabled")) {
		t.Fatalf("disabled inspection route was not an inert 404: %d %s", response.StatusCode, data)
	}
}
