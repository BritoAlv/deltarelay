package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func TestForwardVerifiesBeforeDispatchAndClaimsSurviveRestart(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = fmt.Fprint(w, "verified response")
	}))
	defer provider.Close()
	storage, _ := store.Open(t.TempDir())
	config := Config{Store: storage, Token: "secret", Upstreams: []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/"}}, AllowPrivateUpstreams: true}
	h, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	body := []byte("expected body")
	m := manifest(body)
	if err := storage.PutChunk(m.Chunks[0], body); err != nil {
		t.Fatal(err)
	}
	input := protocol.ForwardRequest{Version: protocol.Version, ID: "logical-model-request-0001", Target: provider.URL + "/v1/responses", Method: http.MethodPost, Manifest: m}
	input.Manifest.Hash = protocol.Sum([]byte("wrong assembled body"))
	encoded, _ := json.Marshal(input)
	if got := request(h, "/v1/forward", "application/json", encoded, ""); got.Code != 422 || calls.Load() != 0 {
		t.Fatal("provider called before whole-body verification")
	}
	input.Manifest = m
	encoded, _ = json.Marshal(input)
	if got := request(h, "/v1/forward", "application/json", encoded, ""); got.Code != 200 || got.Body.String() != "verified response" || calls.Load() != 1 {
		t.Fatalf("valid forwarding failed: %d %s", got.Code, got.Body.String())
	}
	restarted, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.Close)
	if got := request(restarted, "/v1/forward", "application/json", encoded, ""); got.Code != 409 || calls.Load() != 1 {
		t.Fatal("restart replayed an already claimed request")
	}
}

func TestHeaderTimeoutDoesNotReplayGeneration(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	defer provider.Close()
	storage, _ := store.Open(t.TempDir())
	h, err := New(Config{Store: storage, Token: "secret", Upstreams: []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/"}}, AllowPrivateUpstreams: true, HeaderTimeout: 30 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	body := []byte("{}")
	m := manifest(body)
	if err := storage.PutChunk(m.Chunks[0], body); err != nil {
		t.Fatal(err)
	}
	input := protocol.ForwardRequest{Version: protocol.Version, ID: "header-timeout-request-0001", Target: provider.URL + "/v1/responses", Method: http.MethodPost, Manifest: m}
	encoded, _ := json.Marshal(input)
	if got := request(h, "/v1/forward", "application/json", encoded, ""); got.Code != 502 {
		t.Fatalf("header timeout: HTTP %d", got.Code)
	}
	if got := request(h, "/v1/forward", "application/json", encoded, ""); got.Code != 409 || calls.Load() != 1 {
		t.Fatal("timed out generation was replayed")
	}
}
