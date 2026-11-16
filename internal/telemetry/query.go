package telemetry

import (
	"sort"
	"time"
)

// Read projections never mutate the recorder or its persisted history.
type RangeQuery struct {
	Start, End time.Time
	Bucket     time.Duration
	Host       string
	Exact      bool
	Now        time.Time
}

type RangePoint struct {
	At                 int64 `json:"at"`
	End                int64 `json:"end"`
	Requests           int64 `json:"requests"`
	Failed             int64 `json:"failed"`
	Cancelled          int64 `json:"cancelled"`
	Body               int64 `json:"body"`
	Encoded            int64 `json:"encoded"`
	Reused             int64 `json:"reused"`
	UploadedChunkBytes int64 `json:"uploadedChunkBytes"`
	Response           int64 `json:"response"`
	Duration           int64 `json:"duration"`
}

type RangeSummary struct {
	Start              int64        `json:"start"`
	End                int64        `json:"end"`
	BucketMS           int64        `json:"bucket_ms"`
	Host               string       `json:"host"`
	Points             []RangePoint `json:"points"`
	Sessions           int          `json:"sessions"`
	ActiveSessions     int          `json:"active_sessions"`
	Running            int          `json:"running"`
	Source             string       `json:"source"`
	CoverageStart      int64        `json:"coverage_start"`
	Incomplete         bool         `json:"incomplete"`
	IncompleteSessions bool         `json:"incomplete_sessions"`
}

type RequestPage struct {
	Requests   []Request `json:"requests"`
	Total      int       `json:"total"`
	NextBefore uint64    `json:"next_before"`
}

// CompactSnapshot omits request entries and historical traffic buckets. Session
// totals remain available to the session browser; range points are bounded to
// 200 by the HTTP query validator.
func (r *Recorder) CompactSnapshot(query *RangeQuery, now time.Time) (Snapshot, *RangeSummary, []Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := r.data
	result.Sessions = append([]Session{}, r.data.Sessions...)
	result.RecentRequests = []Request{}
	result.Traffic.Hourly.Buckets = []TrafficBucket{}
	result.Traffic.Daily.Buckets = []TrafficBucket{}
	result.HostTotals = make(map[string]Totals, len(r.data.HostTotals))
	for host, totals := range r.data.HostTotals {
		result.HostTotals[host] = totals
	}
	result.Host = r.host
	result.Persistent = r.path != ""
	result.SessionLimit, result.RequestLimit = SessionLimit, RequestLimit
	sort.Slice(result.Sessions, func(i, j int) bool {
		if result.Sessions[i].UpdatedAt.Equal(result.Sessions[j].UpdatedAt) {
			if result.Sessions[i].Host == result.Sessions[j].Host {
				return result.Sessions[i].ID < result.Sessions[j].ID
			}
			return result.Sessions[i].Host < result.Sessions[j].Host
		}
		return result.Sessions[i].UpdatedAt.After(result.Sessions[j].UpdatedAt)
	})

	// Provider status needs only running requests and the latest completion per
	// upstream, not a copy of every retained request.
	providers := map[string]Request{}
	active := []Request{}
	var summary *RangeSummary
	sessions, activeSessions := map[string]bool{}, map[string]bool{}
	finished := int64(0)
	if query != nil {
		count := int((query.End.Sub(query.Start)-1)/query.Bucket) + 1
		summary = &RangeSummary{Start: query.Start.UnixMilli(), End: query.End.UnixMilli(), BucketMS: query.Bucket.Milliseconds(), Host: query.Host, Points: make([]RangePoint, count), Source: "requests", CoverageStart: r.data.Since.UnixMilli(), Incomplete: r.data.DroppedRequests > 0}
		if !query.Now.IsZero() {
			now = query.Now
		}
		for i := range summary.Points {
			start := query.Start.Add(time.Duration(i) * query.Bucket)
			end := start.Add(query.Bucket)
			if end.After(query.End) {
				end = query.End
			}
			summary.Points[i].At, summary.Points[i].End = start.UnixMilli(), end.UnixMilli()
		}
	}
	for _, request := range r.data.RecentRequests {
		if request.State == "running" {
			active = append(active, request)
		} else if request.FinishedAt != nil {
			previous, ok := providers[request.Upstream]
			if !ok || request.FinishedAt.After(*previous.FinishedAt) {
				providers[request.Upstream] = request
			}
		}
		if summary == nil || query.Host != "" && request.Host != query.Host {
			continue
		}
		if request.State == "running" {
			if !query.End.Before(now) && !request.StartedAt.Before(query.Start) && !request.StartedAt.After(now) {
				sessions[request.SessionID], activeSessions[request.SessionID] = true, true
				summary.Running++
			}
			continue
		}
		if request.FinishedAt == nil || request.FinishedAt.Before(query.Start) || !request.FinishedAt.Before(query.End) {
			continue
		}
		sessions[request.SessionID] = true
		finished++
		if !query.Exact {
			continue
		}
		point := &summary.Points[int(request.FinishedAt.Sub(query.Start)/query.Bucket)]
		point.Requests++
		if request.State == "failed" || request.State == "interrupted" {
			point.Failed++
		}
		if request.State == "cancelled" {
			point.Cancelled++
		}
		point.Body += request.Transfer.BodyBytes
		point.Encoded += request.Transfer.RequestBodyBytesSent
		point.Reused += request.Transfer.ReusedBodyBytes
		point.UploadedChunkBytes += request.Transfer.UploadedChunkBytes
		point.Response += request.ResponseBytes
		point.Duration += request.DurationMillis
	}
	for _, request := range providers {
		active = append(active, request)
	}
	if summary != nil {
		summary.Sessions, summary.ActiveSessions = len(sessions), len(activeSessions)
		if !query.Exact {
			// Keep the existing aggregate semantics for calendar presets,
			// including legacy bytes whose individual entries predate retention.
			series := r.data.Traffic.Hourly
			summary.Source = "hourly"
			hasHost := false
			for _, bucket := range series.Buckets {
				if query.Host == "" || bucket.Host == query.Host {
					hasHost = true
					break
				}
			}
			if query.End.Sub(query.Start) > 31*24*time.Hour || !hasHost {
				series = r.data.Traffic.Daily
				summary.Source = "daily"
			}
			summary.CoverageStart = series.Since.UnixMilli()
			for _, bucket := range series.Buckets {
				if query.Host != "" && bucket.Host != query.Host || !bucket.Start.Before(query.End) || !bucket.Start.Add(time.Duration(series.BucketSeconds)*time.Second).After(query.Start) {
					continue
				}
				index := 0
				if bucket.Start.After(query.Start) {
					index = int(bucket.Start.Sub(query.Start) / query.Bucket)
				}
				point := &summary.Points[index]
				point.Requests += bucket.Requests
				point.Failed += bucket.Failed
				point.Cancelled += bucket.Cancelled
				point.Body += bucket.BodyBytes
				point.Encoded += bucket.EncodedUploadBytes
				point.Reused += bucket.ReusedBodyBytes
				point.UploadedChunkBytes += bucket.UploadedChunkBytes
				point.Response += bucket.ResponseBytes
				point.Duration += bucket.DurationMillis
			}
		}
		var total int64
		for _, point := range summary.Points {
			total += point.Requests
		}
		summary.IncompleteSessions = r.data.DroppedRequests > 0 || r.data.EvictedSessions > 0 || finished < total
	}
	return result, summary, active
}

// Requests returns a bounded, newest-first page. A sequence cursor stays stable
// when new requests arrive. Total counts the entire matching retained history.
func (r *Recorder) Requests(session, host string, before uint64, limit int) RequestPage {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit < 1 || limit > 100 {
		limit = 50
	}
	page := RequestPage{Requests: []Request{}}
	for _, request := range r.data.RecentRequests {
		if request.SessionID != session || host != "" && request.Host != host {
			continue
		}
		page.Total++
		if before != 0 && request.Sequence >= before {
			continue
		}
		// History is usually sequence ordered, but persisted histories need not
		// be. Keep only the largest limit+1 sequences without copying all rows.
		index := sort.Search(len(page.Requests), func(i int) bool { return page.Requests[i].Sequence < request.Sequence })
		if index > limit {
			continue
		}
		page.Requests = append(page.Requests, Request{})
		copy(page.Requests[index+1:], page.Requests[index:])
		page.Requests[index] = request
		if len(page.Requests) > limit+1 {
			page.Requests = page.Requests[:limit+1]
		}
	}
	if len(page.Requests) > limit {
		page.Requests = page.Requests[:limit]
		page.NextBefore = page.Requests[len(page.Requests)-1].Sequence
	}
	return page
}
