package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
	"deltarelay/testdata/contracts"
)

type fingerprintTransport func(*http.Request) (*http.Response, error)

func (f fingerprintTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Freeze persisted claims BEFORE sharing fingerprint construction in Phase 4.
// In particular: capitalized field names/order, HTML escaping, header cleaning,
// value order, nil header lists, and exclusion of IDs/API/manifest chunk layout.
func TestPersistedRequestFingerprintCompatibility(t *testing.T) {
	var fixtures []struct {
		Name, Body, Target, Representation, Digest string
		Headers                                    http.Header
	}
	if err := json.Unmarshal(contracts.Read(t, "fingerprints.json"), &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			headers := upstream.CleanHeaders(fixture.Headers)
			headers.Del("Content-Encoding")
			representation, err := json.Marshal(struct {
				Target  string
				Headers http.Header
				Hash    string
				Size    int64
			}{fixture.Target, headers, protocol.Sum([]byte(fixture.Body)), int64(len(fixture.Body))})
			if err != nil || string(representation) != fixture.Representation || protocol.Sum(representation) != fixture.Digest {
				t.Fatalf("fingerprint representation changed: %s (%v)", representation, err)
			}
			for _, api := range []string{"legacy", "durable"} {
				t.Run(api, func(t *testing.T) {
					storage, err := store.Open(t.TempDir())
					if err != nil {
						t.Fatal(err)
					}
					config := Config{Store: storage, Token: "secret", Upstreams: []upstream.Rule{{Name: "fixture", Origin: "https://api.example.test", PathPrefix: "/v1/"}}}
					h, err := New(config)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(h.Close)
					var calls atomic.Int32
					transport := fingerprintTransport(func(r *http.Request) (*http.Response, error) {
						calls.Add(1)
						data, err := io.ReadAll(r.Body)
						if err != nil || string(data) != fixture.Body {
							t.Errorf("provider body changed: %s (%v)", data, err)
						}
						return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("synthetic response"))}, nil
					})
					h.jobs.upstream = &http.Client{Transport: transport}
					for variant := 0; variant < 2; variant++ {
						body := []byte(fixture.Body)
						m := protocol.Manifest{Version: protocol.Version, Hash: protocol.Sum(body), Size: int64(len(body)), Chunks: []protocol.Chunk{}}
						parts := [][]byte{body}
						if variant == 1 && len(body) > 0 {
							parts = [][]byte{body[:len(body)/2], body[len(body)/2:]}
						}
						for _, part := range parts {
							if len(part) == 0 {
								continue
							}
							chunk := protocol.Chunk{Hash: protocol.Sum(part), Size: int64(len(part))}
							if err := storage.PutChunk(chunk, part); err != nil {
								t.Fatal(err)
							}
							m.Chunks = append(m.Chunks, chunk)
						}
						input := protocol.ForwardRequest{Version: protocol.Version, ID: fmt.Sprintf("fingerprint-request-%04d", variant), Target: fixture.Target, Method: http.MethodPost, Headers: fixture.Headers, Manifest: m}
						if api == "legacy" {
							encoded, err := json.Marshal(input)
							if err != nil {
								t.Fatal(err)
							}
							if w := request(h, "/v1/forward", "application/json", encoded, ""); w.Code != 200 {
								t.Fatalf("legacy: %d %s", w.Code, w.Body)
							}
						} else {
							input.Version = protocol.RelayVersion
							if w := v2Request(t, h, http.MethodPut, "/v2/requests/"+input.ID, input, h.mailbox.StateID()); w.Code != 202 {
								t.Fatalf("durable: %d %s", w.Code, w.Body)
							}
							if record := waitTerminal(t, h, input.ID); record.State != protocol.Completed || record.Fingerprint != fixture.Digest {
								t.Fatalf("mailbox fingerprint changed: %+v", record)
							}
						}
						path := filepath.Join(storage.Directory(), "requests", protocol.Sum([]byte(input.ID)))
						data, err := os.ReadFile(path)
						if err != nil {
							t.Fatal(err)
						}
						var claim struct {
							Fingerprint string `json:"fingerprint"`
						}
						if json.Unmarshal(data, &claim) != nil || claim.Fingerprint != fixture.Digest {
							t.Fatalf("persisted %s claim changed: %s", api, data)
						}
					}
					if calls.Load() != 2 {
						t.Fatalf("unexpected provider calls: %d", calls.Load())
					}
				})
			}
		})
	}
}
