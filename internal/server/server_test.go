package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
)

func testServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(Config{Store: s, Token: "secret", MaxBodySize: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	return h, s
}

func request(h http.Handler, path, contentType string, body []byte, encoding string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer secret")
	r.Header.Set("Content-Type", contentType)
	if encoding != "" {
		r.Header.Set("Content-Encoding", encoding)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func manifest(data []byte) protocol.Manifest {
	return protocol.Manifest{Version: protocol.Version, Hash: protocol.Sum(data), Size: int64(len(data)), Chunks: []protocol.Chunk{{Hash: protocol.Sum(data), Size: int64(len(data))}}}
}

func batch(t *testing.T, chunks []protocol.Chunk, bodies [][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := protocol.WriteBatchHeader(&buffer, len(chunks)); err != nil {
		t.Fatal(err)
	}
	for i, chunk := range chunks {
		if err := protocol.WriteChunk(&buffer, chunk, bodies[i]); err != nil {
			t.Fatal(err)
		}
	}
	return buffer.Bytes()
}

func TestRejectsMissingChunksAndWrongWholeBodyHash(t *testing.T) {
	h, s := testServer(t)
	data := []byte("real content")
	m := manifest(data)
	encoded, _ := json.Marshal(m)
	if got := request(h, "/v1/assemble", "application/json", encoded, ""); got.Code != http.StatusConflict {
		t.Fatalf("missing chunks: HTTP %d", got.Code)
	}
	if err := s.PutChunk(m.Chunks[0], data); err != nil {
		t.Fatal(err)
	}
	m.Hash = protocol.Sum([]byte("not the actual reconstructed content"))
	encoded, _ = json.Marshal(m)
	if got := request(h, "/v1/assemble", "application/json", encoded, ""); got.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrong body hash: HTTP %d", got.Code)
	}
	if _, _, err := s.OpenBody(m.Hash); err == nil {
		t.Fatal("unverified body published")
	}
}

func TestCorruptTruncatedAndTrailingBatches(t *testing.T) {
	h, s := testServer(t)
	data := []byte("correct")
	chunk := protocol.Chunk{Hash: protocol.Sum(data), Size: int64(len(data))}
	corrupt := batch(t, []protocol.Chunk{chunk}, [][]byte{[]byte("WRONG!!")})
	if got := request(h, "/v1/chunks", protocol.BatchContentType, corrupt, ""); got.Code != http.StatusUnprocessableEntity {
		t.Fatalf("corrupt chunk: HTTP %d", got.Code)
	}
	if s.HasChunk(chunk) {
		t.Fatal("corrupt chunk persisted")
	}
	valid := batch(t, []protocol.Chunk{chunk}, [][]byte{data})
	if got := request(h, "/v1/chunks", protocol.BatchContentType, valid[:len(valid)-1], ""); got.Code != http.StatusBadRequest {
		t.Fatalf("truncated frame: HTTP %d", got.Code)
	}
	if got := request(h, "/v1/chunks", protocol.BatchContentType, append(bytes.Clone(valid), 42), ""); got.Code != http.StatusBadRequest {
		t.Fatalf("trailing data: HTTP %d", got.Code)
	}
	if got := request(h, "/v1/chunks", protocol.BatchContentType, valid, ""); got.Code != http.StatusOK {
		t.Fatalf("valid retry: HTTP %d", got.Code)
	}
	if got := request(h, "/v1/chunks", protocol.BatchContentType, valid, ""); got.Code != http.StatusOK {
		t.Fatal("chunk upload is not idempotent")
	}
}

func TestInterruptedBatchPreservesVerifiedChunksForRetry(t *testing.T) {
	h, s := testServer(t)
	a, b := []byte("first verified chunk"), []byte("second chunk interrupted")
	ca := protocol.Chunk{Hash: protocol.Sum(a), Size: int64(len(a))}
	cb := protocol.Chunk{Hash: protocol.Sum(b), Size: int64(len(b))}
	encoded := batch(t, []protocol.Chunk{ca, cb}, [][]byte{a, b})
	got := request(h, "/v1/chunks", protocol.BatchContentType, encoded[:len(encoded)-3], "")
	if got.Code != http.StatusBadRequest || !s.HasChunk(ca) || s.HasChunk(cb) {
		t.Fatal("interrupted batch did not preserve exactly its verified chunks")
	}
	if got := request(h, "/v1/chunks", protocol.BatchContentType, batch(t, []protocol.Chunk{cb}, [][]byte{b}), ""); got.Code != http.StatusOK {
		t.Fatal("could not resume missing chunk")
	}
}

func TestGzipChecksumAndManifestValidation(t *testing.T) {
	h, _ := testServer(t)
	data := []byte("hello gzip")
	m := manifest(data)
	encoded, _ := json.Marshal(m)
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write(encoded)
	_ = gz.Close()
	if got := request(h, "/v1/missing", "application/json", compressed.Bytes(), "gzip"); got.Code != http.StatusOK {
		t.Fatalf("valid gzip: HTTP %d", got.Code)
	}
	if got := request(h, "/v1/missing", "application/json", compressed.Bytes()[:compressed.Len()-4], "gzip"); got.Code == http.StatusOK {
		t.Fatal("truncated gzip accepted")
	}
	for _, body := range []string{string(encoded) + "{}", `{"version":1,"hash":"../outside","size":0,"chunks":[]}`, `{"version":1,"unknown":true}`} {
		if got := request(h, "/v1/missing", "application/json", []byte(body), ""); got.Code == http.StatusOK {
			t.Fatalf("invalid manifest accepted: %s", body)
		}
	}
	if got := request(h, "/v1/missing", "application/json", encoded, "br"); got.Code != http.StatusBadRequest {
		t.Fatal("unsupported content encoding accepted")
	}
	// Compress a manifest-sized bomb: the decoded size limit must still apply.
	compressed.Reset()
	gz = gzip.NewWriter(&compressed)
	_, _ = io.Copy(gz, strings.NewReader(strings.Repeat(" ", protocol.MaxManifestBytes+1)))
	_ = gz.Close()
	if got := request(h, "/v1/missing", "application/json", compressed.Bytes(), "gzip"); got.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("gzip bomb: HTTP %d", got.Code)
	}
}

func TestAuthenticationAndConcurrencyLimit(t *testing.T) {
	h, _ := testServer(t)
	r := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("authentication is optional")
	}
	for i := 0; i < cap(h.slots); i++ {
		h.slots <- struct{}{}
	}
	r = httptest.NewRequest(http.MethodGet, "/healthz", nil).WithContext(context.Background())
	r.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatal("concurrency limit ignored")
	}
}
