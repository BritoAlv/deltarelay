package telemetry

import (
	"sort"
	"time"

	"deltarelay/internal/usage"
)

func (r *Recorder) AttachAPIKey(sequence uint64, key *usage.Key) {
	if key == nil || !validCaptureID(key.ID) || key.Name == "" || usage.Label(key.Name) != key.Name {
		return
	}
	copy := *key
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.data.RecentRequests {
		if r.data.RecentRequests[i].Sequence == sequence {
			r.data.RecentRequests[i].APIKey = &copy
			r.revision++
			r.markDirty()
			return
		}
	}
}

// APIKeyAttribution reports which saved-credential identities already appear
// in retained requests and how many requests still have no attribution,
// grouped by gateway upstream.
func (r *Recorder) APIKeyAttribution() (map[string]struct{}, map[string]int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	used := make(map[string]struct{})
	unknown := make(map[string]int64)
	for _, request := range r.data.RecentRequests {
		if request.APIKey == nil {
			unknown[request.Upstream]++
			continue
		}
		used[request.APIKey.ID] = struct{}{}
	}
	return used, unknown
}

// BackfillAPIKey attributes retained requests from one upstream that have no
// saved-credential match to one saved credential. It is a one-time historical
// assumption, not a live fallback: new requests with unknown credentials remain
// unattributed. An empty upstream matches every upstream.
func (r *Recorder) BackfillAPIKey(key usage.Key, upstream string) int {
	if !validCaptureID(key.ID) || key.Name == "" || usage.Label(key.Name) != key.Name {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return 0
	}
	changed := 0
	for i := range r.data.RecentRequests {
		if r.data.RecentRequests[i].APIKey != nil {
			continue
		}
		if upstream != "" && r.data.RecentRequests[i].Upstream != upstream {
			continue
		}
		copy := key
		r.data.RecentRequests[i].APIKey = &copy
		changed++
	}
	if changed > 0 {
		r.revision++
		r.markDirty()
	}
	return changed
}

func (r *Recorder) AttachUsage(sequence uint64, measurement usage.Measurement) {
	if !usage.Valid(&measurement) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.data.RecentRequests {
		if r.data.RecentRequests[i].Sequence == sequence {
			r.data.RecentRequests[i].Usage = &measurement
			r.revision++
			r.markDirty()
			return
		}
	}
}

// UsageQuery always uses local request start time, never last session activity
// or completion-time traffic buckets. An empty key includes all keys; "unknown"
// explicitly selects observations without a saved credential match.
type UsageQuery struct {
	Start, End time.Time
	Host, Key  string
	Session    *string
	// Bucket requests a bucketed series for the overview chart. It is ignored
	// unless Start and End are set.
	Bucket time.Duration
}

func (q UsageQuery) Matches(request Request) bool {
	if q.Host != "" && q.Host != request.Host || q.Session != nil && *q.Session != request.SessionID {
		return false
	}
	if !q.Start.IsZero() && request.StartedAt.Before(q.Start) || !q.End.IsZero() && !request.StartedAt.Before(q.End) {
		return false
	}
	if q.Key == "unknown" {
		return request.APIKey == nil
	}
	return q.Key == "" || request.APIKey != nil && request.APIKey.ID == q.Key
}

type UsageKey struct {
	usage.Key
	Requests int64 `json:"requests"`
}

type UsageSession struct {
	Session
	Hosts              []string        `json:"hosts"`
	APIKeys            []usage.Key     `json:"api_keys"`
	UnknownKeyRequests int64           `json:"unknown_key_requests"`
	Metrics            usage.Aggregate `json:"metrics"`
}

type UsageReport struct {
	Version              int             `json:"version"`
	Since                time.Time       `json:"since"`
	Keys                 []UsageKey      `json:"keys"`
	Requests             int64           `json:"requests"`
	SessionCount         int64           `json:"session_count"`
	UnattributedRequests int64           `json:"unattributed_requests"`
	UnknownKeyRequests   int64           `json:"unknown_key_requests"`
	Metrics              usage.Aggregate `json:"metrics"`
	Sessions             []UsageSession  `json:"sessions"`
	IncompleteHistory    bool            `json:"incomplete_history"`
	Series               *UsageSeries    `json:"series,omitempty"`
}

// UsageSeries is the bucketed, model-attributed projection used by the
// Overview chart. Models are ranked by observed tokens for the selected
// window; the tail folds into one neutral "Other models" entry.
type UsageSeries struct {
	BucketMillis int64              `json:"bucket_ms"`
	Models       []UsageSeriesModel `json:"models"`
	Points       []UsageSeriesPoint `json:"points"`
}

type UsageSeriesModel struct {
	Model        string `json:"model"`
	Requests     int64  `json:"requests"`
	InputTokens  *int64 `json:"input_tokens"`
	OutputTokens *int64 `json:"output_tokens"`
}

type UsageSeriesPoint struct {
	Start            time.Time          `json:"start"`
	Requests         int64              `json:"requests"`
	MeasuredRequests int64              `json:"measured_requests"`
	InputTokens      *int64             `json:"input_tokens"`
	OutputTokens     *int64             `json:"output_tokens"`
	PeakContext      *int64             `json:"peak_context"`
	Models           []UsageSeriesModel `json:"models"`
}

const (
	usageSeriesPointLimit = 200
	usageSeriesModelLimit = 5
	usageOtherModels      = "Other models"
	usageUnknownModel     = "Unknown model"
)

type usageSeriesAccumulator struct {
	requests      int64
	metrics       usage.Aggregate
	models        map[string]*usage.Aggregate
	modelRequests map[string]int64
}

func requestModel(m *usage.Measurement) string {
	if m == nil {
		return usageUnknownModel
	}
	if m.Model != "" {
		return m.Model
	}
	if m.ResponseModel != "" {
		return m.ResponseModel
	}
	return usageUnknownModel
}

func cloneNumber(value *int64) *int64 {
	if value == nil {
		return nil
	}
	n := *value
	return &n
}

func addNumber(target **int64, value *int64) {
	if value == nil {
		return
	}
	if *target == nil {
		*target = usage.Number(0)
	}
	*target = usage.Number(min(usage.MaxCounter, **target+*value))
}

func usageModelTokens(value *usage.Aggregate) int64 {
	var total int64
	if value.InputTokens != nil {
		total += *value.InputTokens
	}
	if value.OutputTokens != nil {
		total += *value.OutputTokens
	}
	return total
}

func newUsageSeries(query UsageQuery) (*UsageSeries, []*usageSeriesAccumulator) {
	if query.Bucket <= 0 || query.Start.IsZero() || query.End.IsZero() {
		return nil, nil
	}
	span := query.End.Sub(query.Start)
	if span <= 0 {
		return nil, nil
	}
	count := int((span + query.Bucket - 1) / query.Bucket)
	if count < 1 {
		count = 1
	}
	if count > usageSeriesPointLimit {
		count = usageSeriesPointLimit
	}
	points := make([]UsageSeriesPoint, count)
	accumulators := make([]*usageSeriesAccumulator, count)
	for index := range points {
		points[index].Start = query.Start.Add(time.Duration(index) * query.Bucket)
		accumulators[index] = &usageSeriesAccumulator{models: map[string]*usage.Aggregate{}, modelRequests: map[string]int64{}}
	}
	return &UsageSeries{BucketMillis: query.Bucket.Milliseconds(), Models: []UsageSeriesModel{}, Points: points}, accumulators
}

func appendUsageSeries(series *UsageSeries, accumulators []*usageSeriesAccumulator, totals map[string]*usage.Aggregate, requests map[string]int64) {
	ordered := make([]string, 0, len(totals))
	for model := range totals {
		ordered = append(ordered, model)
	}
	sort.Slice(ordered, func(i, j int) bool {
		left, right := usageModelTokens(totals[ordered[i]]), usageModelTokens(totals[ordered[j]])
		if left == right {
			return ordered[i] < ordered[j]
		}
		return left > right
	})
	top := ordered
	if len(top) > usageSeriesModelLimit {
		top = top[:usageSeriesModelLimit]
	}
	topSet := make(map[string]bool, len(top))
	for _, model := range top {
		topSet[model] = true
		series.Models = append(series.Models, UsageSeriesModel{
			Model: model, Requests: requests[model],
			InputTokens: cloneNumber(totals[model].InputTokens), OutputTokens: cloneNumber(totals[model].OutputTokens),
		})
	}
	var other usage.Aggregate
	var otherRequests int64
	for _, model := range ordered[len(top):] {
		addNumber(&other.InputTokens, totals[model].InputTokens)
		addNumber(&other.OutputTokens, totals[model].OutputTokens)
		otherRequests += requests[model]
	}
	if otherRequests > 0 {
		series.Models = append(series.Models, UsageSeriesModel{
			Model: usageOtherModels, Requests: otherRequests,
			InputTokens: cloneNumber(other.InputTokens), OutputTokens: cloneNumber(other.OutputTokens),
		})
	}
	for index := range series.Points {
		point := &series.Points[index]
		accumulator := accumulators[index]
		point.Requests = accumulator.requests
		point.MeasuredRequests = accumulator.metrics.MeasuredRequests
		point.InputTokens = cloneNumber(accumulator.metrics.InputTokens)
		point.OutputTokens = cloneNumber(accumulator.metrics.OutputTokens)
		point.PeakContext = cloneNumber(accumulator.metrics.PeakContext)
		point.Models = []UsageSeriesModel{}
		for _, model := range top {
			value := accumulator.models[model]
			if value == nil || value.InputTokens == nil && value.OutputTokens == nil {
				continue
			}
			point.Models = append(point.Models, UsageSeriesModel{
				Model: model, Requests: accumulator.modelRequests[model],
				InputTokens: cloneNumber(value.InputTokens), OutputTokens: cloneNumber(value.OutputTokens),
			})
		}
		if otherRequests > 0 {
			var otherPoint usage.Aggregate
			var otherPointRequests int64
			for model, value := range accumulator.models {
				if topSet[model] {
					continue
				}
				addNumber(&otherPoint.InputTokens, value.InputTokens)
				addNumber(&otherPoint.OutputTokens, value.OutputTokens)
				otherPointRequests += accumulator.modelRequests[model]
			}
			if otherPoint.InputTokens != nil || otherPoint.OutputTokens != nil {
				point.Models = append(point.Models, UsageSeriesModel{
					Model: usageOtherModels, Requests: otherPointRequests,
					InputTokens: cloneNumber(otherPoint.InputTokens), OutputTokens: cloneNumber(otherPoint.OutputTokens),
				})
			}
		}
	}
}

func (r *Recorder) Usage(query UsageQuery) UsageReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := UsageReport{Version: 1, Since: r.data.Since, Keys: []UsageKey{}, Sessions: []UsageSession{}, IncompleteHistory: r.data.DroppedRequests > 0}
	keys := map[string]*UsageKey{}
	sessions := map[string]*UsageSession{}
	series, seriesAccumulators := newUsageSeries(query)
	var modelTotals map[string]*usage.Aggregate
	var modelRequests map[string]int64
	if series != nil {
		modelTotals = map[string]*usage.Aggregate{}
		modelRequests = map[string]int64{}
	}
	for _, request := range r.data.RecentRequests {
		// The selector keeps historical keys reachable even if a period is empty.
		if request.APIKey != nil && (query.Host == "" || query.Host == request.Host) {
			key := keys[request.APIKey.ID]
			if key == nil {
				key = &UsageKey{Key: *request.APIKey}
				keys[key.ID] = key
			}
			key.Name = request.APIKey.Name
			key.Requests++
		}
		if !query.Matches(request) {
			continue
		}
		result.Requests++
		result.Metrics.Add(request.Usage, request.StartedAt)
		if series != nil {
			index := int(request.StartedAt.Sub(query.Start) / query.Bucket)
			if index < 0 {
				index = 0
			} else if index >= len(seriesAccumulators) {
				index = len(seriesAccumulators) - 1
			}
			accumulator := seriesAccumulators[index]
			accumulator.requests++
			accumulator.metrics.Add(request.Usage, request.StartedAt)
			if request.Usage != nil && (request.Usage.InputTokens != nil || request.Usage.OutputTokens != nil) {
				model := requestModel(request.Usage)
				total := modelTotals[model]
				if total == nil {
					total = &usage.Aggregate{}
					modelTotals[model] = total
				}
				total.Add(request.Usage, request.StartedAt)
				modelRequests[model]++
				value := accumulator.models[model]
				if value == nil {
					value = &usage.Aggregate{}
					accumulator.models[model] = value
				}
				value.Add(request.Usage, request.StartedAt)
				accumulator.modelRequests[model]++
			}
		}
		if request.SessionID == "" {
			result.UnattributedRequests++
		}
		if request.APIKey == nil {
			result.UnknownKeyRequests++
		}
		s := sessions[request.SessionID]
		if s == nil {
			s = &UsageSession{Session: Session{ID: request.SessionID, StartedAt: request.StartedAt, UpdatedAt: request.StartedAt}, Hosts: []string{}, APIKeys: []usage.Key{}}
			sessions[request.SessionID] = s
			if request.SessionID != "" {
				result.SessionCount++
			}
		}
		if !containsClient(s.Hosts, request.Host) {
			s.Hosts = append(s.Hosts, request.Host)
		}
		if request.Client != "" && !containsClient(s.Clients, request.Client) {
			s.Clients = append(s.Clients, request.Client)
		}
		if request.APIKey == nil {
			s.UnknownKeyRequests++
		} else {
			found := false
			for i, k := range s.APIKeys {
				if k.ID == request.APIKey.ID {
					s.APIKeys[i] = *request.APIKey
					found = true
					break
				}
			}
			if !found {
				s.APIKeys = append(s.APIKeys, *request.APIKey)
			}
		}
		s.Requests++
		if request.State == "running" {
			s.Active++
		}
		if request.State == "failed" || request.State == "interrupted" {
			s.Failed++
		}
		if request.State == "cancelled" {
			s.Cancelled++
		}
		s.BodyBytes += request.Transfer.BodyBytes
		s.EncodedUploadBytes += request.Transfer.RequestBodyBytesSent
		s.UploadedChunkBytes += request.Transfer.UploadedChunkBytes
		s.ReusedBodyBytes += request.Transfer.ReusedBodyBytes
		s.ResponseBytes += request.ResponseBytes
		s.DurationMillis += request.DurationMillis
		s.Metrics.Add(request.Usage, request.StartedAt)
		if request.StartedAt.Before(s.StartedAt) {
			s.StartedAt = request.StartedAt
		}
		at := request.StartedAt
		if request.FinishedAt != nil {
			at = *request.FinishedAt
		}
		if !at.Before(s.UpdatedAt) {
			s.UpdatedAt, s.Upstream, s.LastRequestID, s.LastStatus, s.LastError = at, request.Upstream, request.ID, request.Status, request.ErrorCode
		}
	}
	for _, key := range keys {
		result.Keys = append(result.Keys, *key)
	}
	sort.Slice(result.Keys, func(i, j int) bool {
		if result.Keys[i].Name == result.Keys[j].Name {
			return result.Keys[i].ID < result.Keys[j].ID
		}
		return result.Keys[i].Name < result.Keys[j].Name
	})
	for _, s := range sessions {
		sort.Strings(s.Hosts)
		sort.Slice(s.APIKeys, func(i, j int) bool {
			if s.APIKeys[i].Name == s.APIKeys[j].Name {
				return s.APIKeys[i].ID < s.APIKeys[j].ID
			}
			return s.APIKeys[i].Name < s.APIKeys[j].Name
		})
		result.Sessions = append(result.Sessions, *s)
	}
	sort.Slice(result.Sessions, func(i, j int) bool {
		if result.Sessions[i].UpdatedAt.Equal(result.Sessions[j].UpdatedAt) {
			return result.Sessions[i].ID < result.Sessions[j].ID
		}
		return result.Sessions[i].UpdatedAt.After(result.Sessions[j].UpdatedAt)
	})
	if series != nil {
		appendUsageSeries(series, seriesAccumulators, modelTotals, modelRequests)
		result.Series = series
	}
	return result
}

func (r *Recorder) UsageRequests(query UsageQuery) []Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := []Request{}
	for _, request := range r.data.RecentRequests {
		if query.Matches(request) {
			result = append(result, request)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Sequence > result[j].Sequence })
	return result
}

func (r *Recorder) FilteredRequests(query UsageQuery, before uint64, limit int) RequestPage {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit < 1 || limit > 100 {
		limit = 50
	}
	page := RequestPage{Requests: []Request{}}
	for _, request := range r.data.RecentRequests {
		if !query.Matches(request) {
			continue
		}
		page.Total++
		if before != 0 && request.Sequence >= before {
			continue
		}
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
