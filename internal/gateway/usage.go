package gateway

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"deltarelay/internal/telemetry"
	"deltarelay/internal/usage"
)

type usageExportTransfer struct {
	BodyBytes            int64 `json:"body_bytes"`
	Chunks               int   `json:"chunks"`
	UniqueChunks         int   `json:"unique_chunks"`
	UploadedChunks       int   `json:"uploaded_chunks"`
	UploadedChunkBytes   int64 `json:"uploaded_chunk_bytes"`
	MissingChunkBytes    int64 `json:"missing_chunk_bytes"`
	ReusedBodyBytes      int64 `json:"reused_body_bytes"`
	RequestBodyBytesSent int64 `json:"request_body_bytes_sent"`
	Requests             int64 `json:"requests"`
	DurationMillis       int64 `json:"duration_ms"`
}

// usageExportRequest is a metrics-only projection. It intentionally excludes
// capture IDs, request headers, body hashes, and saved-credential identities.
type usageExportRequest struct {
	RequestID      string              `json:"request_id"`
	SessionID      string              `json:"session_id"`
	APIKeyLabel    string              `json:"api_key_label"`
	Host           string              `json:"host"`
	Upstream       string              `json:"upstream"`
	Client         string              `json:"client,omitempty"`
	Kind           string              `json:"kind"`
	StartedAt      time.Time           `json:"started_at"`
	FinishedAt     *time.Time          `json:"finished_at,omitempty"`
	State          string              `json:"state"`
	Status         int                 `json:"status"`
	ErrorCode      string              `json:"error_code,omitempty"`
	Transfer       usageExportTransfer `json:"transfer"`
	ResponseBytes  int64               `json:"response_bytes"`
	DurationMillis int64               `json:"duration_ms"`
	Usage          *usage.Measurement  `json:"usage,omitempty"`
}

func usageQuery(r *http.Request) (telemetry.UsageQuery, error) {
	v := r.URL.Query()
	q := telemetry.UsageQuery{Host: v.Get("host"), Key: v.Get("key")}
	if q.Host != "" && !telemetry.ValidLabel(q.Host) || q.Key != "" && q.Key != "unknown" && !validUsageID(q.Key) {
		return q, errors.New("invalid usage filter")
	}
	if v.Has("session") {
		s := v.Get("session")
		if s != "" && !telemetry.ValidLabel(s) {
			return q, errors.New("invalid session")
		}
		q.Session = &s
	}
	if v.Has("start") || v.Has("end") {
		start, e1 := strconv.ParseInt(v.Get("start"), 10, 64)
		end, e2 := strconv.ParseInt(v.Get("end"), 10, 64)
		if e1 != nil || e2 != nil || start < 0 || end <= start || end > 8640000000000000 {
			return q, errors.New("invalid usage range")
		}
		q.Start, q.End = time.UnixMilli(start), time.UnixMilli(end)
	}
	if v.Has("bucket") {
		bucket, err := strconv.ParseInt(v.Get("bucket"), 10, 64)
		if err != nil || bucket <= 0 || bucket > 3650*24*60*60*1000 || q.Start.IsZero() || q.End.IsZero() {
			return q, errors.New("invalid usage bucket")
		}
		q.Bucket = time.Duration(bucket) * time.Millisecond
		if (q.End.Sub(q.Start)+q.Bucket-1)/q.Bucket > 200 {
			return q, errors.New("usage bucket produces too many points")
		}
	}
	return q, nil
}

func validUsageID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (g *Gateway) dashboardUsage(w http.ResponseWriter, r *http.Request) {
	q, err := usageQuery(r)
	if err != nil {
		http.Error(w, "invalid usage query", 400)
		return
	}
	report := g.history.Usage(q)
	// The selector must offer every saved credential, including credentials that
	// have not been observed in this period (or at all). Secrets never leave memory.
	known := make(map[string]bool, len(report.Keys))
	for _, key := range report.Keys {
		known[key.ID] = true
	}
	for _, key := range g.credentialNames.keys() {
		if known[key.ID] {
			continue
		}
		known[key.ID] = true
		report.Keys = append(report.Keys, telemetry.UsageKey{Key: key})
	}
	sort.Slice(report.Keys, func(i, j int) bool {
		if report.Keys[i].Name == report.Keys[j].Name {
			return report.Keys[i].ID < report.Keys[j].ID
		}
		return report.Keys[i].Name < report.Keys[j].Name
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(report)
}

// backfillHistoricalUsageKey resolves the legacy state where retained requests
// have no attribution. It assigns unattributed history per upstream when
// exactly one unobserved saved credential maps to that upstream. If multiple
// credentials are candidates, that upstream remains unknown rather than
// guessed. A final conservative fallback applies only when one unobserved
// credential and one unattributed upstream remain.
func (g *Gateway) backfillHistoricalUsageKey() {
	if g.config.OpenCodeServiceFile == "" {
		return
	}
	if !g.credentialNames.waitReady() {
		return
	}
	used, unknown := g.history.APIKeyAttribution()
	if len(unknown) == 0 {
		return
	}
	candidates := map[string][]usage.Key{}
	for _, credential := range g.credentialNames.saved() {
		if _, observed := used[credential.Key.ID]; observed {
			continue
		}
		if upstream := g.upstreamForIntegration(credential.Integration); upstream != "" {
			candidates[upstream] = append(candidates[upstream], credential.Key)
		}
	}
	for upstream, keys := range candidates {
		if unknown[upstream] == 0 || len(keys) != 1 {
			continue
		}
		g.history.BackfillAPIKey(keys[0], upstream)
	}

	// If one credential and one unattributed upstream remain, the integration
	// name did not map cleanly but the historical intent is still unambiguous.
	used, unknown = g.history.APIKeyAttribution()
	if len(unknown) != 1 {
		return
	}
	var candidate *usage.Key
	for _, credential := range g.credentialNames.saved() {
		if _, observed := used[credential.Key.ID]; observed {
			continue
		}
		if candidate != nil {
			return
		}
		copy := credential.Key
		candidate = &copy
	}
	if candidate == nil {
		return
	}
	for upstream := range unknown {
		if unknown[upstream] > 0 {
			g.history.BackfillAPIKey(*candidate, upstream)
		}
	}
}

// upstreamForIntegration maps a local OpenCode integration label to exactly one
// configured gateway upstream. Different provider names or custom upstream
// labels leave the mapping ambiguous, so nothing is guessed.
func (g *Gateway) upstreamForIntegration(integration string) string {
	integration = strings.ToLower(strings.TrimSpace(integration))
	if integration == "" {
		return ""
	}
	matches := func(value string) map[string]bool {
		found := map[string]bool{}
		for _, rule := range g.config.Upstreams {
			name := strings.ToLower(rule.Name)
			host := ""
			if parsed, err := url.Parse(rule.Origin); err == nil {
				host = strings.ToLower(parsed.Hostname())
			}
			if name == value || host == value || strings.HasSuffix(host, "."+value) || strings.HasPrefix(name, value+"-") || strings.HasPrefix(host, value+".") {
				found[rule.Name] = true
			}
		}
		return found
	}
	if found := matches(integration); len(found) == 1 {
		for name := range found {
			return name
		}
	}
	// A suffix such as "-go" distinguishes the saved integration from the
	// gateway's upstream label (opencode-go -> opencode).
	if base, _, ok := strings.Cut(integration, "-"); ok && base != "" && base != integration {
		if found := matches(base); len(found) == 1 {
			for name := range found {
				return name
			}
		}
	}
	return ""
}

func csvText(s string) string {
	if strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "=") || strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "+") || strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "-") || strings.HasPrefix(strings.TrimLeft(s, " \t\r\n"), "@") {
		return "'" + s
	}
	return s
}

func (g *Gateway) dashboardUsageExport(w http.ResponseWriter, r *http.Request) {
	q, err := usageQuery(r)
	format := r.URL.Query().Get("format")
	if err != nil || format != "csv" && format != "json" {
		http.Error(w, "invalid usage export", 400)
		return
	}
	requests := g.history.UsageRequests(q)
	w.Header().Set("Content-Disposition", `attachment; filename="deltarelay-local-usage.`+format+`"`)
	if format == "json" {
		w.Header().Set("Content-Type", "application/json")
		exported := make([]usageExportRequest, 0, len(requests))
		for _, request := range requests {
			label := "Unknown credential"
			if request.APIKey != nil {
				label = request.APIKey.Name
			}
			stats := request.Transfer
			exported = append(exported, usageExportRequest{
				RequestID: request.ID, SessionID: request.SessionID, APIKeyLabel: label,
				Host: request.Host, Upstream: request.Upstream, Client: request.Client,
				Kind: request.Kind, StartedAt: request.StartedAt, FinishedAt: request.FinishedAt,
				State: request.State, Status: request.Status, ErrorCode: request.ErrorCode,
				Transfer: usageExportTransfer{
					BodyBytes: stats.BodyBytes, Chunks: stats.Chunks, UniqueChunks: stats.UniqueChunks,
					UploadedChunks: stats.UploadedChunks, UploadedChunkBytes: stats.UploadedChunkBytes,
					MissingChunkBytes: stats.MissingChunkBytes, ReusedBodyBytes: stats.ReusedBodyBytes,
					RequestBodyBytesSent: stats.RequestBodyBytesSent, Requests: stats.Requests,
					DurationMillis: stats.DurationMillis,
				},
				ResponseBytes: request.ResponseBytes, DurationMillis: request.DurationMillis,
				Usage: request.Usage,
			})
		}
		_ = json.NewEncoder(w).Encode(struct {
			Version   int                  `json:"version"`
			TimeBasis string               `json:"time_basis"`
			Requests  []usageExportRequest `json:"requests"`
		}{1, "local_request_start", exported})
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	writer := csv.NewWriter(w)
	defer writer.Flush()
	_ = writer.Write([]string{"request_id", "session_id", "api_key_label", "host", "provider", "model", "response_model", "kind", "started_at", "finished_at", "state", "http_status", "duration_ms", "usage_state", "usage_source", "usage_reason", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "messages", "tools", "max_output_tokens", "first_response_ms", "body_bytes", "encoded_upload_bytes", "response_bytes"})
	num := func(n *int64) string {
		if n == nil {
			return ""
		}
		return strconv.FormatInt(*n, 10)
	}
	for _, request := range requests {
		label := "Unknown credential"
		if request.APIKey != nil {
			label = request.APIKey.Name
		}
		finished := ""
		if request.FinishedAt != nil {
			finished = request.FinishedAt.Format(time.RFC3339Nano)
		}
		model, responseModel, usageState, source, reason := "", "", "unavailable", "", "predates_usage_tracking"
		numbers := make([]string, 10)
		if m := request.Usage; m != nil {
			model, responseModel, usageState, source, reason = m.Model, m.ResponseModel, m.State, m.Source, m.Reason
			for i, n := range []*int64{m.InputTokens, m.OutputTokens, m.TotalTokens, m.CacheReadTokens, m.CacheWriteTokens, m.ReasoningTokens, m.Messages, m.Tools, m.MaxOutputTokens, m.FirstResponseMS} {
				numbers[i] = num(n)
			}
		}
		row := []string{request.ID, request.SessionID, csvText(label), request.Host, csvText(request.Upstream), csvText(model), csvText(responseModel), request.Kind, request.StartedAt.Format(time.RFC3339Nano), finished, request.State, strconv.Itoa(request.Status), strconv.FormatInt(request.DurationMillis, 10), usageState, source, reason}
		row = append(row, numbers...)
		row = append(row, strconv.FormatInt(request.Transfer.BodyBytes, 10), strconv.FormatInt(request.Transfer.RequestBodyBytesSent, 10), strconv.FormatInt(request.ResponseBytes, 10))
		if writer.Write(row) != nil {
			return
		}
	}
}
