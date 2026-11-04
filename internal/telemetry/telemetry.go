// Package telemetry keeps bounded, metadata-only gateway statistics. It never
// reads model bodies, provider credentials, response content, or target URLs.
//
// In-memory accounting is synchronous: Begin and Finish return as soon as the
// retained snapshot has been updated. Optional history-file persistence runs on
// one background worker that coalesces dirty snapshots, so a slow or failing
// disk never delays provider forwarding. Statistics are optional observability,
// unlike the response mailbox and dispatch journal, which remain durable on the
// request path.
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

	"deltarelay/internal/fsx"
	"deltarelay/internal/transfer"
)

const (
	SessionLimit = 256
	RequestLimit = 1000
	maxFileBytes = 8 << 20

	// Traffic aggregates outlive individual request entries. Hourly buckets
	// serve short and medium ranges; daily buckets keep a compact long-range
	// history after the hourly window ends.
	HourlyTrafficRetention = 31 * 24 * time.Hour
	DailyTrafficRetention  = 91 * 24 * time.Hour

	// defaultFlushInterval bounds both how often the worker rewrites the
	// statistics file and how long a completed accounting update can remain
	// memory-only under normal operation.
	defaultFlushInterval = time.Second

	// shutdownFlushTimeout bounds how long Close waits for the worker's final
	// flush. A hung filesystem must not stall gateway shutdown indefinitely.
	shutdownFlushTimeout = 5 * time.Second
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

// TrafficBucket is a metadata-only aggregate of finished requests. It stays
// small so multi-day ranges survive request-entry trimming.
type TrafficBucket struct {
	Start              time.Time `json:"start"`
	Requests           int64     `json:"requests"`
	Failed             int64     `json:"failed"`
	BodyBytes          int64     `json:"body_bytes"`
	UploadedChunkBytes int64     `json:"uploaded_chunk_bytes"`
	EncodedUploadBytes int64     `json:"encoded_upload_bytes"`
	ReusedBodyBytes    int64     `json:"reused_body_bytes"`
	ResponseBytes      int64     `json:"response_bytes"`
	DurationMillis     int64     `json:"duration_ms"`
}

type TrafficSeries struct {
	Since            time.Time       `json:"since"`
	BucketSeconds    int64           `json:"bucket_seconds"`
	RetentionSeconds int64           `json:"retention_seconds"`
	Buckets          []TrafficBucket `json:"buckets"`
}

type Traffic struct {
	Hourly TrafficSeries `json:"hourly"`
	Daily  TrafficSeries `json:"daily"`
}

type Snapshot struct {
	Version          int       `json:"version"`
	Since            time.Time `json:"since"`
	Totals           Totals    `json:"totals"`
	Sessions         []Session `json:"sessions"`
	RecentRequests   []Request `json:"recent_requests"`
	Traffic          Traffic   `json:"traffic"`
	SessionLimit     int       `json:"session_limit"`
	RequestLimit     int       `json:"request_limit"`
	EvictedSessions  int64     `json:"evicted_sessions"`
	DroppedRequests  int64     `json:"dropped_requests"`
	Persistent       bool      `json:"persistent"`
	PersistenceError bool      `json:"persistence_error"`
}

// Recorder owns one in-memory history and, optionally, one background writer
// for its private statistics file. After startup validation, the writer is the
// only goroutine that replaces that file, so snapshots are written in revision
// order and an older observation can never overwrite a newer one.
type Recorder struct {
	mu       sync.Mutex
	path     string
	data     Snapshot
	sequence uint64
	written  uint64 // highest revision successfully persisted
	lock     *os.File
	closed   bool

	revision   uint64
	write      func(string, any) error
	flushAfter time.Duration
	shutdown   time.Duration

	wake chan struct{}
	stop chan struct{}
	done chan struct{}

	closeOnce sync.Once
}

// Open refuses malformed, oversized, non-private, or symlinked history files.
// An empty path keeps the same bounded history in memory only.
func Open(path string) (*Recorder, error) {
	return openRecorder(path, fsx.WriteJSON, defaultFlushInterval, shutdownFlushTimeout)
}

// openRecorder injects the metadata writer and timings for tests. Production
// callers use Open; the injected writer only changes optional statistics
// persistence, never in-memory accounting or validation.
func openRecorder(path string, write func(string, any) error, flushAfter, shutdown time.Duration) (_ *Recorder, openErr error) {
	if write == nil || flushAfter <= 0 || shutdown <= 0 {
		return nil, errors.New("statistics writer and timings must be positive")
	}
	started := time.Now().UTC()
	r := &Recorder{
		path:       path,
		data:       Snapshot{Version: 1, Since: started, Sessions: []Session{}, RecentRequests: []Request{}, Traffic: newTraffic(started)},
		write:      write,
		flushAfter: flushAfter,
		shutdown:   shutdown,
		wake:       make(chan struct{}, 1),
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
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
		if err := write(path, r.data); err != nil {
			return nil, err
		}
		r.startWorker()
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
	if trafficMissing(r.data.Traffic) {
		// Older history files predate traffic aggregates. Reconstruct the
		// retained window from finished request entries before persisting.
		r.data.Traffic = newTraffic(now)
		r.backfillTrafficLocked(now)
	} else if !validTraffic(r.data.Traffic) {
		return nil, errors.New("invalid statistics traffic")
	}
	r.trimTrafficLocked(now)
	// Persist the normalized restart state synchronously: this happens before
	// the gateway serves requests and is not on a request path.
	r.revision++
	if err := write(path, r.data); err != nil {
		r.data.PersistenceError = true
	} else {
		r.data.PersistenceError = false
		r.written = r.revision
	}
	r.startWorker()
	return r, nil
}

func validTotals(t Totals) bool {
	return t.Requests >= 0 && t.Active >= 0 && t.Failed >= 0 && t.Active+t.Failed <= t.Requests && t.BodyBytes >= 0 && t.UploadedChunkBytes >= 0 && t.EncodedUploadBytes >= 0 && t.ReusedBodyBytes >= 0 && t.ResponseBytes >= 0 && t.DurationMillis >= 0
}

func newTraffic(since time.Time) Traffic {
	return Traffic{
		Hourly: TrafficSeries{
			Since:            since,
			BucketSeconds:    int64(time.Hour / time.Second),
			RetentionSeconds: int64(HourlyTrafficRetention / time.Second),
			Buckets:          []TrafficBucket{},
		},
		Daily: TrafficSeries{
			Since:            since,
			BucketSeconds:    int64(24 * time.Hour / time.Second),
			RetentionSeconds: int64(DailyTrafficRetention / time.Second),
			Buckets:          []TrafficBucket{},
		},
	}
}

func trafficMissing(t Traffic) bool {
	return t.Hourly.Since.IsZero() && t.Daily.Since.IsZero() &&
		t.Hourly.BucketSeconds == 0 && t.Daily.BucketSeconds == 0 &&
		len(t.Hourly.Buckets) == 0 && len(t.Daily.Buckets) == 0
}

func validTraffic(t Traffic) bool {
	return validTrafficSeries(t.Hourly, int64(time.Hour/time.Second), int64(HourlyTrafficRetention/time.Second)) &&
		validTrafficSeries(t.Daily, int64(24*time.Hour/time.Second), int64(DailyTrafficRetention/time.Second))
}

func validTrafficSeries(series TrafficSeries, bucketSeconds, retentionSeconds int64) bool {
	if series.Since.IsZero() || series.BucketSeconds != bucketSeconds || series.RetentionSeconds != retentionSeconds {
		return false
	}
	if int64(len(series.Buckets)) > retentionSeconds/bucketSeconds+2 {
		return false
	}
	var previous time.Time
	for _, bucket := range series.Buckets {
		if bucket.Start.IsZero() || !validTrafficBucket(bucket) {
			return false
		}
		if !previous.IsZero() && !bucket.Start.After(previous) {
			return false
		}
		previous = bucket.Start
	}
	return true
}

func validTrafficBucket(bucket TrafficBucket) bool {
	return bucket.Requests >= 0 && bucket.Failed >= 0 && bucket.Failed <= bucket.Requests &&
		bucket.BodyBytes >= 0 && bucket.UploadedChunkBytes >= 0 && bucket.EncodedUploadBytes >= 0 &&
		bucket.ReusedBodyBytes >= 0 && bucket.ResponseBytes >= 0 && bucket.DurationMillis >= 0
}

func hourlyTrafficStart(at time.Time) time.Time {
	local := at.In(time.Local)
	return time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, time.Local)
}

func dailyTrafficStart(at time.Time) time.Time {
	local := at.In(time.Local)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
}

func addTrafficBucket(buckets *[]TrafficBucket, start time.Time, stats transfer.Stats, responseBytes, duration int64, failed bool) {
	list := *buckets
	index := len(list) - 1
	for index >= 0 && list[index].Start.After(start) {
		index--
	}
	if index >= 0 && list[index].Start.Equal(start) {
		addTrafficResult(&list[index], stats, responseBytes, duration, failed)
		*buckets = list
		return
	}
	bucket := TrafficBucket{Start: start}
	addTrafficResult(&bucket, stats, responseBytes, duration, failed)
	list = append(list, TrafficBucket{})
	copy(list[index+2:], list[index+1:])
	list[index+1] = bucket
	*buckets = list
}

func addTrafficResult(bucket *TrafficBucket, stats transfer.Stats, responseBytes, duration int64, failed bool) {
	bucket.Requests++
	if failed {
		bucket.Failed++
	}
	bucket.BodyBytes += stats.BodyBytes
	bucket.UploadedChunkBytes += stats.UploadedChunkBytes
	bucket.EncodedUploadBytes += stats.RequestBodyBytesSent
	bucket.ReusedBodyBytes += stats.ReusedBodyBytes
	bucket.ResponseBytes += responseBytes
	bucket.DurationMillis += duration
}

func (r *Recorder) addTrafficLocked(at time.Time, stats transfer.Stats, responseBytes, duration int64, failed bool) {
	addTrafficBucket(&r.data.Traffic.Hourly.Buckets, hourlyTrafficStart(at), stats, responseBytes, duration, failed)
	addTrafficBucket(&r.data.Traffic.Daily.Buckets, dailyTrafficStart(at), stats, responseBytes, duration, failed)
	r.trimTrafficLocked(at)
}

func (r *Recorder) trimTrafficLocked(now time.Time) {
	r.data.Traffic.Hourly = trimTrafficSeries(r.data.Traffic.Hourly, now)
	r.data.Traffic.Daily = trimTrafficSeries(r.data.Traffic.Daily, now)
}

func trimTrafficSeries(series TrafficSeries, now time.Time) TrafficSeries {
	cutoff := now.Add(-time.Duration(series.RetentionSeconds) * time.Second)
	first := 0
	for first < len(series.Buckets) && series.Buckets[first].Start.Before(cutoff) {
		first++
	}
	if first == 0 {
		return series
	}
	series.Buckets = append([]TrafficBucket{}, series.Buckets[first:]...)
	return series
}

func (r *Recorder) backfillTrafficLocked(now time.Time) {
	earliest := time.Time{}
	for _, request := range r.data.RecentRequests {
		if request.FinishedAt == nil || request.State == "running" {
			continue
		}
		failed := request.State != "completed"
		if earliest.IsZero() || request.FinishedAt.Before(earliest) {
			earliest = *request.FinishedAt
		}
		addTrafficBucket(&r.data.Traffic.Hourly.Buckets, hourlyTrafficStart(*request.FinishedAt), request.Transfer, request.ResponseBytes, request.DurationMillis, failed)
		addTrafficBucket(&r.data.Traffic.Daily.Buckets, dailyTrafficStart(*request.FinishedAt), request.Transfer, request.ResponseBytes, request.DurationMillis, failed)
	}
	if earliest.IsZero() {
		earliest = now
	}
	if earliest.Before(r.data.Traffic.Hourly.Since) {
		r.data.Traffic.Hourly.Since = earliest
	}
	if earliest.Before(r.data.Traffic.Daily.Since) {
		r.data.Traffic.Daily.Since = earliest
	}
}

// Close marks the recorder closed and, for a persistent recorder, requests the
// worker's final flush and waits at most the shutdown timeout for it. Close is
// idempotent. Begin returns no sequence after Close; Finish for a request that
// began earlier still updates the retained in-memory snapshot but cannot
// schedule another file write. The writer releases the single-owner lock after
// its final flush; on timeout the process exits with the lock still held only
// until that write returns.
func (r *Recorder) Close() {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		if r.path == "" {
			return
		}
		close(r.stop)
		timeout := time.NewTimer(r.shutdown)
		defer timeout.Stop()
		select {
		case <-r.done:
		case <-timeout.C:
		}
	})
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
	r.revision++
	r.sequence++
	r.data.RecentRequests = append(r.data.RecentRequests, Request{Sequence: r.sequence, ID: id, SessionID: sessionID, Upstream: upstream, Kind: kind, StartedAt: now, State: "running"})
	r.markDirty()
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
		r.addTrafficLocked(now, stats, responseBytes, duration, failed)
		r.revision++
		r.markDirty()
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
	copy.Traffic.Hourly.Buckets = append([]TrafficBucket{}, r.data.Traffic.Hourly.Buckets...)
	copy.Traffic.Daily.Buckets = append([]TrafficBucket{}, r.data.Traffic.Daily.Buckets...)
	copy.SessionLimit, copy.RequestLimit, copy.Persistent = SessionLimit, RequestLimit, r.path != ""
	sort.Slice(copy.Sessions, func(i, j int) bool { return copy.Sessions[i].UpdatedAt.After(copy.Sessions[j].UpdatedAt) })
	return copy
}

// markDirty reports that the retained snapshot changed. It never waits for the
// disk: a buffered signal wakes the single worker and all intermediate updates
// coalesce into one later write of the newest revision.
func (r *Recorder) markDirty() {
	if r.path == "" || r.closed {
		return
	}
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *Recorder) startWorker() {
	go r.run()
}

func (r *Recorder) run() {
	var timer *time.Timer
	var timerC <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
		r.flush(true)
		r.mu.Lock()
		if r.lock != nil {
			_ = r.lock.Close()
			r.lock = nil
		}
		r.mu.Unlock()
		close(r.done)
	}()
	for {
		select {
		case <-r.stop:
			return
		default:
		}
		select {
		case <-r.wake:
			// Debounce: the first dirty update after a quiet period schedules
			// one write; later updates in the same window are coalesced.
			if timerC == nil {
				timer = time.NewTimer(r.flushAfter)
				timerC = timer.C
			}
		case <-timerC:
			r.flush(false)
			timerC = nil
		case <-r.stop:
			return
		}
	}
}

// flush writes the newest retained snapshot if it has not already been
// persisted. Only the worker calls it, except for the synchronous startup
// write performed by Open before the worker exists. Persistence failures stay
// visible in Snapshot and are retried on the next interval.
func (r *Recorder) flush(final bool) {
	r.mu.Lock()
	if r.path == "" || (r.closed && !final) || r.revision == r.written {
		r.mu.Unlock()
		return
	}
	snapshot := r.data
	snapshot.Sessions = append([]Session{}, r.data.Sessions...)
	snapshot.RecentRequests = append([]Request{}, r.data.RecentRequests...)
	snapshot.Traffic.Hourly.Buckets = append([]TrafficBucket{}, r.data.Traffic.Hourly.Buckets...)
	snapshot.Traffic.Daily.Buckets = append([]TrafficBucket{}, r.data.Traffic.Daily.Buckets...)
	revision := r.revision
	path, write := r.path, r.write
	r.mu.Unlock()

	err := write(path, snapshot)

	r.mu.Lock()
	if err != nil {
		r.data.PersistenceError = true
	} else {
		r.data.PersistenceError = false
		if revision > r.written {
			r.written = revision
		}
	}
	r.mu.Unlock()
}
