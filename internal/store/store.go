// Package store provides a durable, content-addressed filesystem store.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"deltarelay/internal/fsx"
	"deltarelay/internal/protocol"
)

var (
	ErrIntegrity        = errors.New("content integrity check failed")
	ErrUnavailableChunk = errors.New("chunk unavailable or corrupt")
	ErrQuota            = errors.New("persistent cache byte limit reached")
)

// syncDirectories is a test seam for exercising a rename that succeeds before
// a later directory-sync failure.
var syncDirectories = fsx.SyncDirChain

type Store struct {
	root      string
	mu        sync.Mutex
	maxBytes  int64
	usedBytes int64
}

func Open(root string) (*Store, error) {
	return OpenLimited(root, 0)
}

func OpenLimited(root string, maxBytes int64) (*Store, error) {
	if maxBytes < 0 {
		return nil, errors.New("negative cache limit")
	}
	// Remember newly created ancestors so even the first cache/journal use has
	// durable directory entries before a provider request can be dispatched.
	var created []string
	for current := filepath.Clean(root); ; current = filepath.Dir(current) {
		if _, err := os.Stat(current); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		created = append(created, current)
		if filepath.Dir(current) == current {
			break
		}
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	for i := len(created) - 1; i >= 0; i-- {
		if err := fsx.SyncDir(filepath.Dir(created[i])); err != nil {
			return nil, err
		}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	s := &Store{root: root, maxBytes: maxBytes}
	for _, kind := range []string{"chunks", "bodies"} {
		err := filepath.WalkDir(filepath.Join(root, kind), func(path string, entry os.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if !entry.IsDir() && protocol.ValidHash(entry.Name()) {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					return errors.New("non-regular cache object")
				}
				s.usedBytes += info.Size()
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	if maxBytes > 0 && s.usedBytes > maxBytes {
		return nil, ErrQuota
	}
	return s, nil
}

func (s *Store) Directory() string { return s.root }

func (s *Store) Usage() (int64, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usedBytes, s.maxBytes
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func (s *Store) persist(path string, size int64, write func(*os.File) error) error {
	before := fileSize(path)
	if s.maxBytes > 0 && size-before > s.maxBytes-s.usedBytes {
		return ErrQuota
	}
	err := atomicWrite(path, write)
	// Account even for a rename followed by an fsync failure. Such a write is
	// not acknowledged, but may already occupy space on disk.
	s.usedBytes += fileSize(path) - before
	return err
}

func (s *Store) path(kind, hash string) (string, error) {
	if !protocol.ValidHash(hash) {
		return "", errors.New("invalid SHA-256")
	}
	return filepath.Join(s.root, kind, hash[:2], hash), nil
}

// ReadChunk verifies bytes on every read, so disk corruption cannot be treated
// as a cache hit. Chunks are bounded by the protocol's maximum chunk size.
func (s *Store) ReadChunk(hash string, size int64) ([]byte, error) {
	if size <= 0 || size > protocol.MaxChunkSize {
		return nil, errors.New("invalid chunk size")
	}
	path, err := s.path("chunks", hash)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size || protocol.Sum(data) != hash {
		return nil, ErrIntegrity
	}
	return data, nil
}

func (s *Store) HasChunk(chunk protocol.Chunk) bool {
	_, err := s.ReadChunk(chunk.Hash, chunk.Size)
	return err == nil
}

func (s *Store) PutChunk(chunk protocol.Chunk, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if chunk.Size <= 0 || chunk.Size > protocol.MaxChunkSize || int64(len(data)) != chunk.Size || protocol.Sum(data) != chunk.Hash {
		return ErrIntegrity
	}
	if s.HasChunk(chunk) {
		return nil
	}
	path, err := s.path("chunks", chunk.Hash)
	if err != nil {
		return err
	}
	return s.persist(path, chunk.Size, func(f *os.File) error {
		_, err := f.Write(data)
		return err
	})
}

func (s *Store) Missing(m protocol.Manifest) []protocol.Chunk {
	missing := make([]protocol.Chunk, 0)
	seen := make(map[string]bool, len(m.Chunks))
	for _, chunk := range m.Chunks {
		if !seen[chunk.Hash] {
			seen[chunk.Hash] = true
			if !s.HasChunk(chunk) {
				missing = append(missing, chunk)
			}
		}
	}
	return missing
}

// Assemble publishes nothing until every chunk, the total byte count, and the
// complete body hash pass verification. Even an existing body is reverified.
func (s *Store) Assemble(m protocol.Manifest) error {
	return s.AssembleContext(context.Background(), m)
}

func (s *Store) AssembleContext(ctx context.Context, m protocol.Manifest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := m.Validate(protocol.DefaultMaxBodySize, protocol.DefaultMaxChunks); err != nil {
		return err
	}
	path, err := s.path("bodies", m.Hash)
	if err != nil {
		return err
	}
	return s.persist(path, m.Size, func(f *os.File) error { return s.writeManifest(ctx, f, m) })
}

func (s *Store) writeManifest(ctx context.Context, destination io.Writer, m protocol.Manifest) error {
	hash := sha256.New()
	writer := io.MultiWriter(destination, hash)
	var total int64
	for _, chunk := range m.Chunks {
		if err := ctx.Err(); err != nil {
			return err
		}
		data, err := s.ReadChunk(chunk.Hash, chunk.Size)
		if err != nil {
			return fmt.Errorf("read chunk %s: %w", chunk.Hash, errors.Join(ErrUnavailableChunk, err))
		}
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		total += int64(n)
	}
	if total != m.Size || hex.EncodeToString(hash.Sum(nil)) != m.Hash {
		return ErrIntegrity
	}
	return ctx.Err()
}

// Reconstruct returns a verified, rewound, anonymous temporary file. On Linux,
// unlinking immediately means even a killed server cannot leave body spools.
// Normal forwarding retains chunks, not a full copy of every conversation.
func (s *Store) Reconstruct(ctx context.Context, m protocol.Manifest) (*os.File, error) {
	if err := m.Validate(protocol.DefaultMaxBodySize, protocol.DefaultMaxChunks); err != nil {
		return nil, err
	}
	dir := filepath.Join(s.root, "spool")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, ".forward-*")
	if err != nil {
		return nil, err
	}
	if err := os.Remove(f.Name()); err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, errors.New("anonymous spool requires a POSIX filesystem")
	}
	if err := s.writeManifest(ctx, f, m); err != nil {
		f.Close()
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// OpenBody verifies the stored body before returning a rewound descriptor.
func (s *Store) OpenBody(hash string) (*os.File, int64, error) {
	path, err := s.path("bodies", hash)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, protocol.DefaultMaxBodySize+1))
	if err == nil && (n > protocol.DefaultMaxBodySize || hex.EncodeToString(h.Sum(nil)) != hash) {
		err = ErrIntegrity
	}
	if err == nil {
		_, err = f.Seek(0, io.SeekStart)
	}
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, n, nil
}

func atomicWrite(path string, write func(*os.File) error) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if err := fsx.Replace(path, write); err != nil {
		return err
	}
	// Persist directory entries before acknowledging the write. This also covers
	// newly created shard directories, not just the file's immediate parent.
	return syncDirectories(directory, 3)
}
