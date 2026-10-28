package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/telemetry"
)

type ProviderStatus struct {
	Name       string     `json:"name"`
	Active     int        `json:"active"`
	LastStatus int        `json:"last_status"`
	LastError  string     `json:"last_error,omitempty"`
	LastSeen   *time.Time `json:"last_seen,omitempty"`
}

type DashboardSnapshot struct {
	Version     int       `json:"version"`
	CollectedAt time.Time `json:"collected_at"`
	Gateway     struct {
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
	var result DashboardSnapshot
	result.Version, result.CollectedAt = 1, time.Now().UTC()
	result.Gateway.StartedAt, result.Gateway.Active, result.Gateway.Concurrency = g.startedAt, g.active.Load(), g.config.MaxConcurrent
	result.Gateway.PendingCancellations, result.Gateway.ControlError = g.config.Client.ControlStatus()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	started := time.Now()
	health, err := g.config.Client.Health(ctx)
	result.Relay.Reachable = err == nil && health.Version == protocol.RelayVersion
	result.Relay.LatencyMS = time.Since(started).Milliseconds()
	result.Relay.Health = health
	result.History = g.history.Snapshot()
	result.Providers = make([]ProviderStatus, 0, len(g.config.Upstreams))
	seen := map[string]bool{}
	for _, rule := range g.config.Upstreams {
		if seen[rule.Name] {
			continue
		}
		seen[rule.Name] = true
		provider := ProviderStatus{Name: rule.Name}
		for _, request := range result.History.RecentRequests {
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
