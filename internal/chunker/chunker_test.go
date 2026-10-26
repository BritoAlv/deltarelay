package chunker

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"testing"

	"deltarelay/internal/protocol"
)

func randomBytes(n int) []byte {
	data := make([]byte, n)
	_, _ = rand.New(rand.NewSource(42)).Read(data)
	return data
}

func split(t *testing.T, r io.Reader) [][]byte {
	t.Helper()
	var chunks [][]byte
	if err := Split(r, DefaultConfig(), func(data []byte) error {
		chunks = append(chunks, bytes.Clone(data))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return chunks
}

func TestRoundTripAndBoundaries(t *testing.T) {
	for _, n := range []int{0, 1, DefaultMin - 1, DefaultMax, 3 << 20} {
		data := randomBytes(n)
		chunks := split(t, bytes.NewReader(data))
		if !bytes.Equal(bytes.Join(chunks, nil), data) {
			t.Fatalf("round trip failed for %d bytes", n)
		}
		for i, chunk := range chunks {
			if len(chunk) > DefaultMax || (i < len(chunks)-1 && len(chunk) < DefaultMin) {
				t.Fatalf("invalid chunk size %d", len(chunk))
			}
		}
	}
}

type smallReader struct{ io.Reader }

func (r smallReader) Read(p []byte) (int, error) {
	return r.Reader.Read(p[:min(37, len(p))])
}

func TestReadBoundariesDoNotAffectChunks(t *testing.T) {
	data := randomBytes(1 << 20)
	a := split(t, bytes.NewReader(data))
	b := split(t, smallReader{bytes.NewReader(data)})
	if len(a) != len(b) {
		t.Fatal("reader buffering changed chunk boundaries")
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			t.Fatalf("chunk %d differs", i)
		}
	}
}

func TestInsertionResynchronizes(t *testing.T) {
	original := randomBytes(4 << 20)
	known := make(map[string]bool)
	for _, chunk := range split(t, bytes.NewReader(original)) {
		known[protocol.Sum(chunk)] = true
	}
	modified := append(bytes.Clone(original[:12345]), []byte("a new message inserted near the beginning")...)
	modified = append(modified, original[12345:]...)
	var reused int
	for _, chunk := range split(t, bytes.NewReader(modified)) {
		if known[protocol.Sum(chunk)] {
			reused += len(chunk)
		}
	}
	if reused < len(original)*9/10 {
		t.Fatalf("insertion invalidated too much data: reused %d/%d", reused, len(original))
	}
}

func TestInvalidConfigAndCallbackFailure(t *testing.T) {
	if err := Split(bytes.NewReader(nil), Config{Min: 10, Avg: 11, Max: 20}, func([]byte) error { return nil }); err == nil {
		t.Fatal("accepted non-power-of-two average")
	}
	want := errors.New("callback failure")
	if err := Split(bytes.NewReader([]byte("hello")), DefaultConfig(), func([]byte) error { return want }); !errors.Is(err, want) {
		t.Fatalf("callback error lost: %v", err)
	}
}

func FuzzRoundTrip(f *testing.F) {
	f.Add([]byte("a conversation"))
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 2<<20 {
			t.Skip()
		}
		chunks := split(t, bytes.NewReader(data))
		if !bytes.Equal(bytes.Join(chunks, nil), data) {
			t.Fatal("reconstruction differs")
		}
	})
}

func BenchmarkSplit(b *testing.B) {
	data := randomBytes(8 << 20)
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	for b.Loop() {
		if err := Split(bytes.NewReader(data), DefaultConfig(), func([]byte) error { return nil }); err != nil {
			b.Fatal(err)
		}
	}
}
