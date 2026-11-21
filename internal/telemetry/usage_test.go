package telemetry

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"deltarelay/internal/transfer"
	"deltarelay/internal/usage"
)

func TestUsageScopesRequestsNotSessionLifetimes(t *testing.T) {
	r, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	at := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	for i, key := range []string{"a", "b", "a", ""} {
		id := r.Begin(strings.Repeat("r", 16)+key, "same-session", "provider", "primary")
		if key != "" {
			r.AttachAPIKey(id, &usage.Key{ID: strings.Repeat(key, 32), Name: "Saved " + key})
		}
		if i != 2 {
			r.AttachUsage(id, usage.Measurement{Version: 1, State: "complete", InputTokens: usage.Number(int64(10 + i)), OutputTokens: usage.Number(0)})
		}
		r.Finish(id, 200, false, "", transfer.Stats{BodyBytes: 100}, 20, 5)
		r.data.RecentRequests[i].StartedAt = at.Add(time.Duration(i) * time.Hour)
	}
	report := r.Usage(UsageQuery{Start: at, End: at.Add(2 * time.Hour)})
	if report.Requests != 2 || report.SessionCount != 1 || *report.Metrics.InputTokens != 21 || len(report.Sessions) != 1 || report.Sessions[0].Requests != 2 {
		t.Fatalf("%+v", report)
	}
	report = r.Usage(UsageQuery{Key: strings.Repeat("a", 32)})
	if report.Requests != 2 || report.Metrics.InputRequests != 1 || report.Metrics.CompleteRequests != 1 || *report.Metrics.InputTokens != 10 || len(report.Sessions[0].APIKeys) != 1 || report.Sessions[0].BodyBytes != 200 {
		t.Fatalf("%+v", report)
	}
	report = r.Usage(UsageQuery{Key: "unknown"})
	if report.Requests != 1 || report.UnknownKeyRequests != 1 || report.Sessions[0].UnknownKeyRequests != 1 {
		t.Fatalf("%+v", report)
	}
	report = r.Usage(UsageQuery{Start: at.Add(20 * time.Hour), End: at.Add(21 * time.Hour)})
	if report.Requests != 0 || report.Metrics.InputTokens != nil || len(report.Keys) != 2 {
		t.Fatalf("empty range lost historical keys or invented zero tokens: %+v", report)
	}
}

func TestUsageSeriesBucketsByModelAndFoldsTheTail(t *testing.T) {
	r, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	at := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	models := []struct {
		name          string
		input, output int64
	}{
		{"model-a", 700, 70},
		{"model-b", 600, 60},
		{"model-c", 500, 50},
		{"model-d", 400, 40},
		{"model-e", 300, 30},
		{"model-f", 200, 20},
		{"model-g", 100, 10},
	}
	for index, model := range models {
		id := r.Begin(fmt.Sprintf("usage-series-%02d", index), "series-session", "provider", "primary")
		r.AttachUsage(id, usage.Measurement{Version: 1, State: "complete", Model: model.name, InputTokens: usage.Number(model.input), OutputTokens: usage.Number(model.output)})
		r.Finish(id, 200, false, "", transfer.Stats{}, 1, 1)
		offset := 10 + index*10
		if index >= 3 {
			offset = 70 + (index-3)*10
		}
		for request := range r.data.RecentRequests {
			if r.data.RecentRequests[request].Sequence == id {
				r.data.RecentRequests[request].StartedAt = at.Add(time.Duration(offset) * time.Minute)
			}
		}
	}
	// A request with no token report still counts toward bucket coverage.
	id := r.Begin("usage-series-unmeasured", "series-session", "provider", "primary")
	r.Finish(id, 200, false, "", transfer.Stats{}, 1, 1)
	for request := range r.data.RecentRequests {
		if r.data.RecentRequests[request].Sequence == id {
			r.data.RecentRequests[request].StartedAt = at.Add(110 * time.Minute)
		}
	}
	if report := r.Usage(UsageQuery{Start: at, End: at.Add(2 * time.Hour)}); report.Series != nil {
		t.Fatal("series was built without a bucket")
	}
	report := r.Usage(UsageQuery{Start: at, End: at.Add(2 * time.Hour), Bucket: time.Hour})
	series := report.Series
	if series == nil || series.BucketMillis != 3_600_000 || len(series.Points) != 2 || len(series.Models) != 6 {
		t.Fatalf("unexpected series: %+v", series)
	}
	names := make([]string, len(series.Models))
	for index, model := range series.Models {
		names[index] = model.Model
	}
	if strings.Join(names, ",") != "model-a,model-b,model-c,model-d,model-e,Other models" {
		t.Fatalf("unexpected model order: %v", names)
	}
	other := series.Models[5]
	if other.Requests != 2 || *other.InputTokens != 300 || *other.OutputTokens != 30 {
		t.Fatalf("unexpected other bucket: %+v", other)
	}
	first, second := series.Points[0], series.Points[1]
	if first.Requests != 3 || first.MeasuredRequests != 3 || *first.InputTokens != 1800 || *first.OutputTokens != 180 {
		t.Fatalf("unexpected first bucket: %+v", first)
	}
	if len(first.Models) != 3 || first.Models[0].Model != "model-a" || first.Models[2].Model != "model-c" {
		t.Fatalf("unexpected first bucket models: %+v", first.Models)
	}
	if second.Requests != 5 || second.MeasuredRequests != 4 || len(second.Models) != 3 || second.Models[2].Model != "Other models" {
		t.Fatalf("unexpected second bucket: %+v", second)
	}
}

func TestUsageSurvivesRestartAndDoesNotAliasReports(t *testing.T) {
	file := filepath.Join(t.TempDir(), "stats.json")
	r, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	id := r.Begin("usage-request-0001", "session", "provider", "primary")
	r.AttachAPIKey(id, &usage.Key{ID: strings.Repeat("a", 32), Name: "Personal"})
	r.AttachUsage(id, usage.Measurement{Version: 1, State: "complete", InputTokens: usage.Number(0), OutputTokens: usage.Number(5)})
	r.Finish(id, 200, false, "", transfer.Stats{}, 2, 3)
	report := r.Usage(UsageQuery{})
	*report.Metrics.InputTokens = 99
	if got := r.Usage(UsageQuery{}); *got.Metrics.InputTokens != 0 {
		t.Fatal("caller mutated retained measurements")
	}
	r.Close()
	r, err = Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	page := r.FilteredRequests(UsageQuery{Key: strings.Repeat("a", 32)}, 0, 8)
	if page.Total != 1 || page.Requests[0].Usage == nil || *page.Requests[0].Usage.InputTokens != 0 || page.Requests[0].APIKey.Name != "Personal" {
		t.Fatalf("%+v", page)
	}
	data, _ := json.Marshal(r.Usage(UsageQuery{}))
	if strings.Contains(string(data), "input_tokens\":null") {
		t.Fatal("measured zero turned into null")
	}
}

func TestBackfillAPIKeyOnlyFillsUnknownRequests(t *testing.T) {
	r, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	known := usage.Key{ID: strings.Repeat("a", 32), Name: "Known"}
	historical := usage.Key{ID: strings.Repeat("b", 32), Name: "Historical"}
	begin := func(key *usage.Key, suffix string) {
		id := r.Begin("backfill-request-"+suffix, "session", "provider", "primary")
		if key != nil {
			r.AttachAPIKey(id, key)
		}
		r.Finish(id, 200, false, "", transfer.Stats{}, 0, 0)
	}
	begin(&known, "known")
	begin(nil, "unknown-one")
	begin(nil, "unknown-two")

	used, unknown := r.APIKeyAttribution()
	if unknown["provider"] != 2 || len(used) != 1 {
		t.Fatalf("used=%v unknown=%v", used, unknown)
	}
	if changed := r.BackfillAPIKey(historical, "provider"); changed != 2 {
		t.Fatalf("changed=%d", changed)
	}
	used, unknown = r.APIKeyAttribution()
	if len(unknown) != 0 || len(used) != 2 {
		t.Fatalf("used=%v unknown=%v", used, unknown)
	}
	if report := r.Usage(UsageQuery{Key: historical.ID}); report.Requests != 2 || report.UnknownKeyRequests != 0 {
		t.Fatalf("%+v", report)
	}
	if changed := r.BackfillAPIKey(historical, ""); changed != 0 {
		t.Fatalf("second backfill changed %d requests", changed)
	}
}
