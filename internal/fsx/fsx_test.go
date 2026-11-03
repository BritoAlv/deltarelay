package fsx

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func pendingFiles(t *testing.T, directory string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(directory, ".pending-*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func TestReplaceAtomicallyReplacesMetadata(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.json")
	if err := os.WriteFile(path, []byte(`"old"`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(path, "new"); err != nil {
		t.Fatal(err)
	}
	var value string
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &value) != nil || value != "new" {
		t.Fatalf("replacement did not publish new metadata: %q %v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("replacement is not private: %v %v", info, err)
	}
	if leftover := pendingFiles(t, directory); len(leftover) != 0 {
		t.Fatalf("temporary files left after success: %v", leftover)
	}
}

func TestReplaceWriteFailureKeepsOldMetadataAndCleansTemporaryFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.json")
	if err := os.WriteFile(path, []byte(`"old"`), 0600); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected write failure")
	err := Replace(path, func(f *os.File) error {
		if _, err := f.Write([]byte(`"partial"`)); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("write failure was not returned: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != `"old"` {
		t.Fatalf("failed replacement changed existing metadata: %q %v", data, err)
	}
	if leftover := pendingFiles(t, directory); len(leftover) != 0 {
		t.Fatalf("temporary files left after write failure: %v", leftover)
	}
}

func TestReplaceRenameFailureKeepsDestinationAndCleansTemporaryFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "occupied")
	if err := os.MkdirAll(filepath.Join(path, "child"), 0700); err != nil {
		t.Fatal(err)
	}
	err := Replace(path, func(f *os.File) error {
		_, err := f.Write([]byte("replacement"))
		return err
	})
	if err == nil {
		t.Fatal("replacing a non-empty directory succeeded")
	}
	if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
		t.Fatalf("rename failure changed the destination: %v %v", info, statErr)
	}
	if leftover := pendingFiles(t, directory); len(leftover) != 0 {
		t.Fatalf("temporary files left after rename failure: %v", leftover)
	}
}

func TestReplaceDoesNotFollowExistingSymlink(t *testing.T) {
	directory := t.TempDir()
	victim := filepath.Join(directory, "victim")
	if err := os.WriteFile(victim, []byte("user work"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "state.json")
	if err := os.Symlink(victim, path); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(path, "replacement"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(victim)
	if err != nil || string(data) != "user work" {
		t.Fatalf("replacement followed and changed the symlink target: %q %v", data, err)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("symlink was not replaced as a directory entry: %v %v", info, err)
	}
}

func TestCreateExclusiveRetainsUncertainClaim(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "claim")
	failure := errors.New("injected write failure")
	created, err := CreateExclusive(path, 0600, func(f *os.File) error {
		if _, err := f.Write([]byte("partial claim")); err != nil {
			return err
		}
		return failure
	})
	if !created || !errors.Is(err, failure) {
		t.Fatalf("exclusive creation did not report the uncertain claim: created=%t err=%v", created, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "partial claim" {
		t.Fatalf("uncertain claim marker was removed or rewritten: %q %v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("claim marker is not private: %v %v", info, err)
	}
	created, err = CreateExclusive(path, 0600, func(*os.File) error { return nil })
	if created || !errors.Is(err, os.ErrExist) {
		t.Fatalf("existing claim was not refused: created=%t err=%v", created, err)
	}
}

func TestCreateExclusiveRefusesExistingSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	if err := os.WriteFile(target, []byte("user work"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "claim")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	created, err := CreateExclusive(path, 0600, func(*os.File) error { return nil })
	if created || !errors.Is(err, os.ErrExist) {
		t.Fatalf("symlinked claim was accepted: created=%t err=%v", created, err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "user work" {
		t.Fatalf("symlink target was changed: %q %v", data, err)
	}
}

func TestSyncDirectoryChainAndInvalidDepth(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "root", "shard")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := SyncDirChain(directory, 3); err != nil {
		t.Fatal(err)
	}
	if err := SyncDirChain(directory, 0); err == nil {
		t.Fatal("invalid sync depth was accepted")
	}
	if err := SyncDir(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing directory was reported as synced")
	}
}
