// Package fsx provides small filesystem mechanics shared by DeltaRelay's
// durable stores. It deliberately does not offer a general-purpose "write file
// safely" helper: callers keep replacement, exclusive creation, publication,
// permission, symlink, and directory-durability policies explicit.
package fsx

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// SyncDir fsyncs a directory so that entry changes in it are durable.
func SyncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	err = f.Sync()
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

// SyncDirChain fsyncs path and up to levels-1 of its ancestors. It is used
// when a write may have created nested directories that also need durable
// entries, as with content-addressed shard directories.
func SyncDirChain(path string, levels int) error {
	if levels < 1 {
		return errors.New("directory sync depth must be positive")
	}
	for i := 0; i < levels; i++ {
		if err := SyncDir(path); err != nil {
			return err
		}
		parent := filepath.Dir(path)
		if parent == path {
			break
		}
		path = parent
	}
	return nil
}

// Replace atomically replaces path with content written by write. The temporary
// file lives in path's directory, is fsynced and closed, and is renamed over
// path. A failure before the rename leaves the previous path untouched and
// removes the temporary file. An existing path, including a symlink, is
// replaced as a directory entry and never followed.
//
// Replace does not create parent directories or sync the directory; callers
// choose when those additional durability steps are required.
func Replace(path string, write func(*os.File) error) error {
	directory := filepath.Dir(path)
	f, err := os.CreateTemp(directory, ".pending-*")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer os.Remove(temporary)
	defer f.Close()
	if err := write(f); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// WriteJSON atomically replaces path with one JSON value and then syncs its
// directory. It does not create parent directories. This is the shared
// mechanic for checkpoint, mailbox-record, statistics, and other metadata
// replacement; callers still decide whether replacing the path is allowed.
func WriteJSON(path string, value any) error {
	if err := Replace(path, func(f *os.File) error {
		return json.NewEncoder(f).Encode(value)
	}); err != nil {
		return err
	}
	return SyncDir(filepath.Dir(path))
}

// CreateExclusive creates path only if it does not already exist, invokes write,
// and fsyncs the file. It does not remove a partially written file: callers use
// it for durable claims whose uncertain existence must prevent replay. It does
// not sync the directory; callers do so after a successful return.
//
// The returned created flag reports whether the exclusive open succeeded, even
// if a subsequent write or sync failed. An existing path is reported through an
// error matching os.ErrExist.
func CreateExclusive(path string, perm os.FileMode, write func(*os.File) error) (created bool, err error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return false, err
	}
	defer f.Close()
	if err := write(f); err != nil {
		return true, err
	}
	if err := f.Sync(); err != nil {
		return true, err
	}
	if err := f.Close(); err != nil {
		return true, err
	}
	return true, nil
}
