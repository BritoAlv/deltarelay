package telemetry

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/fsx"
	transferstats "deltarelay/internal/transfer"
)

var sampleTransfer = transferstats.Stats{BodyBytes: 10000, UploadedChunkBytes: 700, RequestBodyBytesSent: 450, ReusedBodyBytes: 9000}

func recorder(t *testing.T, path string) *Recorder {
	t.Helper()
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func recorderWith(t *testing.T, path string, write func(string, any) error, flushAfter, shutdown time.Duration) *Recorder {
	t.Helper()
	r, err := openRecorder(path, write, flushAfter, shutdown)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func readSnapshot(t *testing.T, path string) Snapshot {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestAggregationAndConcurrentRequests(t *testing.T) {
	r := recorder(t, "")
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sequence := r.Begin(fmt.Sprintf("request-%016d", i), fmt.Sprintf("ses_%d", i%4), "mock", "primary")
			_ = r.Snapshot()
			r.Finish(sequence, 200, false, "", sampleTransfer, 25, 100)
			// Finishing twice must not double-count or take active below zero.
			r.Finish(sequence, 200, false, "", sampleTransfer, 25, 100)
		}(i)
	}
	wg.Wait()
	s := r.Snapshot()
	if len(s.Sessions) != 4 || s.Totals.Requests != 64 || s.Totals.Active != 0 || s.Totals.BodyBytes != 640000 || s.Totals.EncodedUploadBytes != 28800 || s.Totals.ResponseBytes != 1600 {
		t.Fatalf("unexpected totals: %+v", s.Totals)
	}
	for _, session := range s.Sessions {
		if session.Active != 0 || session.Requests != 16 {
			t.Fatalf("bad session totals: %+v", session)
		}
	}
	s.Sessions[0].ID = "mutated"
	s.RecentRequests[0].ID = "mutated"
	if r.Snapshot().Sessions[0].ID == "mutated" || r.Snapshot().RecentRequests[0].ID == "mutated" {
		t.Fatal("snapshot shared mutable slices")
	}
}

func TestPrivatePersistenceAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	r := recorder(t, path)
	completed := r.Begin("completed-request-0001", "ses_first", "mock", "primary")
	r.Finish(completed, 200, false, "", sampleTransfer, 17, 42)
	r.Begin("running-request-00001", "ses_first", "mock", "compaction")
	if _, err := Open(path); err == nil {
		t.Fatal("two gateways could overwrite the same history file")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("history is not private")
	}
	r.Close()
	reopened := recorder(t, path)
	s := reopened.Snapshot()
	if !s.Persistent || s.PersistenceError || s.Totals.Requests != 2 || s.Totals.Active != 0 || s.Totals.Failed != 1 || s.Totals.BodyBytes != sampleTransfer.BodyBytes {
		t.Fatalf("restart lost or inflated counters: %+v", s)
	}
	if s.RecentRequests[1].State != "interrupted" || s.RecentRequests[1].ErrorCode != "gateway_restarted" || s.Sessions[0].LastError != "gateway_restarted" {
		t.Fatal("restart still reports old requests as running")
	}
	newID := reopened.Begin("new-request-000000001", "ses_first", "mock", "title")
	if newID <= s.RecentRequests[1].Sequence {
		t.Fatal("request sequence reused after restart")
	}
	reopened.Finish(newID, 499, true, "", transferstats.Stats{}, 0, 30)
	final := reopened.Snapshot()
	if final.RecentRequests[2].State != "cancelled" {
		t.Fatal("cancellation not recorded")
	}
	if final.Totals.Failed != 1 || final.Totals.Cancelled != 1 || final.Sessions[0].Failed != 1 || final.Sessions[0].Cancelled != 1 {
		t.Fatalf("cancellation was counted as a failure: totals=%+v session=%+v", final.Totals, final.Sessions[0].Totals)
	}
}

func TestBoundedRetentionPreservesGlobalTotalsAndActiveRequests(t *testing.T) {
	r := recorder(t, "")
	active := r.Begin("active-request-000001", "ses_active", "mock", "primary")
	for i := 0; i < SessionLimit+30; i++ {
		sequence := r.Begin(fmt.Sprintf("request-%016d", i), fmt.Sprintf("ses_%d", i), "mock", "primary")
		r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	}
	s := r.Snapshot()
	if len(s.Sessions) != SessionLimit || s.EvictedSessions != 31 || s.Totals.Requests != SessionLimit+31 || s.Totals.Active != 1 {
		t.Fatalf("retention failed: sessions=%d evicted=%d totals=%+v", len(s.Sessions), s.EvictedSessions, s.Totals)
	}
	if r.sessionIndex("ses_active") < 0 {
		t.Fatal("evicted a running session")
	}
	r.Finish(active, 200, false, "", sampleTransfer, 0, 1)
	for i := 0; i < RequestLimit+20; i++ {
		sequence := r.Begin(fmt.Sprintf("recent-request-%016d", i), "ses_recent", "mock", "primary")
		r.Finish(sequence, 503, true, "relay_unreachable", sampleTransfer, 0, 1)
	}
	s = r.Snapshot()
	if len(s.RecentRequests) != RequestLimit || s.DroppedRequests == 0 || s.Totals.Active != 0 || s.Totals.Failed != RequestLimit+20 || s.Totals.BodyBytes != s.Totals.Requests*sampleTransfer.BodyBytes {
		t.Fatalf("request retention changed totals: %+v", s.Totals)
	}
}

func TestInvalidLabelsAndKindsAreNotRecorded(t *testing.T) {
	r := recorder(t, "")
	for _, id := range []string{"../private", "https://secret", "session title", "<script>", strings.Repeat("a", 129)} {
		sequence := r.Begin("request-00000000001", id, "mock", "arbitrary-private-kind")
		r.Finish(sequence, 200, false, "", transferstats.Stats{}, 0, 1)
	}
	s := r.Snapshot()
	if len(s.Sessions) != 1 || s.Sessions[0].ID != "" || s.RecentRequests[0].Kind != "unknown" {
		t.Fatal("invalid metadata was retained")
	}
}

func TestRefusesUnsafeOrCorruptHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	for _, contents := range []string{`{`, `{"version":99}`, `null`, `{}` + `{}`} {
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(path); err == nil {
			t.Fatalf("accepted invalid history: %q", contents)
		}
	}
	r := recorder(t, "")
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	data, _ := json.Marshal(r.Snapshot())
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("accepted world-readable history")
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(link); err == nil {
		t.Fatal("accepted symlinked history")
	}
}

func TestPersistenceFailureDoesNotLoseLiveStatistics(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "history.json")
	r := recorderWith(t, path, fsx.WriteJSON, 2*time.Millisecond, time.Second)
	// Moving the parent makes new atomic temporary files impossible. Do not
	// chmod: tests can also run as root, where permission failures differ.
	moved := directory + "-moved"
	if err := os.Rename(directory, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(moved, directory) })
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	waitFor(t, "persistence failure to be reported", func() bool { return r.Snapshot().PersistenceError })
	if s := r.Snapshot(); s.Totals.Requests != 1 || s.Totals.BodyBytes != sampleTransfer.BodyBytes {
		t.Fatalf("save failure broke live history: %+v", s)
	}
}

func TestSlowPersistenceDoesNotDelayAccounting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	var block atomic.Bool
	blocked := make(chan struct{}, 1)
	release := make(chan struct{})
	write := func(p string, value any) error {
		if block.Load() {
			select {
			case blocked <- struct{}{}:
			default:
			}
			<-release
		}
		return fsx.WriteJSON(p, value)
	}
	r := recorderWith(t, path, write, time.Millisecond, time.Second)
	block.Store(true)
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("background writer never started")
	}
	started := time.Now()
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	_ = r.Snapshot()
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("accounting waited for slow persistence: %s", elapsed)
	}
	close(release)
}

func TestPersistenceFailureIsRetriedWithTheNewestSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	var fail atomic.Bool
	write := func(p string, value any) error {
		if fail.Load() {
			return errors.New("injected persistence failure")
		}
		return fsx.WriteJSON(p, value)
	}
	r := recorderWith(t, path, write, 2*time.Millisecond, time.Second)
	fail.Store(true)
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	waitFor(t, "injected persistence failure", func() bool { return r.Snapshot().PersistenceError })
	fail.Store(false)
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	waitFor(t, "successful retry", func() bool { return !r.Snapshot().PersistenceError })
	waitFor(t, "newest snapshot to reach disk", func() bool {
		snapshot := readSnapshot(t, path)
		return snapshot.Totals.Requests == 1 && snapshot.Totals.BodyBytes == sampleTransfer.BodyBytes
	})
}

func TestOlderSnapshotsCannotOverwriteNewerOnes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	var block atomic.Bool
	blocked := make(chan struct{}, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	var requests []int64
	write := func(p string, value any) error {
		snapshot := value.(Snapshot)
		if block.Load() {
			select {
			case blocked <- struct{}{}:
			default:
			}
			<-release
		}
		mu.Lock()
		requests = append(requests, snapshot.Totals.Requests)
		mu.Unlock()
		return fsx.WriteJSON(p, snapshot)
	}
	r := recorderWith(t, path, write, time.Millisecond, 2*time.Second)
	block.Store(true)
	r.Begin("request-00000000001", "ses_1", "mock", "primary")
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("background writer never started")
	}
	// These updates arrive while an older snapshot is still being written.
	r.Begin("request-00000000002", "ses_1", "mock", "primary")
	r.Begin("request-00000000003", "ses_1", "mock", "primary")
	close(release)
	waitFor(t, "coalesced write of the newest snapshot", func() bool {
		return readSnapshot(t, path).Totals.Requests == 3
	})
	r.Close()
	mu.Lock()
	defer mu.Unlock()
	for i := 1; i < len(requests); i++ {
		if requests[i] < requests[i-1] {
			t.Fatalf("persisted an older snapshot after a newer one: %v", requests)
		}
	}
	if len(requests) == 0 || requests[len(requests)-1] != 3 {
		t.Fatalf("newest snapshot was not persisted last: %v", requests)
	}
}

func TestCloseFlushesFinalSnapshotAndIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	r := recorder(t, path)
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	r.Close()
	r.Close()
	if snapshot := readSnapshot(t, path); snapshot.Totals.Requests != 1 || snapshot.Totals.BodyBytes != sampleTransfer.BodyBytes {
		t.Fatalf("final flush did not persist the last snapshot: %+v", snapshot.Totals)
	}
	if r.Begin("request-00000000002", "ses_1", "mock", "primary") != 0 {
		t.Fatal("recorder accepted work after Close")
	}
}

func TestFinalFlushFailureDoesNotHangClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	var slow atomic.Bool
	write := func(p string, value any) error {
		if slow.Load() {
			time.Sleep(250 * time.Millisecond)
			return errors.New("injected final flush failure")
		}
		return fsx.WriteJSON(p, value)
	}
	r := recorderWith(t, path, write, time.Hour, 20*time.Millisecond)
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	slow.Store(true)
	started := time.Now()
	r.Close()
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Close waited for a hung final flush: %s", elapsed)
	}
	// The worker still owns the lock until its bounded write returns.
	<-r.done
	if !r.Snapshot().PersistenceError {
		t.Fatal("final flush failure was not reported")
	}
}

func TestMemoryRecorderIgnoresPersistenceAndClosesRepeatedly(t *testing.T) {
	r := recorder(t, "")
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	r.Close()
	r.Close()
	if s := r.Snapshot(); s.Persistent || s.PersistenceError || s.Totals.Requests != 1 {
		t.Fatalf("memory-only recorder changed semantics: %+v", s)
	}
}

func TestTrafficAggregatesFinishedRequests(t *testing.T) {
	r := recorder(t, "")
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 25, 100)
	failed := r.Begin("request-00000000002", "ses_1", "mock", "primary")
	r.Finish(failed, 503, true, "relay_unreachable", sampleTransfer, 30, 120)
	cancelled := r.Begin("request-00000000003", "ses_1", "mock", "primary")
	r.Finish(cancelled, 499, true, "request_cancelled", sampleTransfer, 5, 40)
	s := r.Snapshot()
	if s.Totals.Failed != 1 || s.Totals.Cancelled != 1 || s.Totals.Active != 0 {
		t.Fatalf("unexpected totals: %+v", s.Totals)
	}
	for _, series := range []TrafficSeries{s.Traffic.Hourly, s.Traffic.Daily} {
		if len(series.Buckets) != 1 {
			t.Fatalf("expected one traffic bucket, got %+v", series.Buckets)
		}
		bucket := series.Buckets[0]
		if bucket.Requests != 3 || bucket.Failed != 1 || bucket.Cancelled != 1 || bucket.BodyBytes != sampleTransfer.BodyBytes*3 ||
			bucket.EncodedUploadBytes != sampleTransfer.RequestBodyBytesSent*3 || bucket.ReusedBodyBytes != sampleTransfer.ReusedBodyBytes*3 ||
			bucket.ResponseBytes != 60 || bucket.DurationMillis != 260 {
			t.Fatalf("unexpected traffic bucket: %+v", bucket)
		}
	}
	s.Traffic.Hourly.Buckets[0].BodyBytes = -1
	if r.Snapshot().Traffic.Hourly.Buckets[0].BodyBytes != sampleTransfer.BodyBytes*3 {
		t.Fatal("snapshot shared mutable traffic buckets")
	}
}

func TestTrafficBucketInsertionMergesAndOrders(t *testing.T) {
	start := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	var buckets []TrafficBucket
	addTrafficBucket(&buckets, start, sampleTransfer, 1, 2, false, false)
	addTrafficBucket(&buckets, start.Add(2*time.Hour), sampleTransfer, 3, 4, false, true)
	addTrafficBucket(&buckets, start.Add(time.Hour), sampleTransfer, 5, 6, false, false)
	addTrafficBucket(&buckets, start, sampleTransfer, 7, 8, false, false)
	if len(buckets) != 3 || !buckets[0].Start.Equal(start) || !buckets[1].Start.Equal(start.Add(time.Hour)) || !buckets[2].Start.Equal(start.Add(2*time.Hour)) {
		t.Fatalf("traffic buckets are not ordered: %+v", buckets)
	}
	if buckets[0].Requests != 2 || buckets[0].BodyBytes != sampleTransfer.BodyBytes*2 || buckets[1].Requests != 1 || buckets[2].Cancelled != 1 || buckets[2].Failed != 0 {
		t.Fatalf("traffic buckets did not merge or retain cancellations: %+v", buckets)
	}
}

func TestTrafficRetentionTrimsOldBuckets(t *testing.T) {
	now := time.Now().UTC()
	series := TrafficSeries{
		BucketSeconds:    3600,
		RetentionSeconds: int64(HourlyTrafficRetention / time.Second),
		Buckets: []TrafficBucket{
			{Start: now.Add(-HourlyTrafficRetention - time.Hour), Requests: 1},
			{Start: now.Add(-time.Hour), Requests: 1},
		},
	}
	trimmed := trimTrafficSeries(series, now)
	if len(trimmed.Buckets) != 1 || !trimmed.Buckets[0].Start.Equal(now.Add(-time.Hour)) {
		t.Fatalf("retention did not trim the oldest bucket: %+v", trimmed.Buckets)
	}
}

func TestTrafficBackfillsLegacyHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	r := recorder(t, "")
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 25, 100)
	failed := r.Begin("request-00000000002", "ses_1", "mock", "primary")
	r.Finish(failed, 503, true, "relay_unreachable", sampleTransfer, 30, 120)
	cancelled := r.Begin("request-00000000003", "ses_1", "mock", "primary")
	r.Finish(cancelled, 499, true, "request_cancelled", sampleTransfer, 5, 40)
	legacy := r.Snapshot()
	legacy.Traffic = Traffic{}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	reopened := recorder(t, path)
	s := reopened.Snapshot()
	for _, series := range []TrafficSeries{s.Traffic.Hourly, s.Traffic.Daily} {
		if series.Since.IsZero() || len(series.Buckets) != 1 || series.Buckets[0].Requests != 3 || series.Buckets[0].Failed != 1 || series.Buckets[0].Cancelled != 1 || series.Buckets[0].BodyBytes != sampleTransfer.BodyBytes*3 {
			t.Fatalf("legacy traffic was not backfilled: %+v", series.Buckets)
		}
	}
}

func TestTrafficPersistsAndRejectsCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	r := recorder(t, path)
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 25, 100)
	r.Close()
	reopened := recorder(t, path)
	if s := reopened.Snapshot(); len(s.Traffic.Hourly.Buckets) != 1 || len(s.Traffic.Daily.Buckets) != 1 {
		t.Fatalf("traffic did not survive restart: %+v", s.Traffic)
	}
	reopened.Close()
	corrupt := readSnapshot(t, path)
	corrupt.Traffic.Hourly.Buckets = append(corrupt.Traffic.Hourly.Buckets, corrupt.Traffic.Hourly.Buckets[0])
	data, err := json.Marshal(corrupt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("accepted duplicate traffic buckets")
	}
}

func TestTrafficTrimsOnLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	r := recorder(t, "")
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 25, 100)
	snapshot := r.Snapshot()
	now := time.Now().UTC()
	snapshot.Traffic.Hourly.Buckets = []TrafficBucket{
		{Start: hourlyTrafficStart(now.Add(-HourlyTrafficRetention - time.Hour)), Requests: 1},
		{Start: hourlyTrafficStart(now), Requests: 1},
	}
	snapshot.Traffic.Daily.Buckets = []TrafficBucket{
		{Start: dailyTrafficStart(now.Add(-DailyTrafficRetention - 24*time.Hour)), Requests: 1},
		{Start: dailyTrafficStart(now), Requests: 1},
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	reopened := recorder(t, path)
	s := reopened.Snapshot()
	if len(s.Traffic.Hourly.Buckets) != 1 || len(s.Traffic.Daily.Buckets) != 1 {
		t.Fatalf("traffic retention was not applied on load: hourly=%d daily=%d", len(s.Traffic.Hourly.Buckets), len(s.Traffic.Daily.Buckets))
	}
}
