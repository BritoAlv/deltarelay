package client_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/server"
	"deltarelay/internal/store"
	"deltarelay/internal/transfer"
)

const token = "test-only-secret-token"

func fixture(t *testing.T, directory string) *httptest.Server {
	t.Helper()
	s, err := store.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	h, err := server.New(server.Config{Store: s, Token: token})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts
}

func newClient(t *testing.T, config client.Config) *client.Client {
	t.Helper()
	if config.Token == "" {
		config.Token = token
	}
	c, err := client.New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func data(size int) []byte {
	b := make([]byte, size)
	_, _ = rand.New(rand.NewSource(123)).Read(b)
	return b
}

func assertRoundTrip(t *testing.T, c *client.Client, body []byte) transfer.Stats {
	t.Helper()
	stats, err := c.Sync(context.Background(), bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if stats.Hash != protocol.Sum(body) || stats.BodyBytes != int64(len(body)) {
		t.Fatal("incorrect body hash or size")
	}
	output := filepath.Join(t.TempDir(), "verified-body")
	if err := c.Fetch(context.Background(), stats.Hash, output); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("reconstructed bytes differ")
	}
	return stats
}

func TestDeltaRoundTripAndRestart(t *testing.T) {
	directory := t.TempDir()
	ts := fixture(t, directory)
	c := newClient(t, client.Config{URL: ts.URL})
	original := data(3 << 20)
	cold := assertRoundTrip(t, c, original)
	if cold.UploadedChunkBytes != int64(len(original)) || cold.UploadedChunks < 2 {
		t.Fatal("cold synchronization did not upload all unique chunks")
	}
	warm := assertRoundTrip(t, c, original)
	if warm.UploadedChunks != 0 || warm.UploadedChunkBytes != 0 || warm.ReusedBodyBytes != int64(len(original)) {
		t.Fatal("unchanged body was reuploaded")
	}
	modified := append(bytes.Clone(original), []byte("new user message")...)
	appended := assertRoundTrip(t, c, modified)
	if appended.UploadedChunkBytes > 128<<10 || appended.RequestBodyBytesSent >= cold.RequestBodyBytesSent/5 {
		t.Fatalf("insufficient upload savings: cold=%+v appended=%+v", cold, appended)
	}
	t.Logf("cold: body=%d uploaded=%d encoded HTTP payload=%d; append: uploaded=%d encoded HTTP payload=%d", cold.BodyBytes, cold.UploadedChunkBytes, cold.RequestBodyBytesSent, appended.UploadedChunkBytes, appended.RequestBodyBytesSent)
	inserted := append(bytes.Clone(original[:12345]), []byte("inserted earlier message")...)
	inserted = append(inserted, original[12345:]...)
	edited := assertRoundTrip(t, c, inserted)
	if edited.UploadedChunkBytes > int64(len(original))/10 {
		t.Fatal("early insertion destroyed reuse")
	}
	// A fork/deletion and a compacted context are simply different exact bodies.
	assertRoundTrip(t, c, append(bytes.Clone(original[:1<<20]), []byte("different branch")...))
	assertRoundTrip(t, c, append([]byte("summary of older messages"), original[len(original)-(256<<10):]...))
	ts.Close()
	restarted := fixture(t, directory)
	c = newClient(t, client.Config{URL: restarted.URL})
	stats := assertRoundTrip(t, c, original)
	if stats.UploadedChunks != 0 {
		t.Fatal("restart lost persistent chunk cache")
	}
}

func TestEmptyBinaryRepeatedAndUncompressedBodies(t *testing.T) {
	ts := fixture(t, t.TempDir())
	for _, noCompression := range []bool{false, true} {
		c := newClient(t, client.Config{URL: ts.URL, NoCompression: noCompression})
		for _, body := range [][]byte{nil, {0, 1, 255, 0, 128}, bytes.Repeat([]byte("same content"), 50000)} {
			assertRoundTrip(t, c, body)
		}
	}
}

func TestUploadBudgetAndAuthentication(t *testing.T) {
	ts := fixture(t, t.TempDir())
	zero := int64(0)
	c := newClient(t, client.Config{URL: ts.URL, MaxUploadBytes: &zero})
	body := data(128 << 10)
	stats, err := c.Sync(context.Background(), bytes.NewReader(body))
	if err == nil || stats.UploadedChunkBytes != 0 || stats.Requests != 1 {
		t.Fatal("upload budget did not fail before upload")
	}
	assertRoundTrip(t, newClient(t, client.Config{URL: ts.URL}), body)
	if stats := assertRoundTrip(t, c, body); stats.UploadedChunks != 0 {
		t.Fatal("cache-only synchronization uploaded content")
	}
	bad := newClient(t, client.Config{URL: ts.URL, Token: "wrong-token"})
	_, err = bad.Sync(context.Background(), bytes.NewReader(body))
	var httpErr *client.HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusUnauthorized {
		t.Fatalf("authentication failure not surfaced: %v", err)
	}
}

func TestCanceledAndOversizedInput(t *testing.T) {
	ts := fixture(t, t.TempDir())
	c := newClient(t, client.Config{URL: ts.URL, MaxBodySize: 100})
	_, err := c.Sync(context.Background(), bytes.NewReader(data(101)))
	if err == nil {
		t.Fatal("oversized input accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = c.Sync(ctx, bytes.NewReader([]byte("test")))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not propagated: %v", err)
	}
}

func TestRedirectIsNotFollowedAndDownloadNeverOverwrites(t *testing.T) {
	var contacted atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { contacted.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	c := newClient(t, client.Config{URL: redirect.URL})
	if _, err := c.Sync(context.Background(), bytes.NewReader([]byte("test"))); err == nil || contacted.Load() != 0 {
		t.Fatal("redirect followed")
	}
	ts := fixture(t, t.TempDir())
	c = newClient(t, client.Config{URL: ts.URL})
	body := []byte("verified body")
	stats := assertRoundTrip(t, c, body)
	output := filepath.Join(t.TempDir(), "existing")
	if err := os.WriteFile(output, []byte("user work"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.Fetch(context.Background(), stats.Hash, output); err == nil {
		t.Fatal("existing output overwritten")
	}
	got, _ := os.ReadFile(output)
	if string(got) != "user work" {
		t.Fatal("existing output changed")
	}
}

func TestRemotePlaintextRequiresOptIn(t *testing.T) {
	if _, err := client.New(client.Config{URL: "http://example.com:8787", Token: token}); err == nil {
		t.Fatal("non-loopback plaintext accepted")
	}
}

func TestCorruptRemoteChunkIsReuploaded(t *testing.T) {
	directory := t.TempDir()
	ts := fixture(t, directory)
	spools := t.TempDir()
	c := newClient(t, client.Config{URL: ts.URL, TempDir: spools})
	body := data(512 << 10)
	assertRoundTrip(t, c, body)
	corrupted := false
	err := filepath.WalkDir(filepath.Join(directory, "chunks"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && !corrupted {
			corrupted = true
			return os.WriteFile(path, []byte("disk corruption"), 0600)
		}
		return nil
	})
	if err != nil || !corrupted {
		t.Fatalf("could not create corruption fixture: %v", err)
	}
	stats := assertRoundTrip(t, c, body)
	if stats.UploadedChunks != 1 {
		t.Fatalf("expected exactly one repaired chunk, got %d", stats.UploadedChunks)
	}
	entries, err := os.ReadDir(spools)
	if err != nil || len(entries) != 0 {
		t.Fatal("local plaintext spools were not cleaned up")
	}
}

func TestConcurrentSyncsAndHTTPS(t *testing.T) {
	storage, _ := store.Open(t.TempDir())
	handler, _ := server.New(server.Config{Store: storage, Token: token, MaxConcurrent: 32})
	t.Cleanup(handler.Close)
	ts := httptest.NewTLSServer(handler)
	defer ts.Close()
	c := newClient(t, client.Config{URL: ts.URL, HTTPClient: ts.Client(), Workers: 2})
	body := data(256 << 10)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			stats, err := c.Sync(context.Background(), bytes.NewReader(body))
			if err != nil || stats.Hash != protocol.Sum(body) {
				t.Errorf("concurrent synchronization: %v", err)
			}
		}()
	}
	wg.Wait()
	if stats := assertRoundTrip(t, c, body); stats.UploadedChunks != 0 {
		t.Fatal("concurrent uploads did not persist cache")
	}
}

func TestUntrustedInventoryAndAcknowledgmentFailClosed(t *testing.T) {
	for _, mode := range []string{"unknown-chunk", "wrong-ack"} {
		t.Run(mode, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/info":
					_ = json.NewEncoder(w).Encode(protocol.Info{Version: 2, ChunkVersion: 1, StateID: protocol.Sum([]byte("test-state")), Capabilities: []string{"durable-mailbox", "idempotent-submit", "response-offsets", "body-ranges", "explicit-cancel", "receipt-ack"}})
				case "/missing":
					missing := []protocol.Chunk{}
					if mode == "unknown-chunk" {
						missing = append(missing, protocol.Chunk{Hash: protocol.Sum([]byte("not in request")), Size: 14})
					}
					_ = json.NewEncoder(w).Encode(protocol.MissingResponse{Missing: missing})
				case "/assemble":
					_ = json.NewEncoder(w).Encode(protocol.AssembleResponse{Hash: protocol.Sum([]byte("wrong body")), Size: 10})
				default:
					t.Error("unexpected upload or bypass request")
				}
			}))
			defer ts.Close()
			c := newClient(t, client.Config{URL: ts.URL})
			if _, err := c.Sync(context.Background(), bytes.NewReader([]byte("expected body"))); err == nil {
				t.Fatal("untrusted response accepted")
			}
		})
	}
}
