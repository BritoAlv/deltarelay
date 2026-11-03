// Package mailbox stores durable request tombstones and checksummed response
// frames. It never stores provider request headers or dispatches provider calls.
// Exactly one server process may own a data directory.
package mailbox

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"deltarelay/internal/fsx"
	"deltarelay/internal/protocol"
)

var (
	ErrConflict  = errors.New("request ID belongs to different content")
	ErrFull      = errors.New("response storage or request limit reached")
	ErrGone      = errors.New("response acknowledged or expired")
	ErrStopped   = errors.New("request is no longer running")
	ErrIntegrity = errors.New("response storage integrity failure")
)

const frameHeader = 4 + sha256.Size
const frameMax = 32 << 10

// Defaults are owned here because the mailbox owns response retention,
// response storage, and retained-record limits. Callers that expose these
// settings as flags should reference them instead of duplicating literals.
const (
	DefaultRetention     = 24 * time.Hour
	DefaultStorageBytes  = 4 << 30
	DefaultResponseBytes = 256 << 20
	DefaultMaxRecords    = 100000

	MinRetention = time.Second

	// MinStorageBytes is the smallest aggregate response storage limit that
	// can hold one empty framed response.
	MinStorageBytes = frameHeader + 1
)

type Config struct {
	Retention        time.Duration
	MaxBytes         int64
	MaxResponseBytes int64
	MaxRecords       int
}

type frame struct {
	offset, position int64
	size             int
	hash             [sha256.Size]byte
}

type entry struct {
	record  protocol.RequestStatus
	frames  []frame
	encoded int64
	cancel  context.CancelFunc
}

type Mailbox struct {
	mu                 sync.Mutex
	directory, stateID string
	config             Config
	entries            map[string]*entry
	used               int64
	changed            chan struct{}
	poisoned           bool
}

func Open(directory string, config Config) (*Mailbox, error) {
	if config.Retention == 0 {
		config.Retention = DefaultRetention
	}
	if config.MaxBytes == 0 {
		config.MaxBytes = DefaultStorageBytes
	}
	if config.MaxResponseBytes == 0 {
		config.MaxResponseBytes = DefaultResponseBytes
	}
	if config.MaxRecords == 0 {
		config.MaxRecords = DefaultMaxRecords
	}
	if config.Retention < MinRetention || config.MaxBytes < MinStorageBytes || config.MaxResponseBytes < 1 || config.MaxRecords < 1 {
		return nil, errors.New("invalid mailbox limits")
	}
	for _, name := range []string{directory, filepath.Join(directory, "records"), filepath.Join(directory, "responses")} {
		if err := os.MkdirAll(name, 0700); err != nil {
			return nil, err
		}
		if err := fsx.SyncDir(filepath.Dir(name)); err != nil {
			return nil, err
		}
	}
	m := &Mailbox{directory: directory, config: config, entries: make(map[string]*entry), changed: make(chan struct{})}
	identity := filepath.Join(directory, "identity.json")
	data, err := os.ReadFile(identity)
	if errors.Is(err, os.ErrNotExist) {
		var id [32]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, err
		}
		m.stateID = hex.EncodeToString(id[:])
		if err := fsx.WriteJSON(identity, m.stateID); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else if json.Unmarshal(data, &m.stateID) != nil || !protocol.ValidHash(m.stateID) {
		return nil, errors.New("invalid mailbox identity; do not replace or erase persisted state")
	}
	files, err := os.ReadDir(filepath.Join(directory, "records"))
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if file.IsDir() || !protocol.ValidHash(file.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, "records", file.Name()))
		if err != nil {
			return nil, err
		}
		e := &entry{}
		if json.Unmarshal(data, &e.record) != nil || protocol.Sum([]byte(e.record.ID)) != file.Name() || e.record.StateID != m.stateID || e.record.Bytes < 0 {
			return nil, errors.New("invalid request record; refusing unsafe recovery")
		}
		m.entries[e.record.ID] = e
		if !e.record.Acknowledged && !e.record.Expired {
			if err := m.loadFrames(e); err != nil {
				return nil, fmt.Errorf("cannot verify saved response: %w", err)
			}
			m.used += e.encoded
		}
		if !protocol.Terminal(e.record.State) {
			e.record.State = protocol.Interrupted
			e.record.ErrorCode = "server_restarted_dispatch_unknown"
			e.record.Finished = time.Now().Unix()
			e.record.Expires = time.Now().Add(config.Retention).Unix() + 1
			if err := m.save(e.record); err != nil {
				return nil, err
			}
		}
		if e.record.Acknowledged || e.record.Expired {
			if err := m.removeResponse(e); err != nil {
				return nil, err
			}
		}
	}
	// Reclaim orphan payloads from a crash before its request record was committed.
	payloads, err := os.ReadDir(filepath.Join(directory, "responses"))
	if err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(m.entries))
	for id := range m.entries {
		known[protocol.Sum([]byte(id))] = true
	}
	for _, p := range payloads {
		if !p.IsDir() && protocol.ValidHash(p.Name()) && !known[p.Name()] {
			if err := os.Remove(filepath.Join(directory, "responses", p.Name())); err != nil {
				return nil, err
			}
		}
	}
	if err := m.Sweep(); err != nil {
		return nil, err
	}
	if m.used > config.MaxBytes || len(m.entries) > config.MaxRecords {
		return nil, ErrFull
	}
	return m, nil
}

func (m *Mailbox) loadFrames(e *entry) error {
	f, err := os.OpenFile(m.payload(e.record.ID), os.O_RDWR, 0600)
	if errors.Is(err, os.ErrNotExist) && e.record.Bytes == 0 {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	var decoded int64
	for decoded < e.record.Bytes {
		var header [frameHeader]byte
		if _, err := io.ReadFull(f, header[:]); err != nil {
			return ErrIntegrity
		}
		size := int(binary.BigEndian.Uint32(header[:4]))
		if size < 1 || size > frameMax || int64(size) > e.record.Bytes-decoded {
			return ErrIntegrity
		}
		body := make([]byte, size)
		if _, err := io.ReadFull(f, body); err != nil {
			return ErrIntegrity
		}
		var digest [sha256.Size]byte
		copy(digest[:], header[4:])
		if sha256.Sum256(body) != digest {
			return ErrIntegrity
		}
		e.frames = append(e.frames, frame{decoded, e.encoded + frameHeader, size, digest})
		e.encoded += int64(frameHeader + size)
		decoded += int64(size)
	}
	// Ignore an uncommitted tail left between payload fsync and metadata commit.
	if err := f.Truncate(e.encoded); err != nil {
		return err
	}
	return f.Sync()
}

func (m *Mailbox) StateID() string { return m.stateID }
func (m *Mailbox) Limits() Config  { return m.config }
func (m *Mailbox) Usage() int64    { m.mu.Lock(); defer m.mu.Unlock(); return m.used }
func (m *Mailbox) payload(id string) string {
	return filepath.Join(m.directory, "responses", protocol.Sum([]byte(id)))
}
func (m *Mailbox) save(record protocol.RequestStatus) error {
	return fsx.WriteJSON(filepath.Join(m.directory, "records", protocol.Sum([]byte(record.ID))), record)
}
func (m *Mailbox) notify() { close(m.changed); m.changed = make(chan struct{}) }

func clone(r protocol.RequestStatus) protocol.RequestStatus { r.Headers = r.Headers.Clone(); return r }

// Accept invokes claim only for a new ID, after capacity checks, under the same
// lock used by Cancel. A claim survives even if subsequent persistence fails.
func (m *Mailbox) Accept(id, fingerprint, bodyHash string, claim func() error) (protocol.RequestStatus, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.entries[id]; e != nil {
		if e.record.Fingerprint != fingerprint {
			return protocol.RequestStatus{}, false, ErrConflict
		}
		if err := m.expire(e); err != nil {
			return protocol.RequestStatus{}, false, err
		}
		return clone(e.record), false, nil
	}
	if m.poisoned {
		return protocol.RequestStatus{}, false, errors.New("mailbox persistence unavailable")
	}
	if len(m.entries) >= m.config.MaxRecords || m.used+frameHeader+1 > m.config.MaxBytes {
		return protocol.RequestStatus{}, false, ErrFull
	}
	if err := claim(); err != nil {
		return protocol.RequestStatus{}, false, err
	}
	e := &entry{record: protocol.RequestStatus{ID: id, StateID: m.stateID, Fingerprint: fingerprint, BodyHash: bodyHash, State: protocol.Accepted, Created: time.Now().Unix()}}
	if err := m.save(e.record); err != nil {
		m.poisoned = true
		return protocol.RequestStatus{}, false, err
	}
	m.entries[id] = e
	m.notify()
	return clone(e.record), true, nil
}

func (m *Mailbox) Lookup(id string) (protocol.RequestStatus, <-chan struct{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil {
		return protocol.RequestStatus{}, m.changed, os.ErrNotExist
	}
	if err := m.expire(e); err != nil {
		return protocol.RequestStatus{}, m.changed, err
	}
	return clone(e.record), m.changed, nil
}

func (m *Mailbox) Start(id string, parent context.Context, lifetime time.Duration) (context.Context, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil || e.record.State != protocol.Accepted {
		return nil, false, nil
	}
	r := e.record
	r.State = protocol.Running
	if err := m.save(r); err != nil {
		m.poisoned = true
		return nil, false, err
	}
	ctx, cancel := context.WithTimeout(parent, lifetime)
	e.cancel, e.record = cancel, r
	m.notify()
	return ctx, true, nil
}

func (m *Mailbox) SetHeaders(id string, status int, headers http.Header) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil || e.record.State != protocol.Running {
		return ErrStopped
	}
	r := e.record
	r.Status, r.Headers = status, headers.Clone()
	if err := m.save(r); err != nil {
		m.poisoned = true
		return err
	}
	e.record = r
	m.notify()
	return nil
}

func (m *Mailbox) Append(id string, data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if len(data) > frameMax {
		return errors.New("response frame too large")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil || e.record.State != protocol.Running {
		return ErrStopped
	}
	encoded := int64(frameHeader + len(data))
	if int64(len(data)) > m.config.MaxResponseBytes-e.record.Bytes || encoded > m.config.MaxBytes-m.used {
		return ErrFull
	}
	f, err := os.OpenFile(m.payload(id), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	digest := sha256.Sum256(data)
	frameData := make([]byte, frameHeader+len(data))
	binary.BigEndian.PutUint32(frameData[:4], uint32(len(data)))
	copy(frameData[4:frameHeader], digest[:])
	copy(frameData[frameHeader:], data)
	if _, err := f.WriteAt(frameData, e.encoded); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if e.encoded == 0 {
		if err := fsx.SyncDir(filepath.Dir(m.payload(id))); err != nil {
			return err
		}
	}
	r := e.record
	r.Bytes += int64(len(data))
	if err := m.save(r); err != nil {
		m.poisoned = true
		return err
	}
	e.frames = append(e.frames, frame{e.record.Bytes, e.encoded + frameHeader, len(data), digest})
	e.record = r
	e.encoded += encoded
	m.used += encoded
	m.notify()
	return nil
}

func (m *Mailbox) Finish(id, state, code, hash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil || protocol.Terminal(e.record.State) {
		return nil
	}
	r := e.record
	r.State, r.ErrorCode, r.Hash = state, code, hash
	r.Finished = time.Now().Unix()
	r.Expires = time.Now().Add(m.config.Retention).Unix() + 1
	if e.cancel != nil {
		e.cancel()
		e.cancel = nil
	}
	err := m.save(r)
	if err != nil {
		m.poisoned = true
		r.State, r.ErrorCode = protocol.Interrupted, "persistence_failed"
	}
	e.record = r
	m.notify()
	return err
}

// Read returns only fully verified persisted frames, sliced to the requested
// decoded byte offset. A caller can long-poll changed without holding the lock.
func (m *Mailbox) Read(id string, offset int64) (protocol.RequestStatus, []byte, <-chan struct{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil {
		return protocol.RequestStatus{}, nil, m.changed, os.ErrNotExist
	}
	if err := m.expire(e); err != nil {
		return protocol.RequestStatus{}, nil, m.changed, err
	}
	r := clone(e.record)
	if r.Acknowledged || r.Expired {
		return r, nil, m.changed, ErrGone
	}
	if offset < 0 || offset > r.Bytes {
		return r, nil, m.changed, ErrConflict
	}
	if offset == r.Bytes {
		return r, nil, m.changed, nil
	}
	f, err := os.Open(m.payload(id))
	if err != nil {
		return r, nil, m.changed, err
	}
	defer f.Close()
	result := make([]byte, 0, min(int64(protocol.ResponseSegmentBytes), r.Bytes-offset))
	startFrame := sort.Search(len(e.frames), func(i int) bool { return e.frames[i].offset+int64(e.frames[i].size) > offset })
	for _, frame := range e.frames[startFrame:] {
		data := make([]byte, frame.size)
		if _, err := f.ReadAt(data, frame.position); err != nil {
			return r, nil, m.changed, ErrIntegrity
		}
		if sha256.Sum256(data) != frame.hash {
			return r, nil, m.changed, ErrIntegrity
		}
		start := max(int64(0), offset-frame.offset)
		n := min(len(data)-int(start), protocol.ResponseSegmentBytes-len(result))
		result = append(result, data[start:int(start)+n]...)
		if len(result) == protocol.ResponseSegmentBytes {
			break
		}
	}
	return r, result, m.changed, nil
}

// Cancel creates a durable tombstone even if submission has not arrived yet.
func (m *Mailbox) Cancel(id string, claim func() error) (protocol.RequestStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil {
		if m.poisoned || len(m.entries) >= m.config.MaxRecords {
			return protocol.RequestStatus{}, ErrFull
		}
		if err := claim(); err != nil {
			return protocol.RequestStatus{}, err
		}
		e = &entry{record: protocol.RequestStatus{ID: id, StateID: m.stateID, State: protocol.Accepted, Created: time.Now().Unix()}}
		m.entries[id] = e
	}
	if protocol.Terminal(e.record.State) {
		return clone(e.record), nil
	}
	r := e.record
	r.State, r.ErrorCode = protocol.Cancelled, "client_cancelled"
	r.Finished = time.Now().Unix()
	r.Expires = time.Now().Add(m.config.Retention).Unix() + 1
	err := m.save(r)
	if err != nil {
		m.poisoned = true
	}
	e.record = r
	if e.cancel != nil {
		e.cancel()
		e.cancel = nil
	}
	m.notify()
	return clone(r), err
}

func (m *Mailbox) Ack(id string, receipt protocol.Receipt) (protocol.RequestStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil {
		return protocol.RequestStatus{}, os.ErrNotExist
	}
	if e.record.State != protocol.Completed || receipt.Size != e.record.Bytes || receipt.Hash != e.record.Hash {
		return protocol.RequestStatus{}, ErrConflict
	}
	r := e.record
	r.Acknowledged = true
	r.Headers = nil
	if err := m.save(r); err != nil {
		return protocol.RequestStatus{}, err
	}
	e.record = r
	if err := m.removeResponse(e); err != nil {
		return r, err
	}
	m.notify()
	return clone(r), nil
}

func (m *Mailbox) removeResponse(e *entry) error {
	if err := os.Remove(m.payload(e.record.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := fsx.SyncDir(filepath.Join(m.directory, "responses")); err != nil {
		return err
	}
	m.used -= e.encoded
	e.encoded, e.frames = 0, nil
	return nil
}

func (m *Mailbox) expire(e *entry) error {
	if e.record.Acknowledged || e.record.Expired {
		if e.encoded != 0 {
			return m.removeResponse(e)
		}
		return nil
	}
	if !protocol.Terminal(e.record.State) || time.Now().Unix() < e.record.Expires {
		return nil
	}
	r := e.record
	r.Expired, r.Headers = true, nil
	if err := m.save(r); err != nil {
		return err
	}
	e.record = r
	if err := m.removeResponse(e); err != nil {
		return err
	}
	m.notify()
	return nil
}

func (m *Mailbox) Sweep() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.entries {
		if err := m.expire(e); err != nil {
			return err
		}
	}
	return nil
}

func (m *Mailbox) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.entries {
		if e.cancel != nil {
			e.cancel()
		}
	}
}
