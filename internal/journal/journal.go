// Package journal durably claims logical request IDs before provider dispatch.
// It deliberately refuses replay rather than promise impossible exactly-once
// inference after an ambiguous disconnection or process crash.
package journal

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"deltarelay/internal/fsx"
	"deltarelay/internal/protocol"
)

var ErrUsed = errors.New("request ID already used; automatic replay refused")
var ErrFull = errors.New("request journal is full; increase its limit")

type Journal struct {
	directory    string
	mu           sync.Mutex
	count, limit int
}

func Open(directory string, limit int) (*Journal, error) {
	if limit < 1 {
		return nil, errors.New("journal limit must be positive")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err := fsx.SyncDir(filepath.Dir(directory)); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	j := &Journal{directory: directory, limit: limit}
	for _, entry := range entries {
		if !entry.IsDir() && protocol.ValidHash(entry.Name()) {
			j.count++
		}
	}
	return j, nil
}

func (j *Journal) Claim(id, fingerprint string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	path := filepath.Join(j.directory, protocol.Sum([]byte(id)))
	if _, err := os.Stat(path); err == nil {
		return ErrUsed
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if j.count >= j.limit {
		return ErrFull
	}
	data := struct {
		Fingerprint string `json:"fingerprint"`
		Created     int64  `json:"created_unix"`
	}{fingerprint, time.Now().Unix()}
	// Even an incomplete marker is kept: uncertain dispatch must not be retried.
	created, err := fsx.CreateExclusive(path, 0600, func(f *os.File) error {
		return json.NewEncoder(f).Encode(data)
	})
	if created {
		j.count++
	}
	if errors.Is(err, os.ErrExist) {
		return ErrUsed
	}
	if err != nil {
		return err
	}
	return fsx.SyncDir(j.directory)
}
