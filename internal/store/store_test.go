package store

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"deltarelay/internal/protocol"
)

func TestPersistenceReorderingAndIntegrity(t *testing.T) {
	directory := t.TempDir()
	s, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	a, b := []byte("first chunk"), []byte("second chunk")
	ca := protocol.Chunk{Hash: protocol.Sum(a), Size: int64(len(a))}
	cb := protocol.Chunk{Hash: protocol.Sum(b), Size: int64(len(b))}
	for _, item := range []struct {
		chunk protocol.Chunk
		data  []byte
	}{{ca, a}, {cb, b}} {
		if err := s.PutChunk(item.chunk, item.data); err != nil {
			t.Fatal(err)
		}
	}
	body := bytes.Join([][]byte{b, a, b}, nil)
	m := protocol.Manifest{Version: protocol.Version, Hash: protocol.Sum(body), Size: int64(len(body)), Chunks: []protocol.Chunk{cb, ca, cb}}
	restarted, err := Open(directory)
	if err != nil || len(restarted.Missing(m)) != 0 {
		t.Fatalf("cache did not survive reopening: %v", err)
	}
	if err := restarted.Assemble(m); err != nil {
		t.Fatal(err)
	}
	f, _, err := restarted.OpenBody(m.Hash)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(f)
	f.Close()
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("body bytes differ")
	}
	bad := m
	bad.Hash = protocol.Sum([]byte("different body"))
	if err := restarted.Assemble(bad); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("body hash mismatch accepted: %v", err)
	}
	if _, _, err := restarted.OpenBody(bad.Hash); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed reconstruction was published")
	}
	chunkPath := filepath.Join(directory, "chunks", ca.Hash[:2], ca.Hash)
	if err := os.WriteFile(chunkPath, bytes.Repeat([]byte("x"), len(a)), 0600); err != nil {
		t.Fatal(err)
	}
	if restarted.HasChunk(ca) {
		t.Fatal("corruption reported as cache hit")
	}
	if err := restarted.Assemble(m); !errors.Is(err, ErrUnavailableChunk) {
		t.Fatalf("corrupt chunk accepted: %v", err)
	}
	if err := restarted.PutChunk(ca, a); err != nil {
		t.Fatal(err)
	}
	if !restarted.HasChunk(ca) {
		t.Fatal("corrupt chunk was not repaired")
	}
	bodyPath := filepath.Join(directory, "bodies", m.Hash[:2], m.Hash)
	if err := os.WriteFile(bodyPath, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := restarted.OpenBody(m.Hash); !errors.Is(err, ErrIntegrity) {
		t.Fatal("corrupt stored body was served")
	}
}

func TestInvalidUploadsAndCanceledAssembly(t *testing.T) {
	s, _ := Open(t.TempDir())
	data := []byte("hello")
	chunk := protocol.Chunk{Hash: protocol.Sum(data), Size: int64(len(data))}
	if err := s.PutChunk(chunk, []byte("wrong")); !errors.Is(err, ErrIntegrity) {
		t.Fatal("chunk mismatch accepted")
	}
	if err := s.PutChunk(chunk, data); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m := protocol.Manifest{Version: protocol.Version, Hash: chunk.Hash, Size: chunk.Size, Chunks: []protocol.Chunk{chunk}}
	if err := s.AssembleContext(ctx, m); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", err)
	}
	if _, _, err := s.OpenBody("../outside"); err == nil {
		t.Fatal("invalid path accepted")
	}
}

func TestUsageAccountingSurvivesPostRenameSyncFailure(t *testing.T) {
	directory := t.TempDir()
	s, err := OpenLimited(directory, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected directory sync failure")
	original := syncDirectories
	syncDirectories = func(string, int) error { return failure }
	t.Cleanup(func() { syncDirectories = original })

	data := []byte("durable chunk")
	chunk := protocol.Chunk{Hash: protocol.Sum(data), Size: int64(len(data))}
	if err := s.PutChunk(chunk, data); !errors.Is(err, failure) {
		t.Fatalf("post-rename sync failure was not returned: %v", err)
	}
	if used, _ := s.Usage(); used != int64(len(data)) {
		t.Fatalf("rename followed by sync failure was not accounted: %d", used)
	}
	restarted, err := OpenLimited(directory, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if used, _ := restarted.Usage(); used != int64(len(data)) {
		t.Fatalf("reopened store lost accounted bytes: %d", used)
	}
}

func TestQuotaAndAnonymousReconstruction(t *testing.T) {
	directory := t.TempDir()
	s, err := OpenLimited(directory, 10)
	if err != nil {
		t.Fatal(err)
	}
	a, b := []byte("123456"), []byte("abcdef")
	ca := protocol.Chunk{Hash: protocol.Sum(a), Size: 6}
	cb := protocol.Chunk{Hash: protocol.Sum(b), Size: 6}
	if err := s.PutChunk(ca, a); err != nil {
		t.Fatal(err)
	}
	if err := s.PutChunk(cb, b); !errors.Is(err, ErrQuota) {
		t.Fatal("cache quota ignored")
	}
	m := protocol.Manifest{Version: protocol.Version, Hash: ca.Hash, Size: 6, Chunks: []protocol.Chunk{ca}}
	f, err := s.Reconstruct(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(got, a) {
		t.Fatal("anonymous reconstruction differs")
	}
	if _, err := os.Stat(f.Name()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("forward spool has a visible path")
	}
	if err := s.Assemble(m); !errors.Is(err, ErrQuota) {
		t.Fatal("diagnostic body bypassed quota")
	}
	restarted, err := OpenLimited(directory, 10)
	if err != nil {
		t.Fatal(err)
	}
	if used, limit := restarted.Usage(); used != 6 || limit != 10 {
		t.Fatalf("wrong durable usage: %d/%d", used, limit)
	}
}
