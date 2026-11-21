// Package telemetry keeps metadata-only gateway statistics. It never
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
	"deltarelay/internal/usage"
)

const (
	// SessionLimit and RequestLimit are zero because no retained observation is
	// discarded. The fields remain in the wire format so older dashboards can
	// distinguish bounded history from unlimited history.
	SessionLimit = 0
	RequestLimit = 0

	// Traffic aggregates are also retained indefinitely. Hourly buckets serve
	// short and medium ranges; daily buckets keep long-range history.
	HourlyTrafficRetention = 0
	DailyTrafficRetention  = 0

	// defaultFlushInterval bounds both how often the worker rewrites the
	// statistics file and how long a completed accounting update can remain
	// memory-only under normal operation.
	defaultFlushInterval = time.Second

	// shutdownFlushTimeout bounds how long Close waits for the worker's final
	// flush. A hung filesystem must not stall gateway shutdown indefinitely.
	shutdownFlushTimeout = 5 * time.Second

	// currentAccountingVersion identifies histories whose request outcomes use
	// separate failure, cancellation, and legacy buckets. Version zero is the
	// old accounting that counted every client-closed 499 stream as a failure.
	currentAccountingVersion = 1
)

type Totals struct {
	Requests  int64 `json:"requests"`
	Active    int64 `json:"active"`
	Failed    int64 `json:"failed"`
	Cancelled int64 `json:"cancelled"`
	// Legacy counts retained requests recorded before final-state
	// reconciliation, so their outcome is unknown. They are neither failures
	// nor cancellations and remain part of the byte totals.
	Legacy             int64 `json:"legacy,omitempty"`
	BodyBytes          int64 `json:"body_bytes"`
	UploadedChunkBytes int64 `json:"uploaded_chunk_bytes"`
	EncodedUploadBytes int64 `json:"encoded_upload_bytes"`
	ReusedBodyBytes    int64 `json:"reused_body_bytes"`
	ResponseBytes      int64 `json:"response_bytes"`
	DurationMillis     int64 `json:"duration_ms"`
}

type Session struct {
	Host          string    `json:"host,omitempty"`
	ID            string    `json:"id"`
	StartedAt     time.Time `json:"started_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Upstream      string    `json:"upstream"`
	LastStatus    int       `json:"last_status"`
	LastError     string    `json:"last_error,omitempty"`
	LastRequestID string    `json:"last_request_id"`
	Clients       []string  `json:"clients,omitempty"`
	Totals
}

type Request struct {
	APIKey         *usage.Key         `json:"api_key,omitempty"`
	Usage          *usage.Measurement `json:"usage,omitempty"`
	Host           string             `json:"host,omitempty"`
	CaptureID      string             `json:"capture_id,omitempty"`
	Sequence       uint64             `json:"sequence"`
	ID             string             `json:"id"`
	SessionID      string             `json:"session_id"`
	Upstream       string             `json:"upstream"`
	Client         string             `json:"client,omitempty"`
	Kind           string             `json:"kind"`
	StartedAt      time.Time          `json:"started_at"`
	FinishedAt     *time.Time         `json:"finished_at,omitempty"`
	State          string             `json:"state"`
	Status         int                `json:"status"`
	ErrorCode      string             `json:"error_code,omitempty"`
	Transfer       transfer.Stats     `json:"transfer"`
	ResponseBytes  int64              `json:"response_bytes"`
	DurationMillis int64              `json:"duration_ms"`
}

// TrafficBucket is a metadata-only aggregate of finished requests. It keeps
// long-range history compact without discarding session or request entries.
type TrafficBucket struct {
	Host               string    `json:"host,omitempty"`
	Start              time.Time `json:"start"`
	Requests           int64     `json:"requests"`
	Failed             int64     `json:"failed"`
	Cancelled          int64     `json:"cancelled"`
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
	Version           int               `json:"version"`
	Host              string            `json:"host,omitempty"`
	Since             time.Time         `json:"since"`
	AccountingVersion int               `json:"accounting_version,omitempty"`
	Totals            Totals            `json:"totals"`
	HostTotals        map[string]Totals `json:"host_totals,omitempty"`
	Sessions          []Session         `json:"sessions"`
	RecentRequests    []Request         `json:"recent_requests"`
	Traffic           Traffic           `json:"traffic"`
	SessionLimit      int               `json:"session_limit"`
	RequestLimit      int               `json:"request_limit"`
	EvictedSessions   int64             `json:"evicted_sessions"`
	DroppedRequests   int64             `json:"dropped_requests"`
	Persistent        bool              `json:"persistent"`
	PersistenceError  bool              `json:"persistence_error"`
}

// Recorder owns one in-memory history and, optionally, one background writer
// for its private statistics file. After startup validation, the writer is the
// only goroutine that replaces that file, so snapshots are written in revision
// order and an older observation can never overwrite a newer one.
type Recorder struct {
	mu       sync.Mutex
	path     string
	host     string
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

// Open refuses malformed, non-private, or symlinked history files. An empty
// path keeps the same unlimited history in memory only.
func Open(path string) (*Recorder, error) {
	return OpenWithHost(path, "local")
}

// OpenWithHost labels observations with the remote host that carried them. A
// shared statistics file can then retain one continuous history while still
// distinguishing hosts in the dashboard.
func OpenWithHost(path, host string) (*Recorder, error) {
	if !ValidLabel(host) {
		return nil, errors.New("invalid history host")
	}
	return openRecorder(path, host, fsx.WriteJSON, defaultFlushInterval, shutdownFlushTimeout)
}

// openRecorder injects the metadata writer and timings for tests. Production
// callers use Open; the injected writer only changes optional statistics
// persistence, never in-memory accounting or validation.
func openRecorder(path, host string, write func(string, any) error, flushAfter, shutdown time.Duration) (_ *Recorder, openErr error) {
	if write == nil || flushAfter <= 0 || shutdown <= 0 || !ValidLabel(host) {
		return nil, errors.New("statistics writer, host, and timings must be valid")
	}
	started := time.Now().UTC()
	r := &Recorder{
		path:       path,
		host:       host,
		data:       Snapshot{Version: 1, Host: host, Since: started, AccountingVersion: currentAccountingVersion, HostTotals: map[string]Totals{}, Sessions: []Session{}, RecentRequests: []Request{}, Traffic: newTraffic(started)},
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
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("statistics file must be private and regular")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	decoder := json.NewDecoder(f)
	var saved Snapshot
	if err := decoder.Decode(&saved); err != nil {
		return nil, errors.New("invalid statistics file")
	}
	r.data = saved
	r.data.Host = r.host
	var extra any
	if decoder.Decode(&extra) != io.EOF || r.data.Version != 1 || r.data.Since.IsZero() {
		return nil, errors.New("unsupported statistics history")
	}
	if r.data.AccountingVersion < 0 || r.data.AccountingVersion > currentAccountingVersion {
		return nil, errors.New("unsupported statistics accounting version")
	}
	seen := map[string]bool{}
	hosts := map[string]bool{}
	var active int64
	for i := range r.data.Sessions {
		s := &r.data.Sessions[i]
		if s.Host == "" {
			s.Host = r.host
		}
		if !ValidLabel(s.Host) || s.ID != "" && !ValidLabel(s.ID) || seen[sessionKey(s.Host, s.ID)] || !validTotals(s.Totals) || s.StartedAt.IsZero() || s.UpdatedAt.IsZero() {
			return nil, errors.New("invalid statistics session")
		}
		seenClients := map[string]bool{}
		for _, client := range s.Clients {
			if !ValidLabel(client) || seenClients[client] {
				return nil, errors.New("invalid statistics session client")
			}
			seenClients[client] = true
		}
		seen[sessionKey(s.Host, s.ID)] = true
		hosts[s.Host] = true
		active += s.Active
		// A previous gateway process cannot still own an active request. This is
		// a local observation, not a claim that the VPS job was cancelled.
		s.Failed += s.Active
		if s.Active > 0 {
			s.LastError = "gateway_restarted"
		}
		s.Active = 0
	}
	if r.data.HostTotals == nil || len(r.data.HostTotals) == 0 {
		// Older single-host files have no per-host totals. All of their retained
		// totals belong to the host that is opening the file now.
		if len(hosts) > 1 {
			return nil, errors.New("invalid statistics host totals")
		}
		r.data.HostTotals = map[string]Totals{}
		r.data.HostTotals[r.host] = r.data.Totals
		hosts[r.host] = true
	}
	for host, totals := range r.data.HostTotals {
		if !ValidLabel(host) || !validTotals(totals) {
			return nil, errors.New("invalid statistics host totals")
		}
		if totals.Active > 0 {
			totals.Failed += totals.Active
			totals.Active = 0
			r.data.HostTotals[host] = totals
		}
		hosts[host] = true
	}
	if !validTotals(r.data.Totals) || r.data.Totals.Active != active {
		return nil, errors.New("invalid statistics totals")
	}
	r.data.Totals.Failed += r.data.Totals.Active
	r.data.Totals.Active = 0
	if !sumTotals(r.data.HostTotals, r.data.Totals) {
		return nil, errors.New("inconsistent statistics host totals")
	}
	if err := r.normalizeLegacyOutcomesLocked(); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	sequences := map[uint64]bool{}
	var running int64
	for i := range r.data.RecentRequests {
		request := &r.data.RecentRequests[i]
		if request.Host == "" {
			request.Host = r.host
		}
		if !ValidLabel(request.Host) || request.Sequence == 0 || sequences[request.Sequence] || request.StartedAt.IsZero() || request.SessionID != "" && !ValidLabel(request.SessionID) || request.Client != "" && !ValidLabel(request.Client) || request.CaptureID != "" && !validCaptureID(request.CaptureID) {
			return nil, errors.New("invalid statistics request")
		}
		if !usage.Valid(request.Usage) || request.APIKey != nil && (!validCaptureID(request.APIKey.ID) || request.APIKey.Name == "" || usage.Label(request.APIKey.Name) != request.APIKey.Name) {
			return nil, errors.New("invalid statistics usage metadata")
		}
		hosts[request.Host] = true
		sequences[request.Sequence] = true
		r.sequence = max(r.sequence, request.Sequence)
		switch request.State {
		case "completed", "failed", "cancelled", "interrupted":
			if request.FinishedAt == nil {
				return nil, errors.New("invalid finished statistics request")
			}
		case "running":
			if !seen[sessionKey(request.Host, request.SessionID)] {
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
	for i := range r.data.Traffic.Hourly.Buckets {
		if r.data.Traffic.Hourly.Buckets[i].Host == "" {
			r.data.Traffic.Hourly.Buckets[i].Host = r.host
		}
		hosts[r.data.Traffic.Hourly.Buckets[i].Host] = true
	}
	for i := range r.data.Traffic.Daily.Buckets {
		if r.data.Traffic.Daily.Buckets[i].Host == "" {
			r.data.Traffic.Daily.Buckets[i].Host = r.host
		}
		hosts[r.data.Traffic.Daily.Buckets[i].Host] = true
	}
	for host := range hosts {
		if _, ok := r.data.HostTotals[host]; !ok {
			r.data.HostTotals[host] = Totals{}
		}
	}
	if !validTraffic(r.data.Traffic, len(hosts)) {
		return nil, errors.New("invalid statistics traffic")
	}
	// Older files advertised finite aggregate windows. The data that survived
	// is kept indefinitely from now on.
	r.data.Traffic.Hourly.RetentionSeconds = 0
	r.data.Traffic.Daily.RetentionSeconds = 0
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
	return t.Requests >= 0 && t.Active >= 0 && t.Failed >= 0 && t.Cancelled >= 0 && t.Legacy >= 0 && t.Active+t.Failed+t.Cancelled+t.Legacy <= t.Requests && t.BodyBytes >= 0 && t.UploadedChunkBytes >= 0 && t.EncodedUploadBytes >= 0 && t.ReusedBodyBytes >= 0 && t.ResponseBytes >= 0 && t.DurationMillis >= 0
}

// normalizeLegacyOutcomesLocked separates requests recorded by the old
// accounting, which counted every client-closed 499 stream as a failure. The
// relay's final state was never checked for those requests, so moving them to
// failures or cancellations would invent an outcome. A whole-session failure
// ending in request_cancelled is the only reliable legacy pattern; ambiguous
// sessions keep their failure count.
func (r *Recorder) normalizeLegacyOutcomesLocked() error {
	if r.data.AccountingVersion >= currentAccountingVersion {
		return nil
	}
	for i := range r.data.Sessions {
		s := &r.data.Sessions[i]
		if s.Failed == 0 || s.Failed != s.Requests || s.LastStatus != 499 || s.LastError != "request_cancelled" {
			continue
		}
		amount := s.Failed
		hostTotals, ok := r.data.HostTotals[s.Host]
		if !ok || amount > hostTotals.Failed || amount > r.data.Totals.Failed {
			return errors.New("inconsistent legacy statistics totals")
		}
		s.Failed -= amount
		s.Legacy += amount
		hostTotals.Failed -= amount
		hostTotals.Legacy += amount
		r.data.HostTotals[s.Host] = hostTotals
		r.data.Totals.Failed -= amount
		r.data.Totals.Legacy += amount
	}
	r.data.AccountingVersion = currentAccountingVersion
	if !validTotals(r.data.Totals) || !sumTotals(r.data.HostTotals, r.data.Totals) {
		return errors.New("inconsistent legacy statistics totals")
	}
	return nil
}

func sessionKey(host, id string) string {
	return host + "\x00" + id
}

func addTotals(target *Totals, value Totals) {
	target.Requests += value.Requests
	target.Active += value.Active
	target.Failed += value.Failed
	target.Cancelled += value.Cancelled
	target.Legacy += value.Legacy
	target.BodyBytes += value.BodyBytes
	target.UploadedChunkBytes += value.UploadedChunkBytes
	target.EncodedUploadBytes += value.EncodedUploadBytes
	target.ReusedBodyBytes += value.ReusedBodyBytes
	target.ResponseBytes += value.ResponseBytes
	target.DurationMillis += value.DurationMillis
}

func sumTotals(hosts map[string]Totals, expected Totals) bool {
	var sum Totals
	for _, totals := range hosts {
		addTotals(&sum, totals)
	}
	return sum == expected
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

func validTraffic(t Traffic, hosts int) bool {
	if hosts < 1 {
		hosts = 1
	}
	return validTrafficSeries(t.Hourly, int64(time.Hour/time.Second), hosts) &&
		validTrafficSeries(t.Daily, int64(24*time.Hour/time.Second), hosts)
}

func validTrafficSeries(series TrafficSeries, bucketSeconds int64, hosts int) bool {
	if series.Since.IsZero() || series.BucketSeconds != bucketSeconds || series.RetentionSeconds < 0 {
		return false
	}
	// Zero means unlimited. Finite values are accepted for compatibility with
	// older history files; the recorder normalizes them to unlimited on load.
	if series.RetentionSeconds > 0 && int64(len(series.Buckets)) > (series.RetentionSeconds/bucketSeconds+2)*int64(hosts) {
		return false
	}
	var previous time.Time
	var previousHost string
	for _, bucket := range series.Buckets {
		if !ValidLabel(bucket.Host) || bucket.Start.IsZero() || !validTrafficBucket(bucket) {
			return false
		}
		if !previous.IsZero() && bucket.Start.Before(previous) || bucket.Start.Equal(previous) && bucket.Host <= previousHost {
			return false
		}
		previous, previousHost = bucket.Start, bucket.Host
	}
	return true
}

func validTrafficBucket(bucket TrafficBucket) bool {
	return bucket.Requests >= 0 && bucket.Failed >= 0 && bucket.Cancelled >= 0 && bucket.Failed+bucket.Cancelled <= bucket.Requests &&
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

func addTrafficBucket(buckets *[]TrafficBucket, host string, start time.Time, stats transfer.Stats, responseBytes, duration int64, failed, cancelled bool) {
	list := *buckets
	index := len(list) - 1
	for index >= 0 && (list[index].Start.After(start) || list[index].Start.Equal(start) && list[index].Host > host) {
		index--
	}
	if index >= 0 && list[index].Start.Equal(start) && list[index].Host == host {
		addTrafficResult(&list[index], stats, responseBytes, duration, failed, cancelled)
		*buckets = list
		return
	}
	bucket := TrafficBucket{Host: host, Start: start}
	addTrafficResult(&bucket, stats, responseBytes, duration, failed, cancelled)
	list = append(list, TrafficBucket{})
	copy(list[index+2:], list[index+1:])
	list[index+1] = bucket
	*buckets = list
}

func addTrafficResult(bucket *TrafficBucket, stats transfer.Stats, responseBytes, duration int64, failed, cancelled bool) {
	bucket.Requests++
	if failed {
		bucket.Failed++
	}
	if cancelled {
		bucket.Cancelled++
	}
	bucket.BodyBytes += stats.BodyBytes
	bucket.UploadedChunkBytes += stats.UploadedChunkBytes
	bucket.EncodedUploadBytes += stats.RequestBodyBytesSent
	bucket.ReusedBodyBytes += stats.ReusedBodyBytes
	bucket.ResponseBytes += responseBytes
	bucket.DurationMillis += duration
}

func (r *Recorder) addTrafficLocked(at time.Time, stats transfer.Stats, responseBytes, duration int64, failed, cancelled bool) {
	addTrafficBucket(&r.data.Traffic.Hourly.Buckets, r.host, hourlyTrafficStart(at), stats, responseBytes, duration, failed, cancelled)
	addTrafficBucket(&r.data.Traffic.Daily.Buckets, r.host, dailyTrafficStart(at), stats, responseBytes, duration, failed, cancelled)
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
// validCaptureID mirrors the capture store's opaque random identifier format.
// It is deliberately not a general label: malformed history must fail startup.
func validCaptureID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

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

// Begin records a request without a client label. Older callers and clients
// that do not expose one keep working; their UI column stays empty.
func (r *Recorder) Begin(id, sessionID, upstream, kind string) uint64 {
	return r.BeginWithClient(id, sessionID, upstream, kind, "")
}

// BeginWithClient records the requesting UI/client identity alongside the
// opaque session and request metadata. Every observation is retained; there is
// no eviction or trimming path.
func (r *Recorder) BeginWithClient(id, sessionID, upstream, kind, client string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return 0
	}
	if !ValidLabel(sessionID) {
		sessionID = ""
	}
	if !ValidLabel(client) {
		client = ""
	}
	switch kind {
	case "primary", "title", "compaction", "generate":
	default:
		kind = "unknown"
	}
	now := time.Now().UTC()
	index := r.sessionIndex(r.host, sessionID)
	if index < 0 {
		r.data.Sessions = append(r.data.Sessions, Session{Host: r.host, ID: sessionID, StartedAt: now})
		index = len(r.data.Sessions) - 1
	}
	s := &r.data.Sessions[index]
	s.UpdatedAt, s.Upstream, s.LastRequestID = now, upstream, id
	if client != "" && !containsClient(s.Clients, client) {
		s.Clients = append(s.Clients, client)
	}
	s.Requests++
	s.Active++
	r.data.Totals.Requests++
	r.data.Totals.Active++
	r.hostTotalsLocked(r.host, func(t *Totals) {
		t.Requests++
		t.Active++
	})
	r.revision++
	r.sequence++
	r.data.RecentRequests = append(r.data.RecentRequests, Request{Host: r.host, Client: client, Sequence: r.sequence, ID: id, SessionID: sessionID, Upstream: upstream, Kind: kind, StartedAt: now, State: "running"})
	r.markDirty()
	return r.sequence
}

func containsClient(clients []string, client string) bool {
	for _, current := range clients {
		if current == client {
			return true
		}
	}
	return false
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
		cancelled := status == 499
		if cancelled {
			failed = false
		}
		request.FinishedAt, request.Status, request.ErrorCode = &now, status, code
		request.Transfer, request.ResponseBytes, request.DurationMillis = stats, responseBytes, duration
		request.State = "completed"
		if failed {
			request.State = "failed"
		}
		if cancelled {
			request.State = "cancelled"
		}
		s := &r.data.Sessions[r.sessionIndex(request.Host, request.SessionID)]
		s.UpdatedAt, s.LastStatus, s.LastError = now, status, code
		addResult(&s.Totals, failed, cancelled, stats, responseBytes, duration)
		addResult(&r.data.Totals, failed, cancelled, stats, responseBytes, duration)
		r.hostTotalsLocked(request.Host, func(t *Totals) { addResult(t, failed, cancelled, stats, responseBytes, duration) })
		r.addTrafficLocked(now, stats, responseBytes, duration, failed, cancelled)
		r.revision++
		r.markDirty()
		return
	}
}

// AttachCapture links an optional content capture without moving payloads into
// the metadata-only history file. A capture has its own independent retention.
func (r *Recorder) AttachCapture(sequence uint64, id string) {
	if sequence == 0 || id == "" || !validCaptureID(id) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.data.RecentRequests {
		if r.data.RecentRequests[i].Sequence == sequence {
			r.data.RecentRequests[i].CaptureID = id
			r.revision++
			r.markDirty()
			return
		}
	}
}

func addResult(t *Totals, failed, cancelled bool, stats transfer.Stats, responseBytes, duration int64) {
	t.Active--
	if failed {
		t.Failed++
	}
	if cancelled {
		t.Cancelled++
	}
	t.BodyBytes += stats.BodyBytes
	t.UploadedChunkBytes += stats.UploadedChunkBytes
	t.EncodedUploadBytes += stats.RequestBodyBytesSent
	t.ReusedBodyBytes += stats.ReusedBodyBytes
	t.ResponseBytes += responseBytes
	t.DurationMillis += duration
}

func (r *Recorder) sessionIndex(host, id string) int {
	for i := range r.data.Sessions {
		if r.data.Sessions[i].Host == host && r.data.Sessions[i].ID == id {
			return i
		}
	}
	return -1
}

// hostTotalsLocked keeps exact per-host totals independent of the retained
// session rows.
func (r *Recorder) hostTotalsLocked(host string, update func(*Totals)) {
	if r.data.HostTotals == nil {
		r.data.HostTotals = map[string]Totals{}
	}
	totals := r.data.HostTotals[host]
	update(&totals)
	r.data.HostTotals[host] = totals
}

func (r *Recorder) Snapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := r.data
	copy.Sessions = append([]Session{}, r.data.Sessions...)
	copy.RecentRequests = append([]Request{}, r.data.RecentRequests...)
	copy.Traffic.Hourly.Buckets = append([]TrafficBucket{}, r.data.Traffic.Hourly.Buckets...)
	copy.Traffic.Daily.Buckets = append([]TrafficBucket{}, r.data.Traffic.Daily.Buckets...)
	copy.HostTotals = make(map[string]Totals, len(r.data.HostTotals))
	for host, totals := range r.data.HostTotals {
		copy.HostTotals[host] = totals
	}
	copy.Host = r.host
	copy.Traffic.Hourly.RetentionSeconds = 0
	copy.Traffic.Daily.RetentionSeconds = 0
	copy.SessionLimit, copy.RequestLimit, copy.Persistent = SessionLimit, RequestLimit, r.path != ""
	sort.Slice(copy.Sessions, func(i, j int) bool {
		if copy.Sessions[i].UpdatedAt.Equal(copy.Sessions[j].UpdatedAt) {
			if copy.Sessions[i].Host == copy.Sessions[j].Host {
				return copy.Sessions[i].ID < copy.Sessions[j].ID
			}
			return copy.Sessions[i].Host < copy.Sessions[j].Host
		}
		return copy.Sessions[i].UpdatedAt.After(copy.Sessions[j].UpdatedAt)
	})
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
	snapshot.HostTotals = make(map[string]Totals, len(r.data.HostTotals))
	for host, totals := range r.data.HostTotals {
		snapshot.HostTotals[host] = totals
	}
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
