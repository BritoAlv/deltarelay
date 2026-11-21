package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/inspection"
	"deltarelay/internal/protocol"
	"deltarelay/internal/telemetry"
)

type ProviderStatus struct {
	Name       string     `json:"name"`
	Origin     string     `json:"origin,omitempty"`
	PathPrefix string     `json:"path_prefix,omitempty"`
	Active     int        `json:"active"`
	LastStatus int        `json:"last_status"`
	LastError  string     `json:"last_error,omitempty"`
	LastSeen   *time.Time `json:"last_seen,omitempty"`
}

type DashboardSnapshot struct {
	RequestsPaged bool                    `json:"requests_paged,omitempty"`
	Overview      *telemetry.RangeSummary `json:"overview,omitempty"`
	Inspection    *inspection.Status      `json:"inspection,omitempty"`
	Version       int                     `json:"version"`
	CollectedAt   time.Time               `json:"collected_at"`
	Gateway       struct {
		StartedAt            time.Time `json:"started_at"`
		Active               int64     `json:"active"`
		Concurrency          int       `json:"concurrency"`
		PendingCancellations int       `json:"pending_cancellations"`
		ControlError         string    `json:"control_error,omitempty"`
	} `json:"gateway"`
	Relay struct {
		Reachable bool          `json:"reachable"`
		LatencyMS int64         `json:"latency_ms"`
		Health    client.Health `json:"health"`
	} `json:"relay"`
	Providers []ProviderStatus   `json:"providers"`
	History   telemetry.Snapshot `json:"history"`
}

func (g *Gateway) dashboard(w http.ResponseWriter, r *http.Request) {
	query, err := dashboardRange(r)
	if err != nil {
		http.Error(w, "invalid dashboard range", http.StatusBadRequest)
		return
	}
	var result DashboardSnapshot
	result.Version, result.CollectedAt = 1, time.Now().UTC()
	if status := g.inspection.Status(); status.Enabled {
		result.Inspection = &status
	}
	result.Gateway.StartedAt, result.Gateway.Active, result.Gateway.Concurrency = g.startedAt, g.active.Load(), g.config.MaxConcurrent
	result.Gateway.PendingCancellations, result.Gateway.ControlError = g.config.Client.ControlStatus()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	started := time.Now()
	health, err := g.config.Client.Health(ctx)
	result.Relay.Reachable = err == nil && health.Version == protocol.RelayVersion
	result.Relay.LatencyMS = time.Since(started).Milliseconds()
	result.Relay.Health = health
	var providerRequests []telemetry.Request
	if r.URL.Query().Get("compact") == "1" {
		result.RequestsPaged = true
		result.History, result.Overview, providerRequests = g.history.CompactSnapshot(query, result.CollectedAt)
	} else {
		result.History = g.history.Snapshot()
		providerRequests = result.History.RecentRequests
	}
	result.Providers = make([]ProviderStatus, 0, len(g.config.Upstreams))
	seen := map[string]bool{}
	for _, rule := range g.config.Upstreams {
		if seen[rule.Name] {
			continue
		}
		seen[rule.Name] = true
		provider := ProviderStatus{Name: rule.Name, Origin: rule.Origin, PathPrefix: rule.PathPrefix}
		for _, request := range providerRequests {
			if request.Upstream != rule.Name {
				continue
			}
			if request.State == "running" {
				provider.Active++
			}
			if request.FinishedAt != nil && (provider.LastSeen == nil || request.FinishedAt.After(*provider.LastSeen)) {
				provider.LastSeen, provider.LastStatus, provider.LastError = request.FinishedAt, request.Status, request.ErrorCode
			}
		}
		result.Providers = append(result.Providers, provider)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func dashboardRange(r *http.Request) (*telemetry.RangeQuery, error) {
	values := r.URL.Query()
	if values.Get("start") == "" && values.Get("end") == "" && values.Get("bucket") == "" {
		return nil, nil
	}
	start, e1 := strconv.ParseInt(values.Get("start"), 10, 64)
	end, e2 := strconv.ParseInt(values.Get("end"), 10, 64)
	bucket, e3 := strconv.ParseInt(values.Get("bucket"), 10, 64)
	host := values.Get("host")
	// Epoch milliseconds; keep duration arithmetic safe and response size
	// bounded without imposing any retention policy.
	if e1 != nil || e2 != nil || e3 != nil || start < 0 || end <= start || end > 8640000000000000 || end-start > int64((100*365*24*time.Hour)/time.Millisecond) || bucket < 1 || bucket > end-start || (end-start-1)/bucket >= 200 || host != "" && !telemetry.ValidLabel(host) {
		return nil, strconv.ErrSyntax
	}
	var now time.Time
	if values.Has("now") {
		value, err := strconv.ParseInt(values.Get("now"), 10, 64)
		if err != nil || value < 0 || value > 8640000000000000 {
			return nil, strconv.ErrSyntax
		}
		now = time.UnixMilli(value)
	}
	return &telemetry.RangeQuery{Start: time.UnixMilli(start), End: time.UnixMilli(end), Bucket: time.Duration(bucket) * time.Millisecond, Host: host, Exact: values.Get("exact") == "1", Now: now}, nil
}

func (g *Gateway) dashboardRequests(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()
	session, host := values.Get("session"), values.Get("host")
	if !values.Has("session") || session != "" && !telemetry.ValidLabel(session) || host != "" && !telemetry.ValidLabel(host) {
		http.Error(w, "invalid session or host", http.StatusBadRequest)
		return
	}
	before, limit := uint64(0), 50
	var err error
	if values.Has("before") {
		before, err = strconv.ParseUint(values.Get("before"), 10, 64)
		if err != nil || before > 9007199254740991 {
			http.Error(w, "invalid cursor", http.StatusBadRequest)
			return
		}
	}
	if values.Has("limit") {
		limit, err = strconv.Atoi(values.Get("limit"))
		if err != nil || limit < 1 || limit > 100 {
			http.Error(w, "invalid page size", http.StatusBadRequest)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	query, queryErr := usageQuery(r)
	if queryErr != nil {
		http.Error(w, "invalid request filter", http.StatusBadRequest)
		return
	}
	_ = json.NewEncoder(w).Encode(g.history.FilteredRequests(query, before, limit))
}
