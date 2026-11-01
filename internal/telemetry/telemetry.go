// Package telemetry keeps bounded, metadata-only gateway statistics. It never
// reads model bodies, provider credentials, response content, or target URLs.
package telemetry

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"

	"deltarelay/internal/transfer"
)

const (
	SessionLimit = 256
	RequestLimit = 1000
	maxFileBytes = 8 << 20
)

type Totals struct {
	Requests           int64 `json:"requests"`
	Active             int64 `json:"active"`
	Failed             int64 `json:"failed"`
	BodyBytes          int64 `json:"body_bytes"`
	UploadedChunkBytes int64 `json:"uploaded_chunk_bytes"`
	EncodedUploadBytes int64 `json:"encoded_upload_bytes"`
	ReusedBodyBytes    int64 `json:"reused_body_bytes"`
	ResponseBytes      int64 `json:"response_bytes"`
	DurationMillis     int64 `json:"duration_ms"`
}

type Session struct {
	ID            string    `json:"id"`
	StartedAt     time.Time `json:"started_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Upstream      string    `json:"upstream"`
	LastStatus    int       `json:"last_status"`
	LastError     string    `json:"last_error,omitempty"`
	LastRequestID string    `json:"last_request_id"`
	Totals
}

type Request struct {
	Sequence       uint64         `json:"sequence"`
	ID             string         `json:"id"`
	SessionID      string         `json:"session_id"`
	Upstream       string         `json:"upstream"`
	Kind           string         `json:"kind"`
	StartedAt      time.Time      `json:"started_at"`
	FinishedAt     *time.Time     `json:"finished_at,omitempty"`
	State          string         `json:"state"`
	Status         int            `json:"status"`
	ErrorCode      string         `json:"error_code,omitempty"`
	Transfer       transfer.Stats `json:"transfer"`
	ResponseBytes  int64          `json:"response_bytes"`
	DurationMillis int64          `json:"duration_ms"`
}

type Snapshot struct {
	Version          int       `json:"version"`
	Since            time.Time `json:"since"`
	Totals           Totals    `json:"totals"`
	Sessions         []Session `json:"sessions"`
	RecentRequests   []Request `json:"recent_requests"`
	SessionLimit     int       `json:"session_limit"`
	RequestLimit     int       `json:"request_limit"`
	EvictedSessions  int64     `json:"evicted_sessions"`
	DroppedRequests  int64     `json:"dropped_requests"`
	Persistent       bool      `json:"persistent"`
	PersistenceError bool      `json:"persistence_error"`
}

type Recorder struct {
	mu       sync.Mutex
	path     string
	data     Snapshot
	sequence uint64
	lock     *os.File
	closed   bool
}

// Open refuses malformed, oversized, non-private, or symlinked history files.
// An empty path keeps the same bounded history in memory only.
func Open(path string) (_ *Recorder, openErr error) {
	r := &Recorder{path: path, data: Snapshot{Version: 1, Since: time.Now().UTC(), Sessions: []Session{}, RecentRequests: []Request{}}}
	if path == "" {
		return r, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	r.lock = lock
	defer func() {
		if openErr != nil {
			_ = lock.Close()
		}
	}()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.New("statistics file is already owned by another gateway")
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := r.persist(); err != nil {
			return nil, err
		}
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileBytes || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("statistics file must be private, regular, and at most 8 MiB")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, maxFileBytes+1))
	var saved Snapshot
	if err := decoder.Decode(&saved); err != nil {
		return nil, errors.New("invalid statistics file")
	}
	r.data = saved
	var extra any
	if decoder.Decode(&extra) != io.EOF || r.data.Version != 1 || r.data.Since.IsZero() || len(r.data.Sessions) > SessionLimit || len(r.data.RecentRequests) > RequestLimit {
		return nil, errors.New("unsupported or oversized statistics history")
	}
	seen := map[string]bool{}
	var active int64
	for i := range r.data.Sessions {
		s := &r.data.Sessions[i]
		if s.ID != "" && !ValidLabel(s.ID) || seen[s.ID] || !validTotals(s.Totals) || s.StartedAt.IsZero() || s.UpdatedAt.IsZero() {
			return nil, errors.New("invalid statistics session")
		}
		seen[s.ID] = true
		active += s.Active
		// A previous gateway process cannot still own an active request. This is
		// a local observation, not a claim that the VPS job was cancelled.
		s.Failed += s.Active
		if s.Active > 0 {
			s.LastError = "gateway_restarted"
		}
		s.Active = 0
	}
	if !validTotals(r.data.Totals) || r.data.Totals.Active != active {
		return nil, errors.New("invalid statistics totals")
	}
	r.data.Totals.Failed += r.data.Totals.Active
	r.data.Totals.Active = 0
	now := time.Now().UTC()
	sequences := map[uint64]bool{}
	var running int64
	for i := range r.data.RecentRequests {
		request := &r.data.RecentRequests[i]
		if request.Sequence == 0 || sequences[request.Sequence] || request.StartedAt.IsZero() || request.SessionID != "" && !ValidLabel(request.SessionID) {
			return nil, errors.New("invalid statistics request")
		}
		sequences[request.Sequence] = true
		r.sequence = max(r.sequence, request.Sequence)
		switch request.State {
		case "completed", "failed", "cancelled", "interrupted":
			if request.FinishedAt == nil {
				return nil, errors.New("invalid finished statistics request")
			}
		case "running":
			if !seen[request.SessionID] {
				return nil, errors.New("active statistics session missing")
			}
			running++
		default:
			return nil, errors.New("invalid statistics request state")
		}
		if request.State == "running" {
			request.State, request.ErrorCode, request.FinishedAt = "interrupted", "gateway_restarted", &now
		}
	}
	if running != active {
		return nil, errors.New("inconsistent active statistics")
	}
	r.save()
	return r, nil
}

func validTotals(t Totals) bool {
	return t.Requests >= 0 && t.Active >= 0 && t.Failed >= 0 && t.Active+t.Failed <= t.Requests && t.BodyBytes >= 0 && t.UploadedChunkBytes >= 0 && t.EncodedUploadBytes >= 0 && t.ReusedBodyBytes >= 0 && t.ResponseBytes >= 0 && t.DurationMillis >= 0
}

func (r *Recorder) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if r.lock != nil {
		_ = r.lock.Close()
		r.lock = nil
	}
}

// ValidLabel deliberately accepts only short opaque identifiers, not titles,
// filesystem paths, URLs, or arbitrary header values.
func ValidLabel(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

func (r *Recorder) Begin(id, sessionID, upstream, kind string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return 0
	}
	if !ValidLabel(sessionID) {
		sessionID = ""
	}
	switch kind {
	case "primary", "title", "compaction", "generate":
	default:
		kind = "unknown"
	}
	now := time.Now().UTC()
	index := r.sessionIndex(sessionID)
	if index < 0 {
		if len(r.data.Sessions) >= SessionLimit {
			oldest := -1
			for i, session := range r.data.Sessions {
				if session.Active == 0 && (oldest < 0 || session.UpdatedAt.Before(r.data.Sessions[oldest].UpdatedAt)) {
					oldest = i
				}
			}
			// The gateway caps concurrency below SessionLimit, so an inactive
			// session is always available for eviction.
			if oldest < 0 {
				return 0
			}
			evicted := r.data.Sessions[oldest].ID
			retained := r.data.RecentRequests[:0]
			for _, request := range r.data.RecentRequests {
				if request.SessionID != evicted {
					retained = append(retained, request)
				} else {
					r.data.DroppedRequests++
				}
			}
			r.data.RecentRequests = retained
			r.data.Sessions = append(r.data.Sessions[:oldest], r.data.Sessions[oldest+1:]...)
			r.data.EvictedSessions++
		}
		r.data.Sessions = append(r.data.Sessions, Session{ID: sessionID, StartedAt: now})
		index = len(r.data.Sessions) - 1
	}
	s := &r.data.Sessions[index]
	s.UpdatedAt, s.Upstream, s.LastRequestID = now, upstream, id
	s.Requests++
	s.Active++
	r.data.Totals.Requests++
	r.data.Totals.Active++
	if len(r.data.RecentRequests) >= RequestLimit {
		for i, request := range r.data.RecentRequests {
			if request.State != "running" {
				r.data.RecentRequests = append(r.data.RecentRequests[:i], r.data.RecentRequests[i+1:]...)
				r.data.DroppedRequests++
				break
			}
		}
	}
	r.sequence++
	r.data.RecentRequests = append(r.data.RecentRequests, Request{Sequence: r.sequence, ID: id, SessionID: sessionID, Upstream: upstream, Kind: kind, StartedAt: now, State: "running"})
	r.save()
	return r.sequence
}

func (r *Recorder) Finish(sequence uint64, status int, failed bool, code string, stats transfer.Stats, responseBytes, duration int64) {
	if sequence == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.data.RecentRequests {
		request := &r.data.RecentRequests[i]
		if request.Sequence != sequence || request.State != "running" {
			continue
		}
		now := time.Now().UTC()
		request.FinishedAt, request.Status, request.ErrorCode = &now, status, code
		request.Transfer, request.ResponseBytes, request.DurationMillis = stats, responseBytes, duration
		request.State = "completed"
		if failed {
			request.State = "failed"
		}
		if status == 499 {
			request.State = "cancelled"
		}
		s := &r.data.Sessions[r.sessionIndex(request.SessionID)]
		s.UpdatedAt, s.LastStatus, s.LastError = now, status, code
		addResult(&s.Totals, failed, stats, responseBytes, duration)
		addResult(&r.data.Totals, failed, stats, responseBytes, duration)
		r.save()
		return
	}
}

func addResult(t *Totals, failed bool, stats transfer.Stats, responseBytes, duration int64) {
	t.Active--
	if failed {
		t.Failed++
	}
	t.BodyBytes += stats.BodyBytes
	t.UploadedChunkBytes += stats.UploadedChunkBytes
	t.EncodedUploadBytes += stats.RequestBodyBytesSent
	t.ReusedBodyBytes += stats.ReusedBodyBytes
	t.ResponseBytes += responseBytes
	t.DurationMillis += duration
}

func (r *Recorder) sessionIndex(id string) int {
	for i := range r.data.Sessions {
		if r.data.Sessions[i].ID == id {
			return i
		}
	}
	return -1
}

func (r *Recorder) Snapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := r.data
	copy.Sessions = append([]Session{}, r.data.Sessions...)
	copy.RecentRequests = append([]Request{}, r.data.RecentRequests...)
	copy.SessionLimit, copy.RequestLimit, copy.Persistent = SessionLimit, RequestLimit, r.path != ""
	sort.Slice(copy.Sessions, func(i, j int) bool { return copy.Sessions[i].UpdatedAt.After(copy.Sessions[j].UpdatedAt) })
	return copy
}

func (r *Recorder) save() { r.data.PersistenceError = r.persist() != nil }

// Persistence failures are visible in diagnostics but never break a model call.
// One gateway process must own a history file, just like its control directory.
func (r *Recorder) persist() error {
	if r.path == "" {
		return nil
	}
	if r.closed {
		return errors.New("statistics recorder is closed")
	}
	f, err := os.CreateTemp(filepath.Dir(r.path), ".stats-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := json.NewEncoder(f).Encode(r.data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), r.path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(r.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
