package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func TestRequestIDConflictsAcrossAPIsAndRestarts(t *testing.T) {
	for _, first := range []string{"legacy", "durable", "cancel-before-submit"} {
		t.Run(first, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				_, _ = io.WriteString(w, "original response")
			}))
			t.Cleanup(provider.Close)
			storage, err := store.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			config := Config{Store: storage, Token: "secret", Upstreams: []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/"}}, AllowPrivateUpstreams: true}
			h, err := New(config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(h.Close)
			body := []byte("verified original request")
			m := manifest(body)
			if err := storage.PutChunk(m.Chunks[0], body); err != nil {
				t.Fatal(err)
			}
			input := protocol.ForwardRequest{Version: protocol.RelayVersion, ID: "cross-api-request-0001", Target: provider.URL + "/responses", Method: http.MethodPost, Manifest: m}
			path := "/v2/requests/" + input.ID
			legacy := input
			legacy.Version = protocol.Version
			encoded, err := json.Marshal(legacy)
			if err != nil {
				t.Fatal(err)
			}
			wantCalls := int32(1)
			switch first {
			case "legacy":
				if w := request(h, "/v1/forward", "application/json", encoded, ""); w.Code != http.StatusOK {
					t.Fatalf("legacy claim: %d %s", w.Code, w.Body.String())
				}
			case "durable":
				if w := v2Request(t, h, http.MethodPut, path, input, h.mailbox.StateID()); w.Code != http.StatusAccepted {
					t.Fatalf("durable claim: %d %s", w.Code, w.Body.String())
				}
				if status := waitTerminal(t, h, input.ID); status.State != protocol.Completed {
					t.Fatalf("generation failed: %+v", status)
				}
			case "cancel-before-submit":
				wantCalls = 0
				if w := v2Request(t, h, http.MethodPost, path+"/cancel", nil, h.mailbox.StateID()); w.Code != http.StatusOK {
					t.Fatalf("cancellation: %d %s", w.Code, w.Body.String())
				}
			}
			identity := h.mailbox.StateID()
			for _, restarted := range []bool{false, true} {
				if restarted {
					h.Close()
					h, err = New(config)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(h.Close)
					if h.mailbox.StateID() != identity {
						t.Fatal("restart changed identity")
					}
				}
				if w := request(h, "/v1/forward", "application/json", encoded, ""); w.Code != http.StatusConflict {
					t.Fatalf("legacy replay (restarted=%v): %d %s", restarted, w.Code, w.Body.String())
				}
				wantStatus := http.StatusConflict
				if first == "durable" {
					wantStatus = http.StatusOK // Same durable operation remains readable, not regenerated.
				}
				if w := v2Request(t, h, http.MethodPut, path, input, identity); w.Code != wantStatus {
					t.Fatalf("durable replay (restarted=%v): %d %s", restarted, w.Code, w.Body.String())
				}
				if first == "durable" {
					for _, field := range []string{"target", "headers", "body"} {
						changed := input
						switch field {
						case "target":
							changed.Target += "?different=1"
						case "headers":
							changed.Headers = http.Header{"Authorization": []string{"Bearer synthetic-other-token"}}
						case "body":
							other := []byte("different verified request")
							changed.Manifest = manifest(other)
							if err := storage.PutChunk(changed.Manifest.Chunks[0], other); err != nil {
								t.Fatal(err)
							}
						}
						w := v2Request(t, h, http.MethodPut, path, changed, identity)
						var failure protocol.ErrorResponse
						if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil || w.Code != http.StatusConflict || failure.Code != "request_conflict" {
							t.Fatalf("changed %s (restarted=%v): %d %s", field, restarted, w.Code, w.Body.String())
						}
					}
				}
				if calls.Load() != wantCalls {
					t.Fatalf("replayed provider work (restarted=%v): got %d calls, want %d", restarted, calls.Load(), wantCalls)
				}
			}
		})
	}
}
