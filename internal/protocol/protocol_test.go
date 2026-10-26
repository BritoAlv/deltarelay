package protocol

import (
	"bytes"
	"testing"
)

func TestManifestValidation(t *testing.T) {
	data := []byte("hello")
	valid := Manifest{Version: Version, Hash: Sum(data), Size: 5, Chunks: []Chunk{{Hash: Sum(data), Size: 5}}}
	if err := valid.Validate(DefaultMaxBodySize, DefaultMaxChunks); err != nil {
		t.Fatal(err)
	}
	cases := []Manifest{
		{Version: 99, Hash: Sum(nil)},
		{Version: Version, Hash: "../../outside"},
		{Version: Version, Hash: Sum(data), Size: -1},
		{Version: Version, Hash: Sum(data), Size: 6, Chunks: valid.Chunks},
		{Version: Version, Hash: Sum(data), Size: 0},
		{Version: Version, Hash: Sum(data), Size: 5, Chunks: []Chunk{{Hash: Sum(data), Size: 0}}},
		{Version: Version, Hash: Sum(data), Size: 7, Chunks: []Chunk{{Hash: Sum(data), Size: 5}, {Hash: Sum(data), Size: 2}}},
	}
	for i, manifest := range cases {
		if err := manifest.Validate(DefaultMaxBodySize, DefaultMaxChunks); err == nil {
			t.Fatalf("invalid manifest %d accepted", i)
		}
	}
	if err := valid.Validate(4, DefaultMaxChunks); err == nil {
		t.Fatal("body limit ignored")
	}
	if err := valid.Validate(DefaultMaxBodySize, 0); err == nil {
		t.Fatal("chunk count limit ignored")
	}
}

func TestBatchFraming(t *testing.T) {
	data := []byte("binary\x00chunk\xff")
	chunk := Chunk{Hash: Sum(data), Size: int64(len(data))}
	var buffer bytes.Buffer
	if err := WriteBatchHeader(&buffer, 1); err != nil {
		t.Fatal(err)
	}
	if err := WriteChunk(&buffer, chunk, data); err != nil {
		t.Fatal(err)
	}
	count, err := ReadBatchHeader(&buffer)
	if err != nil || count != 1 {
		t.Fatalf("batch header: %d %v", count, err)
	}
	got, body, err := ReadChunk(&buffer)
	if err != nil || got != chunk || !bytes.Equal(data, body) {
		t.Fatalf("chunk frame: %v", err)
	}
	if _, _, err := ReadChunk(bytes.NewReader([]byte("truncated"))); err == nil {
		t.Fatal("accepted truncated chunk")
	}
}

func FuzzManifestNeverPanics(f *testing.F) {
	f.Add("hash", int64(12), 1)
	f.Fuzz(func(t *testing.T, hash string, size int64, version int) {
		m := Manifest{Version: version, Hash: hash, Size: size, Chunks: []Chunk{{Hash: hash, Size: size}}}
		_ = m.Validate(DefaultMaxBodySize, DefaultMaxChunks)
	})
}
