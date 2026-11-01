// Package protocol defines the versioned delta-transfer wire format.
package protocol

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
)

const (
	Version             = 1
	MaxChunkSize        = 1 << 20
	DefaultMaxBodySize  = 256 << 20
	DefaultMaxChunks    = 65536
	MaxManifestBytes    = 8 << 20
	MaxUploadBatchBytes = 16 << 20
	MaxUploadBatchCount = 1024
	BatchContentType    = "application/vnd.deltarelay.chunks.v1"
	BatchMagic          = "DRLY0001"
	BatchHeaderSize     = len(BatchMagic) + 4
	ChunkHeaderSize     = sha256.Size + 4
	MaxHeaderBytes      = 64 << 10
)

// Chunk identifies immutable bytes. Size is the uncompressed byte count.
type Chunk struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

// Manifest describes a body exactly, including order and repeated chunks.
type Manifest struct {
	Version int     `json:"version"`
	Hash    string  `json:"hash"`
	Size    int64   `json:"size"`
	Chunks  []Chunk `json:"chunks"`
}

type MissingResponse struct {
	Missing []Chunk `json:"missing"`
}

type AssembleResponse struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

type UploadResponse struct {
	Chunks int   `json:"chunks"`
	Bytes  int64 `json:"bytes"`
}

type ErrorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// ForwardRequest carries only metadata and chunk references, never the full body.
// The provider's Authorization belongs in Headers; the relay bearer token does not.
type ForwardRequest struct {
	Version  int         `json:"version"`
	ID       string      `json:"id"`
	Target   string      `json:"target"`
	Method   string      `json:"method"`
	Headers  http.Header `json:"headers"`
	Manifest Manifest    `json:"manifest"`
}

func WriteBatchHeader(w io.Writer, count int) error {
	if count <= 0 || count > MaxUploadBatchCount {
		return errors.New("invalid batch chunk count")
	}
	var header [BatchHeaderSize]byte
	copy(header[:], BatchMagic)
	binary.BigEndian.PutUint32(header[len(BatchMagic):], uint32(count))
	_, err := w.Write(header[:])
	return err
}

func ReadBatchHeader(r io.Reader) (int, error) {
	var header [BatchHeaderSize]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, err
	}
	count := int(binary.BigEndian.Uint32(header[len(BatchMagic):]))
	if string(header[:len(BatchMagic)]) != BatchMagic || count <= 0 || count > MaxUploadBatchCount {
		return 0, errors.New("invalid batch header")
	}
	return count, nil
}

func WriteChunk(w io.Writer, chunk Chunk, data []byte) error {
	if !ValidHash(chunk.Hash) || chunk.Size <= 0 || chunk.Size > MaxChunkSize || int64(len(data)) != chunk.Size {
		return errors.New("invalid chunk frame")
	}
	var header [ChunkHeaderSize]byte
	hash, _ := hex.DecodeString(chunk.Hash)
	copy(header[:], hash)
	binary.BigEndian.PutUint32(header[sha256.Size:], uint32(chunk.Size))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err := w.Write(data)
	return err
}

func ReadChunk(r io.Reader) (Chunk, []byte, error) {
	var header [ChunkHeaderSize]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return Chunk{}, nil, err
	}
	size := int64(binary.BigEndian.Uint32(header[sha256.Size:]))
	if size <= 0 || size > MaxChunkSize {
		return Chunk{}, nil, errors.New("invalid chunk frame size")
	}
	chunk := Chunk{Hash: hex.EncodeToString(header[:sha256.Size]), Size: size}
	data := make([]byte, int(size))
	_, err := io.ReadFull(r, data)
	return chunk, data, err
}

func Sum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func ValidHash(hash string) bool {
	if len(hash) != sha256.Size*2 {
		return false
	}
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// ValidRequestID validates the opaque ID shared by legacy forwarding, durable
// submissions, receipts, and cancellation records. Telemetry labels are distinct.
func ValidRequestID(id string) bool {
	if len(id) < 16 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (m Manifest) Validate(maxBodySize int64, maxChunks int) error {
	if m.Version != Version {
		return fmt.Errorf("unsupported protocol version %d", m.Version)
	}
	if !ValidHash(m.Hash) {
		return errors.New("invalid body SHA-256")
	}
	if m.Size < 0 || m.Size > maxBodySize {
		return errors.New("body exceeds configured size limit")
	}
	if len(m.Chunks) > maxChunks {
		return errors.New("too many chunks")
	}
	var total int64
	sizes := make(map[string]int64, len(m.Chunks))
	for _, chunk := range m.Chunks {
		if !ValidHash(chunk.Hash) || chunk.Size <= 0 || chunk.Size > MaxChunkSize {
			return errors.New("invalid chunk hash or size")
		}
		if size, ok := sizes[chunk.Hash]; ok && size != chunk.Size {
			return errors.New("conflicting sizes for the same chunk")
		}
		sizes[chunk.Hash] = chunk.Size
		if chunk.Size > maxBodySize-total {
			return errors.New("chunks exceed configured body size limit")
		}
		total += chunk.Size
	}
	if total != m.Size {
		return errors.New("chunk lengths do not match body length")
	}
	if m.Size == 0 && m.Hash != Sum(nil) {
		return errors.New("invalid empty-body SHA-256")
	}
	return nil
}
