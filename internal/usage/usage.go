// Package usage extracts numeric model usage on the local computer. It never
// persists bodies or credentials and is not part of the relay wire protocol.
package usage

import (
	"encoding/json"
	"strings"
	"time"
	"unicode"
)

const MaxCounter int64 = 9007199254740991

type Key struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Measurement distinguishes an absent counter from a measured zero. Cache and
// reasoning details are subsets where the provider defines them as such.
type Measurement struct {
	Version           int    `json:"version"`
	State             string `json:"state"`
	Source            string `json:"source,omitempty"`
	Reason            string `json:"reason,omitempty"`
	Model             string `json:"model,omitempty"`
	ResponseModel     string `json:"response_model,omitempty"`
	FinishReason      string `json:"finish_reason,omitempty"`
	Messages          *int64 `json:"messages,omitempty"`
	Tools             *int64 `json:"tools,omitempty"`
	MaxOutputTokens   *int64 `json:"max_output_tokens,omitempty"`
	InputTokens       *int64 `json:"input_tokens,omitempty"`
	OutputTokens      *int64 `json:"output_tokens,omitempty"`
	TotalTokens       *int64 `json:"total_tokens,omitempty"`
	CacheReadTokens   *int64 `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens  *int64 `json:"cache_write_tokens,omitempty"`
	ReasoningTokens   *int64 `json:"reasoning_tokens,omitempty"`
	InputAudioTokens  *int64 `json:"input_audio_tokens,omitempty"`
	OutputAudioTokens *int64 `json:"output_audio_tokens,omitempty"`
	FirstResponseMS   *int64 `json:"first_response_ms,omitempty"`
}

func Number(value int64) *int64 { return &value }

func Label(value string) string {
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r >= '\u202a' && r <= '\u202e' || r >= '\u2066' && r <= '\u2069' {
			return -1
		}
		return r
	}, value))
	runes := []rune(value)
	if len(runes) > 160 {
		value = string(runes[:160])
	}
	return value
}

func modelLabel(value string) string {
	if len(value) > 160 {
		return ""
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_./:@", c)) {
			return ""
		}
	}
	return value
}

func Valid(m *Measurement) bool {
	if m == nil {
		return true
	}
	if m.Version != 1 || m.State != "complete" && m.State != "partial" && m.State != "unavailable" {
		return false
	}
	for _, n := range []*int64{m.Messages, m.Tools, m.MaxOutputTokens, m.InputTokens, m.OutputTokens, m.TotalTokens, m.CacheReadTokens, m.CacheWriteTokens, m.ReasoningTokens, m.InputAudioTokens, m.OutputAudioTokens, m.FirstResponseMS} {
		if n != nil && (*n < 0 || *n > MaxCounter) {
			return false
		}
	}
	return len(m.Source) <= 80 && len(m.Reason) <= 80 && modelLabel(m.Model) == m.Model && modelLabel(m.ResponseModel) == m.ResponseModel && len(m.FinishReason) <= 80
}

type Aggregate struct {
	MeasuredRequests int64      `json:"measured_requests"`
	CompleteRequests int64      `json:"complete_requests"`
	InputRequests    int64      `json:"input_requests"`
	OutputRequests   int64      `json:"output_requests"`
	InputTokens      *int64     `json:"input_tokens"`
	OutputTokens     *int64     `json:"output_tokens"`
	CacheReadTokens  *int64     `json:"cache_read_tokens"`
	CacheWriteTokens *int64     `json:"cache_write_tokens"`
	ReasoningTokens  *int64     `json:"reasoning_tokens"`
	LatestContext    *int64     `json:"latest_context"`
	PeakContext      *int64     `json:"peak_context"`
	LatestContextAt  *time.Time `json:"latest_context_at,omitempty"`
}

func sum(target **int64, value *int64) {
	if value == nil {
		return
	}
	if *target == nil {
		*target = Number(0)
	}
	// Allocate a new value: aggregate copies must not alias a previous report.
	*target = Number(min(MaxCounter, **target+*value))
}

func (a *Aggregate) Add(m *Measurement, at time.Time) {
	if m == nil {
		return
	}
	if m.InputTokens != nil || m.OutputTokens != nil {
		a.MeasuredRequests++
	}
	if m.State == "complete" {
		a.CompleteRequests++
	}
	if m.InputTokens != nil {
		a.InputRequests++
		if a.LatestContextAt == nil || !at.Before(*a.LatestContextAt) {
			a.LatestContext, a.LatestContextAt = Number(*m.InputTokens), &at
		}
		if a.PeakContext == nil || *m.InputTokens > *a.PeakContext {
			a.PeakContext = Number(*m.InputTokens)
		}
	}
	if m.OutputTokens != nil {
		a.OutputRequests++
	}
	sum(&a.InputTokens, m.InputTokens)
	sum(&a.OutputTokens, m.OutputTokens)
	sum(&a.CacheReadTokens, m.CacheReadTokens)
	sum(&a.CacheWriteTokens, m.CacheWriteTokens)
	sum(&a.ReasoningTokens, m.ReasoningTokens)
}

type object map[string]json.RawMessage

func decode(data []byte) object          { var v object; _ = json.Unmarshal(data, &v); return v }
func nested(v object, key string) object { return decode(v[key]) }
func text(v object, key string) string   { var s string; _ = json.Unmarshal(v[key], &s); return s }
func number(v object, key string) *int64 {
	var n int64
	if len(v[key]) == 0 || string(v[key]) == "null" || json.Unmarshal(v[key], &n) != nil || n < 0 || n > MaxCounter {
		return nil
	}
	return &n
}
func count(v object, key string) *int64 {
	var items []json.RawMessage
	if json.Unmarshal(v[key], &items) != nil || items == nil {
		return nil
	}
	return Number(int64(len(items)))
}
