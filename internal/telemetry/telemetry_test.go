package telemetry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

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
	if reopened.Snapshot().RecentRequests[2].State != "cancelled" {
		t.Fatal("cancellation not recorded")
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
	r := recorder(t, path)
	// Moving the parent makes new atomic temporary files impossible. Do not
	// chmod: tests can also run as root, where permission failures differ.
	moved := directory + "-moved"
	if err := os.Rename(directory, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(moved, directory) })
	sequence := r.Begin("request-00000000001", "ses_1", "mock", "primary")
	r.Finish(sequence, 200, false, "", sampleTransfer, 0, 1)
	if s := r.Snapshot(); !s.PersistenceError || s.Totals.Requests != 1 || s.Totals.BodyBytes != sampleTransfer.BodyBytes {
		t.Fatalf("save failure broke live history: %+v", s)
	}
}
