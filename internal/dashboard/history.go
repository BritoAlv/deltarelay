package dashboard

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// State history is a bounded read-only view of the supervisor's private
// state-history.jsonl. The dashboard never reads that file or forwards a
// browser query unchanged. Only three numeric parameters are accepted and the
// response shape is decoded before it reaches the browser.

const (
	maxHistoryBuckets   = 2000
	maxHistoryIntervals = 6000
	maxHistorySpan      = 3660 * 86400
	maxHistoryBody      = 1 << 20
)

var historyStates = []string{"connected", "recovering", "unreachable", "host_stopped", "no_internet", "stopped", "off", "unknown"}

type stateSeconds struct {
	Connected   int64 `json:"connected"`
	Recovering  int64 `json:"recovering"`
	Unreachable int64 `json:"unreachable"`
	HostStopped int64 `json:"host_stopped"`
	NoInternet  int64 `json:"no_internet"`
	Stopped     int64 `json:"stopped"`
	Off         int64 `json:"off"`
	Unknown     int64 `json:"unknown"`
}

func (s stateSeconds) values() [8]int64 {
	return [8]int64{s.Connected, s.Recovering, s.Unreachable, s.HostStopped,
		s.NoInternet, s.Stopped, s.Off, s.Unknown}
}

type stateHistoryBucket struct {
	Start   string       `json:"start"`
	Seconds stateSeconds `json:"seconds"`
}

type stateHistoryInterval struct {
	Start string `json:"start"`
	End   string `json:"end"`
	State string `json:"state"`
}

type stateHistoryCurrent struct {
	State string `json:"state"`
	Since string `json:"since"`
}

type SystemHistory struct {
	Version           int                    `json:"version"`
	TrackingSince     string                 `json:"tracking_since"`
	GeneratedAt       string                 `json:"generated_at"`
	Start             string                 `json:"start"`
	End               string                 `json:"end"`
	BucketSeconds     int64                  `json:"bucket_seconds"`
	States            []string               `json:"states"`
	Buckets           []stateHistoryBucket   `json:"buckets"`
	Intervals         []stateHistoryInterval `json:"intervals"`
	IntervalsComplete bool                   `json:"intervals_complete"`
	Totals            stateSeconds           `json:"totals"`
	Current           stateHistoryCurrent    `json:"current"`
	Persistent        bool                   `json:"persistent"`
	StorageError      bool                   `json:"storage_error"`
}

func historyQuery(raw string) (string, bool) {
	if len(raw) > 160 {
		return "", false
	}
	query, err := url.ParseQuery(raw)
	if err != nil || len(query) != 3 {
		return "", false
	}
	for key := range query {
		if key != "start" && key != "end" && key != "bucket" {
			return "", false
		}
	}
	values := map[string]int64{}
	for _, key := range []string{"start", "end", "bucket"} {
		items, ok := query[key]
		if !ok || len(items) != 1 || items[0] == "" || len(items[0]) > 16 {
			return "", false
		}
		for _, c := range items[0] {
			if c < '0' || c > '9' {
				return "", false
			}
		}
		value, err := strconv.ParseInt(items[0], 10, 64)
		if err != nil || value > 253402300799 {
			return "", false
		}
		values[key] = value
	}
	start, end, bucket := values["start"], values["end"], values["bucket"]
	if start >= end || end-start > maxHistorySpan || bucket < 1 || (end-start+bucket-1)/bucket > maxHistoryBuckets {
		return "", false
	}
	return query.Encode(), true
}

func sameStates(value []string) bool {
	if len(value) != len(historyStates) {
		return false
	}
	for index := range historyStates {
		if value[index] != historyStates[index] {
			return false
		}
	}
	return true
}

func stateIndex(value string) int {
	for index, state := range historyStates {
		if value == state {
			return index
		}
	}
	return -1
}

func bucketLimit(span, bucket, index int64) int64 {
	remaining := span - index*bucket
	if remaining < bucket {
		return remaining
	}
	return bucket
}

func secondsFields(raw json.RawMessage, maximum int64) (stateSeconds, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != len(historyStates) {
		return stateSeconds{}, false
	}
	for _, name := range historyStates {
		value, ok := fields[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return stateSeconds{}, false
		}
	}
	var result stateSeconds
	if json.Unmarshal(raw, &result) != nil {
		return stateSeconds{}, false
	}
	for _, value := range result.values() {
		if value < 0 || value > maximum {
			return stateSeconds{}, false
		}
	}
	return result, true
}

func parseHistoryTime(value string) (time.Time, bool) {
	if !statusTimestamp(value) {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}

// decodeSystemHistory validates the supervisor's bounded aggregate response.
// Unknown fields are dropped by the typed decode; missing or null required
// fields, fraction/strings masquerading as counters, inconsistent totals and
// unbounded arrays fail closed.
func decodeSystemHistory(data []byte) (SystemHistory, bool) {
	var history SystemHistory
	root := statusFields(data, "version", "tracking_since", "generated_at", "start", "end",
		"bucket_seconds", "states", "buckets", "intervals", "intervals_complete", "totals", "current", "persistent", "storage_error")
	if root == nil || json.Unmarshal(data, &history) != nil || history.Version != 1 {
		return SystemHistory{}, false
	}
	if !sameStates(history.States) || history.BucketSeconds < 1 || history.BucketSeconds > maxHistorySpan {
		return SystemHistory{}, false
	}
	start, startOK := parseHistoryTime(history.Start)
	end, endOK := parseHistoryTime(history.End)
	trackingSince, trackingOK := parseHistoryTime(history.TrackingSince)
	generatedAt, generatedOK := parseHistoryTime(history.GeneratedAt)
	if !startOK || !endOK || !trackingOK || !generatedOK || !start.Before(end) || trackingSince.After(generatedAt) {
		return SystemHistory{}, false
	}
	bucket := time.Duration(history.BucketSeconds) * time.Second
	spanSeconds := int64(end.Sub(start) / time.Second)
	if spanSeconds < 1 || spanSeconds > maxHistorySpan || (spanSeconds+history.BucketSeconds-1)/history.BucketSeconds > maxHistoryBuckets {
		return SystemHistory{}, false
	}
	var buckets []json.RawMessage
	if !json.Valid(root["buckets"]) || json.Unmarshal(root["buckets"], &buckets) != nil || buckets == nil || len(history.Buckets) != len(buckets) || len(buckets) != int((spanSeconds+history.BucketSeconds-1)/history.BucketSeconds) {
		return SystemHistory{}, false
	}
	var sums [8]int64
	for index, raw := range buckets {
		fields := statusFields(raw, "start", "seconds")
		if fields == nil {
			return SystemHistory{}, false
		}
		bucketStart, ok := parseHistoryTime(history.Buckets[index].Start)
		if !ok || !bucketStart.Equal(start.Add(time.Duration(index)*bucket)) {
			return SystemHistory{}, false
		}
		limit := bucketLimit(spanSeconds, history.BucketSeconds, int64(index))
		seconds, ok := secondsFields(fields["seconds"], limit)
		if !ok {
			return SystemHistory{}, false
		}
		var sum int64
		for position, value := range seconds.values() {
			sums[position] += value
			sum += value
		}
		if sum > limit {
			return SystemHistory{}, false
		}
	}
	totalsRaw := root["totals"]
	if _, ok := secondsFields(totalsRaw, spanSeconds); !ok {
		return SystemHistory{}, false
	}
	for index, value := range history.Totals.values() {
		if value != sums[index] {
			return SystemHistory{}, false
		}
	}
	var rawIntervals []json.RawMessage
	if !json.Valid(root["intervals"]) || json.Unmarshal(root["intervals"], &rawIntervals) != nil || rawIntervals == nil || len(rawIntervals) > maxHistoryIntervals || len(history.Intervals) != len(rawIntervals) {
		return SystemHistory{}, false
	}
	var intervalSums [8]int64
	previousEnd := start
	for index, raw := range rawIntervals {
		fields := statusFields(raw, "start", "end", "state")
		if fields == nil {
			return SystemHistory{}, false
		}
		intervalStart, startOK := parseHistoryTime(history.Intervals[index].Start)
		intervalEnd, endOK := parseHistoryTime(history.Intervals[index].End)
		state := stateIndex(history.Intervals[index].State)
		if !startOK || !endOK || state < 0 || !intervalStart.Before(intervalEnd) ||
			intervalStart.Before(start) || intervalEnd.After(end) || intervalStart.Before(previousEnd) {
			return SystemHistory{}, false
		}
		previousEnd = intervalEnd
		intervalSums[state] += int64(intervalEnd.Sub(intervalStart) / time.Second)
	}
	for index, value := range history.Totals.values() {
		if history.IntervalsComplete && intervalSums[index] != value || !history.IntervalsComplete && intervalSums[index] > value {
			return SystemHistory{}, false
		}
	}
	currentFields := statusFields(root["current"], "state", "since")
	if currentFields == nil {
		return SystemHistory{}, false
	}
	known := false
	for _, state := range historyStates {
		if history.Current.State == state {
			known = true
		}
	}
	currentSince, sinceOK := parseHistoryTime(history.Current.Since)
	if !known || !sinceOK || currentSince.After(generatedAt) {
		return SystemHistory{}, false
	}
	return history, true
}

func (h *Handler) stateHistory(w http.ResponseWriter, r *http.Request) {
	query, ok := historyQuery(r.URL.RawQuery)
	if !ok {
		writeUnavailable(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if h.control == nil {
		writeUnavailable(w, http.StatusServiceUnavailable, "controls_not_configured")
		return
	}
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "http://supervisor/history?"+query, nil)
	response, err := h.control.Do(request)
	if err != nil {
		writeUnavailable(w, http.StatusServiceUnavailable, "supervisor_unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		writeUnavailable(w, http.StatusServiceUnavailable, "supervisor_upgrade_required")
		return
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, maxHistoryBody+1))
	if response.StatusCode == http.StatusBadRequest {
		writeUnavailable(w, http.StatusBadRequest, "invalid_request")
		return
	}
	history, valid := decodeSystemHistory(data)
	if response.StatusCode != http.StatusOK || readErr != nil || len(data) > maxHistoryBody ||
		!strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") || !valid {
		writeUnavailable(w, http.StatusBadGateway, "invalid_supervisor_response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(history)
	}
}
