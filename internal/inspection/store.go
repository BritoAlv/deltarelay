package inspection

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"deltarelay/internal/fsx"
	"deltarelay/internal/protocol"
)

type entry struct {
	capture *Capture
	created time.Time
	active  bool
	bytes   int64
	writing bool
}

type Store struct {
	mu      sync.Mutex
	config  Config
	entries map[string]*entry
	bytes   int64
	failed  atomic.Bool
	lock    *os.File
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Open owns a dedicated private directory. It refuses foreign entries rather
// than silently adopting or deleting user files. Empty Dir disables capture.
func Open(config Config) (_ *Store, openErr error) {
	if config.Dir == "" {
		return nil, nil
	}
	if config.MaxBytes == 0 {
		config.MaxBytes = DefaultMaxBytes
	}
	if config.MaxCaptureBytes == 0 {
		config.MaxCaptureBytes = DefaultMaxCaptureBytes
	}
	if config.MaxCaptures == 0 {
		config.MaxCaptures = DefaultMaxCaptures
	}
	if config.MaxAge == 0 {
		config.MaxAge = DefaultMaxAge
	}
	if config.MaxBytes < 1 || config.MaxBytes > 1<<40 || config.MaxCaptureBytes < 1 || config.MaxCaptureBytes > 1<<30 || config.MaxCaptureBytes > config.MaxBytes || config.MaxCaptures < 1 || config.MaxCaptures > 1000 || config.MaxAge < time.Second {
		return nil, errors.New("invalid inspection retention limits")
	}
	if err := os.MkdirAll(config.Dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(config.Dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("inspection directory must be a private, non-symlink directory")
	}
	lock, err := os.OpenFile(filepath.Join(config.Dir, ".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	defer func() {
		if openErr != nil {
			_ = lock.Close()
		}
	}()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.New("inspection directory is already owned by another gateway")
	}
	s := &Store{config: config, entries: map[string]*entry{}, lock: lock, stop: make(chan struct{}), done: make(chan struct{})}
	files, err := os.ReadDir(config.Dir)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		if f.Name() == ".lock" {
			continue
		}
		if !validID(f.Name()) || !f.IsDir() {
			return nil, errors.New("unexpected entry in inspection directory")
		}
		capture, size, err := s.load(f.Name())
		if errors.Is(err, errUncommittedCapture) {
			continue
		}
		if err != nil {
			return nil, err
		}
		s.entries[f.Name()] = &entry{capture: capture, created: capture.data.StartedAt, bytes: size}
		s.bytes += size
	}
	s.prune(time.Now(), 0, 0)
	go s.run()
	return s, nil
}

func privateFile(path string, max int64) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > max {
		_ = f.Close()
		return nil, errors.New("unsafe inspection file")
	}
	return f, nil
}

var errUncommittedCapture = errors.New("uncommitted inspection capture")

func (s *Store) load(id string) (*Capture, int64, error) {
	dir := filepath.Join(s.config.Dir, id)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, 0, errors.New("unsafe inspection directory")
	}
	f, err := privateFile(filepath.Join(dir, "capture.json"), maxMetadataBytes)
	if errors.Is(err, os.ErrNotExist) {
		// A crash can occur after Mkdir but before the initial checkpoint is
		// renamed into place. No artifact can exist without that checkpoint.
		// Remove only an empty/private-temporary directory; otherwise refuse it.
		files, readErr := os.ReadDir(dir)
		if readErr != nil {
			return nil, 0, readErr
		}
		for _, file := range files {
			if !strings.HasPrefix(file.Name(), ".pending-") {
				return nil, 0, errors.New("capture directory has no metadata")
			}
		}
		for _, file := range files {
			if err := os.Remove(filepath.Join(dir, file.Name())); err != nil {
				return nil, 0, err
			}
		}
		if err := os.Remove(dir); err != nil {
			return nil, 0, err
		}
		return nil, 0, errUncommittedCapture
	}
	if err != nil {
		return nil, 0, err
	}
	var t Trace
	d := json.NewDecoder(io.LimitReader(f, maxMetadataBytes+1))
	err = d.Decode(&t)
	var extra any
	trailing := d.Decode(&extra)
	_ = f.Close()
	if err != nil || trailing != io.EOF || t.Version != 1 || t.ID != id || t.Body.ID != "body" || t.StartedAt.IsZero() || len(t.Chunks) > 65536 || len(t.Attempts) > maxEvents || len(t.Inventories) > maxEvents {
		return nil, 0, errors.New("invalid inspection metadata")
	}
	if err := validateTrace(t); err != nil {
		return nil, 0, err
	}
	allowed := map[string]bool{"capture.json": true, "body.bin": true}
	for index, a := range t.Attempts {
		if a.Index != index || a.Payload != nil && a.Payload.ID != attemptArtifact(index) ||
			a.DecodedBytes < 0 || a.PreparedBytes < 0 || a.ConsumedBytes < 0 || a.ConsumedBytes > a.PreparedBytes || a.Status < 0 || a.Status > 599 {
			return nil, 0, errors.New("invalid inspection attempt")
		}
		if a.Payload != nil {
			allowed[a.Payload.ID+".bin"] = true
		}
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0, err
	}
	var size, metadataBytes int64
	sizes := map[string]int64{}
	for _, file := range files {
		// Atomic metadata writes can leave a private temporary after a crash.
		pending := strings.HasPrefix(file.Name(), ".pending-")
		orphan := strings.HasPrefix(file.Name(), "attempt-") && strings.HasSuffix(file.Name(), ".bin") && decimal(strings.TrimSuffix(strings.TrimPrefix(file.Name(), "attempt-"), ".bin"), maxEvents-1)
		if !allowed[file.Name()] && !pending && !orphan {
			return nil, 0, errors.New("unexpected file in inspection capture")
		}
		f, err := privateFile(filepath.Join(dir, file.Name()), 1<<30)
		if err != nil {
			return nil, 0, err
		}
		i, err := f.Stat()
		_ = f.Close()
		if err != nil {
			return nil, 0, err
		}
		if pending {
			if err := os.Remove(filepath.Join(dir, file.Name())); err != nil {
				return nil, 0, err
			}
			continue
		}
		size += i.Size()
		sizes[file.Name()] = i.Size()
		if file.Name() == "capture.json" {
			metadataBytes = i.Size()
		}
	}
	// A crash can leave a file shorter than its last checkpoint claimed. Expose
	// only bytes that actually exist, and mark the artifact as incomplete instead
	// of serving or describing bytes that are not present.
	short := func(a *Artifact) bool {
		if a == nil || a.CapturedBytes == 0 {
			return false
		}
		actual, ok := sizes[a.ID+".bin"]
		if ok && actual >= a.CapturedBytes {
			return false
		}
		if ok {
			a.CapturedBytes = actual
		} else {
			a.CapturedBytes = 0
		}
		a.Truncated, a.WriteError = true, true
		t.StorageError = true
		return true
	}
	short(&t.Body)
	for i := range t.Attempts {
		short(t.Attempts[i].Payload)
	}
	if t.State == "running" {
		now := time.Now().UTC()
		t.State, t.FinishedAt = "interrupted", &now
		for i := range t.Attempts {
			if t.Attempts[i].FinishedAt == nil {
				t.Attempts[i].Outcome = "interrupted"
			}
		}
	}
	c := &Capture{store: s, data: t, revision: 1, metadataBytes: metadataBytes}
	// Bytes written after the last metadata checkpoint are not silently claimed.
	// Only the recorded prefix is exposed, and a restart is explicitly visible.
	return c, size, nil
}

func validArtifact(a Artifact) bool {
	if a.SourceBytes < 0 || a.CapturedBytes < 0 || a.CapturedBytes > a.SourceBytes {
		return false
	}
	if a.Representation != "captured" && a.Representation != "redacted" {
		return false
	}
	if a.Encoding != "identity" && a.Encoding != "gzip" {
		return false
	}
	return a.SHA256 == "" || len(a.SHA256) == 64 && protocol.ValidHash(a.SHA256)
}

func validProtocolChunk(c protocol.Chunk) bool {
	return protocol.ValidHash(c.Hash) && c.Size > 0 && c.Size <= protocol.MaxChunkSize
}

func validateTrace(t Trace) error {
	if t.State != "running" && t.State != "completed" && t.State != "failed" && t.State != "cancelled" && t.State != "interrupted" {
		return errors.New("invalid inspection state")
	}
	if (t.State == "running") != (t.FinishedAt == nil) {
		return errors.New("inspection state and finish time disagree")
	}
	if !validArtifact(t.Body) || t.Body.Representation != "captured" || t.Body.Encoding != "identity" || t.Body.Complete && t.Body.SHA256 == "" {
		return errors.New("invalid inspection body artifact")
	}
	var offset int64
	for index, c := range t.Chunks {
		if c.Index != index || c.Offset != offset || !validProtocolChunk(protocol.Chunk{Hash: c.Hash, Size: c.Size}) {
			return errors.New("invalid inspection chunk range")
		}
		offset += c.Size
	}
	for index, inv := range t.Inventories {
		if inv.Index != index || (inv.Kind != "initial" && inv.Kind != "recovery") || inv.ObservedAt.IsZero() || len(inv.StateID) > 128 {
			return errors.New("invalid inspection inventory")
		}
		for _, c := range append(append([]protocol.Chunk{}, inv.Scope...), inv.Missing...) {
			if !validProtocolChunk(c) {
				return errors.New("invalid inspection inventory chunk")
			}
		}
	}
	for index, a := range t.Attempts {
		if a.Index != index || a.StartedAt.IsZero() || a.DecodedBytes < 0 || a.PreparedBytes < 0 || a.ConsumedBytes < 0 || a.ConsumedBytes > a.PreparedBytes || a.Status < 0 || a.Status > 599 || len(a.Path) > 512 {
			return errors.New("invalid inspection attempt")
		}
		if a.Payload != nil && (!validArtifact(*a.Payload) || a.Payload.ID != attemptArtifact(index)) {
			return errors.New("invalid inspection attempt payload")
		}
		for _, c := range a.Chunks {
			if !validProtocolChunk(c) {
				return errors.New("invalid inspection attempt chunk")
			}
		}
	}
	return nil
}

func (s *Store) Status() Status {
	if s == nil {
		return Status{}
	}
	s.mu.Lock()
	captures, used := len(s.entries), s.bytes
	s.mu.Unlock()
	return Status{Enabled: true, MaxBytes: s.config.MaxBytes, MaxCaptureBytes: s.config.MaxCaptureBytes, MaxCaptures: s.config.MaxCaptures, MaxAgeSeconds: int64(s.config.MaxAge / time.Second), Captures: captures, UsedBytes: used, StorageError: s.failed.Load()}
}

func (s *Store) Begin(requestID string, sequence uint64, contentType string) *Capture {
	if s == nil {
		return nil
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		s.failed.Store(true)
		return nil
	}
	id := hex.EncodeToString(random[:])
	s.prune(time.Now(), 1, 0)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.entries) >= s.config.MaxCaptures || s.bytes >= s.config.MaxBytes {
		s.failed.Store(true)
		return nil
	}
	if err := os.Mkdir(filepath.Join(s.config.Dir, id), 0700); err != nil {
		s.failed.Store(true)
		return nil
	}
	if len(contentType) > 256 {
		contentType = ""
	}
	c := &Capture{store: s, revision: 1, data: Trace{Version: 1, ID: id, RequestID: requestID, Sequence: sequence, StartedAt: time.Now().UTC(), State: "running", Body: Artifact{ID: "body", Representation: "captured", ContentType: contentType, Encoding: "identity"}, Chunks: []Chunk{}, Inventories: []Inventory{}, Attempts: []Attempt{}}}
	// Publish a valid interrupted-capture checkpoint before writing artifacts.
	// Later checkpoints are coalesced off the forwarding path.
	data, err := json.Marshal(c.data)
	if err == nil && int64(len(data)) <= s.config.MaxCaptureBytes && s.bytes+int64(len(data)) <= s.config.MaxBytes {
		err = fsx.WriteJSON(filepath.Join(s.config.Dir, id, "capture.json"), c.data)
	} else if err == nil {
		err = errors.New("inspection metadata budget exceeded")
	}
	if err != nil {
		s.failed.Store(true)
		_ = os.Remove(filepath.Join(s.config.Dir, id, "capture.json"))
		_ = os.Remove(filepath.Join(s.config.Dir, id))
		return nil
	}
	c.metadataBytes = int64(len(data) + 1) // WriteJSON includes a trailing newline.
	s.entries[id] = &entry{capture: c, created: c.data.StartedAt, active: true, bytes: c.metadataBytes}
	s.bytes += c.metadataBytes
	return c
}

func (s *Store) get(id string) (*Capture, bool) {
	if s == nil || !validID(id) {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	if !ok || !e.active && time.Since(e.created) > s.config.MaxAge {
		return nil, false
	}
	return e.capture, true
}

// reserve bounds artifact bytes before every write. Capture limits leave the
// real transfer untouched and preserve only a contiguous, labeled prefix.
func (s *Store) reserve(id string, n int64) int64 {
	s.mu.Lock()
	e := s.entries[id]
	if e == nil {
		s.mu.Unlock()
		return 0
	}
	captureLimit := s.config.MaxCaptureBytes - min(int64(maxMetadataBytes), s.config.MaxCaptureBytes/4)
	want := min(n, max(0, captureLimit-e.bytes))
	s.mu.Unlock()
	headroom := min(int64(maxMetadataBytes), s.config.MaxBytes/4)
	s.prune(time.Now(), 0, want+headroom)
	s.mu.Lock()
	defer s.mu.Unlock()
	e = s.entries[id]
	if e == nil {
		return 0
	}
	// Leave bounded headroom for the final evidence index, even when body/payload
	// capture exhausts its quota. That index must still describe the truncation.
	storeLimit := s.config.MaxBytes - min(int64(maxMetadataBytes), s.config.MaxBytes/4)
	n = min(n, max(0, captureLimit-e.bytes), max(0, storeLimit-s.bytes))
	e.bytes += n
	s.bytes += n
	return n
}

func (s *Store) accountMetadata(id string, size int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.entries[id]; e != nil {
		delta := size - e.capture.metadataBytes
		if delta > 0 && (e.bytes+delta > s.config.MaxCaptureBytes || s.bytes+delta > s.config.MaxBytes) {
			return false
		}
		e.capture.metadataBytes = size
		e.bytes += delta
		s.bytes += delta
		return true
	}
	return false
}

func (s *Store) prune(now time.Time, additional int, needed int64) {
	s.mu.Lock()
	var candidates []*entry
	for _, e := range s.entries {
		if !e.active && !e.writing {
			candidates = append(candidates, e)
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].created.Before(candidates[j].created) })
	var removed []string
	for _, e := range candidates {
		if now.Sub(e.created) <= s.config.MaxAge && len(s.entries)+additional <= s.config.MaxCaptures && s.bytes+needed <= s.config.MaxBytes {
			break
		}
		id := e.capture.data.ID
		delete(s.entries, id)
		s.bytes -= e.bytes
		e.capture.evicted.Store(true)
		removed = append(removed, id)
	}
	s.mu.Unlock()
	for _, id := range removed {
		dir := filepath.Join(s.config.Dir, id)
		files, err := os.ReadDir(dir)
		if err != nil {
			s.failed.Store(true)
			continue
		}
		for _, f := range files {
			// Only files inside an exact, owned capture directory are removed.
			if err := os.Remove(filepath.Join(dir, f.Name())); err != nil {
				s.failed.Store(true)
			}
		}
		if err := os.Remove(dir); err != nil {
			s.failed.Store(true)
		}
	}
}

func (s *Store) flush() {
	s.mu.Lock()
	var captures []*Capture
	for _, e := range s.entries {
		captures = append(captures, e.capture)
	}
	s.mu.Unlock()
	for _, c := range captures {
		s.mu.Lock()
		e := s.entries[c.data.ID]
		if e == nil {
			s.mu.Unlock()
			continue
		}
		e.writing = true
		s.mu.Unlock()
		c.mu.Lock()
		if c.revision == c.written || c.evicted.Load() {
			c.mu.Unlock()
			s.mu.Lock()
			e.writing = false
			s.mu.Unlock()
			continue
		}
		data, err := json.Marshal(c.data)
		revision := c.revision
		c.mu.Unlock()
		if err == nil && len(data) <= maxMetadataBytes && s.accountMetadata(c.data.ID, int64(len(data)+1)) {
			err = fsx.Replace(filepath.Join(s.config.Dir, c.data.ID, "capture.json"), func(f *os.File) error { _, err := f.Write(data); return err })
		} else if err == nil {
			err = errors.New("inspection metadata exceeds limit")
		}
		c.mu.Lock()
		if err != nil {
			c.data.StorageError = true
			s.failed.Store(true)
		} else {
			c.written = revision
		}
		c.mu.Unlock()
		s.mu.Lock()
		e.writing = false
		s.mu.Unlock()
	}
}

func (s *Store) run() {
	defer close(s.done)
	defer s.lock.Close()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.flush()
			s.prune(time.Now(), 0, 0)
		case <-s.stop:
			s.flush()
			return
		}
	}
}

func (s *Store) Close() {
	if s == nil {
		return
	}
	s.once.Do(func() { close(s.stop) })
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
	}
}
