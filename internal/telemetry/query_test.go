package telemetry

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestReadProjectionsPreserveAllHistoryOnDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	r := recorder(t, path)
	for i := 0; i < 235; i++ {
		sequence := r.Begin(fmt.Sprintf("request-%04d", i), "session", "mock", "primary")
		r.Finish(sequence, 200, false, "", sampleTransfer, 10, 100)
	}
	before := r.Snapshot()
	encodedBefore, _ := json.Marshal(before)
	now := time.Now().UTC()
	query := &RangeQuery{Start: now.Add(-time.Hour), End: now.Add(time.Second), Bucket: time.Hour, Exact: true}
	compact, summary, providers := r.CompactSnapshot(query, now)
	if len(compact.RecentRequests) != 0 || len(compact.Traffic.Hourly.Buckets) != 0 || len(summary.Points) != 2 || summary.Points[0].Requests != 235 || summary.Sessions != 1 || len(providers) != 1 {
		t.Fatalf("unexpected projection: %+v, %+v", compact, summary)
	}
	if compact.Totals != before.Totals || !reflect.DeepEqual(compact.Sessions, before.Sessions) {
		t.Fatal("compact projection changed lifetime totals")
	}
	var cursor uint64
	var sequences []uint64
	for {
		page := r.Requests("session", "", cursor, 8)
		if page.Total != 235 || len(page.Requests) > 8 {
			t.Fatalf("bad page: %+v", page)
		}
		for _, request := range page.Requests {
			sequences = append(sequences, request.Sequence)
		}
		if page.NextBefore == 0 {
			break
		}
		if page.NextBefore == cursor {
			t.Fatal("cursor did not advance")
		}
		cursor = page.NextBefore
	}
	if len(sequences) != 235 {
		t.Fatalf("pagination lost requests: %d", len(sequences))
	}
	for i, sequence := range sequences {
		if sequence != uint64(235-i) {
			t.Fatalf("out of order or duplicate request: %v", sequences)
		}
	}
	// The read projections must not even change metadata, let alone evict rows.
	encodedAfter, _ := json.Marshal(r.Snapshot())
	if string(encodedBefore) != string(encodedAfter) {
		t.Fatal("query mutated retained history")
	}
	r.Close()
	reopened := recorder(t, path)
	after := reopened.Snapshot()
	if len(after.RecentRequests) != 235 || after.Totals != before.Totals || after.DroppedRequests != before.DroppedRequests || after.EvictedSessions != before.EvictedSessions {
		t.Fatal("history did not survive read projections and restart")
	}
}

func TestExactRangeBoundariesHostsAndRunningRequests(t *testing.T) {
	r := recorder(t, "")
	start := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	end := start.Add(time.Minute)
	r.data.Since = start
	request := func(sequence uint64, host, session string, at time.Time, state string) Request {
		return Request{Sequence: sequence, Host: host, SessionID: session, Upstream: "mock", StartedAt: at, FinishedAt: &at, State: state, Transfer: sampleTransfer}
	}
	r.data.RecentRequests = []Request{
		request(1, "alpha", "shared", start, "completed"),
		request(2, "beta", "shared", start.Add(time.Second), "failed"),
		request(3, "alpha", "cancelled", end.Add(-time.Millisecond), "cancelled"),
		request(4, "alpha", "excluded", end, "completed"),
		request(5, "alpha", "excluded", start.Add(-time.Millisecond), "completed"),
		{Sequence: 6, Host: "alpha", SessionID: "active", State: "running", StartedAt: start.Add(time.Second)},
	}
	query := &RangeQuery{Start: start, End: end, Bucket: 30 * time.Second, Exact: true}
	_, summary, _ := r.CompactSnapshot(query, end)
	if summary.Points[0].Requests != 2 || summary.Points[1].Requests != 1 || summary.Points[0].Failed != 1 || summary.Points[1].Cancelled != 1 ||
		summary.Sessions != 3 || summary.ActiveSessions != 1 || summary.Running != 1 {
		t.Fatalf("incorrect exact range: %+v", summary)
	}
	query.Host = "alpha"
	_, summary, _ = r.CompactSnapshot(query, end.Add(time.Hour))
	if summary.Points[0].Requests != 1 || summary.Sessions != 2 || summary.Running != 0 {
		t.Fatalf("historical/host filtering failed: %+v", summary)
	}
	page := r.Requests("shared", "beta", 0, 8)
	if page.Total != 1 || page.Requests[0].Sequence != 2 {
		t.Fatal("request host filtering failed")
	}
}

func TestRequestCursorStableWhenNewRequestsArrive(t *testing.T) {
	r := recorder(t, "")
	for i := 0; i < 12; i++ {
		r.Begin(fmt.Sprintf("request-%d", i), "session", "mock", "primary")
	}
	// Exercise old imported files whose array order differs from sequence order.
	for i, j := 0, len(r.data.RecentRequests)-1; i < j; i, j = i+1, j-1 {
		r.data.RecentRequests[i], r.data.RecentRequests[j] = r.data.RecentRequests[j], r.data.RecentRequests[i]
	}
	first := r.Requests("session", "", 0, 8)
	r.Begin("new-request", "session", "mock", "primary")
	second := r.Requests("session", "", first.NextBefore, 8)
	if first.NextBefore != 5 || len(second.Requests) != 4 || second.Requests[0].Sequence != 4 || second.Requests[3].Sequence != 1 || second.NextBefore != 0 || second.Total != 13 {
		t.Fatalf("cursor shifted after insertion: %+v", second)
	}
}

func TestCalendarSummaryKeepsLegacyAggregates(t *testing.T) {
	r := recorder(t, "")
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	r.data.Traffic.Hourly = TrafficSeries{Since: start, BucketSeconds: 3600, Buckets: []TrafficBucket{
		{Host: "alpha", Start: start, Requests: 42, BodyBytes: 1000, EncodedUploadBytes: 100},
		{Host: "beta", Start: start, Requests: 2, BodyBytes: 20},
		{Host: "alpha", Start: start.Add(24 * time.Hour), Requests: 10},
	}}
	query := &RangeQuery{Start: start, End: start.Add(24 * time.Hour), Bucket: time.Hour, Host: "alpha"}
	_, summary, _ := r.CompactSnapshot(query, query.End)
	if summary.Points[0].Requests != 42 || summary.Points[0].Body != 1000 || summary.Source != "hourly" || !summary.IncompleteSessions {
		t.Fatalf("legacy aggregate totals were lost: %+v", summary)
	}
	query.Exact = true
	_, exact, _ := r.CompactSnapshot(query, query.End)
	if exact.Points[0].Requests != 0 {
		t.Fatal("exact range fabricated missing timestamps from aggregates")
	}
}
