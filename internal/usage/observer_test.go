package usage

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func observe(t *testing.T, mime, data string, eof bool) Measurement {
	t.Helper()
	o := ObserveResponse(Measurement{Version: 1, State: "unavailable", Reason: "usage_not_reported"}, mime, "", time.Now())
	// Byte-sized fragments exercise arbitrary HTTP/SSE boundaries and UTF-8.
	for _, b := range []byte(data) {
		if n, err := o.Write([]byte{b}); err != nil || n != 1 {
			t.Fatalf("observer changed write semantics: %d %v", n, err)
		}
	}
	return o.Finish(eof)
}

func TestOpenAIStreamsAndNullableCounters(t *testing.T) {
	m := observe(t, "text/event-stream", "data: {\"model\":\"mock\",\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120,\"prompt_tokens_details\":{\"cached_tokens\":80},\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\r\n\r\ndata: [DONE]\r\n\r\n", true)
	if m.State != "complete" || m.Source != "openai.chat" || *m.InputTokens != 100 || *m.OutputTokens != 20 || *m.CacheReadTokens != 80 || *m.ReasoningTokens != 5 || m.CacheWriteTokens != nil || m.FinishReason != "stop" {
		t.Fatalf("%+v", m)
	}
	// Terminal usage received locally remains complete if the consumer closes
	// after DONE without reading the socket's EOF.
	m = observe(t, "text/event-stream", "data: {\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0}}\n\ndata: [DONE]\n\n", false)
	if m.State != "complete" || m.InputTokens == nil || *m.InputTokens != 0 || *m.TotalTokens != 0 {
		t.Fatalf("%+v", m)
	}
	m = observe(t, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"private-response\"}}]}\n\ndata: [DONE]\n\n", true)
	if m.State != "unavailable" || m.InputTokens != nil || m.OutputTokens != nil {
		t.Fatalf("invented usage: %+v", m)
	}
}

func TestResponsesAndAnthropicNormalization(t *testing.T) {
	m := observe(t, "text/event-stream", "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"model-v1\",\"usage\":{\"input_tokens\":100,\"output_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":70},\"output_tokens_details\":{\"reasoning_tokens\":2}}}}\n\n", true)
	if m.State != "complete" || m.Source != "openai.responses" || *m.InputTokens != 100 || *m.TotalTokens != 110 || m.ResponseModel != "model-v1" {
		t.Fatalf("%+v", m)
	}
	m = observe(t, "text/event-stream", `data: {"type":"message_start","message":{"model":"claude","usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":20,"output_tokens":0}}}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

data: {"type":"message_delta","usage":{"output_tokens":12}}

data: {"type":"message_stop"}

`, true)
	if m.State != "complete" || m.Source != "anthropic.messages" || *m.InputTokens != 110 || *m.OutputTokens != 12 || *m.TotalTokens != 122 {
		t.Fatalf("cumulative deltas were double-counted: %+v", m)
	}
	m = observe(t, "application/json", `{"type":"message","usage":{"input_tokens":3,"output_tokens":2}}`, true)
	if m.State != "complete" || *m.InputTokens != 3 {
		t.Fatalf("%+v", m)
	}
}

func TestPartialMalformedOversizedAndEncoded(t *testing.T) {
	m := observe(t, "text/event-stream", "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n", false)
	if m.State != "partial" || *m.InputTokens != 12 || m.OutputTokens != nil {
		t.Fatalf("%+v", m)
	}
	for _, data := range []string{`{`, `{"usage":{"input_tokens":-1,"output_tokens":1.5}}`, `{"usage":{"input_tokens":9007199254740992}}`} {
		m = observe(t, "application/json", data, true)
		if m.State != "unavailable" || !Valid(&m) {
			t.Fatalf("%+v", m)
		}
	}
	// A large content event is discarded without losing subsequent usage.
	o := ObserveResponse(Measurement{Version: 1, State: "unavailable"}, "text/event-stream", "", time.Now())
	_, _ = o.Write([]byte("data: " + strings.Repeat("x", maxResponseEvent+10) + "\n\n"))
	_, _ = o.Write([]byte("data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n"))
	m = o.Finish(true)
	if m.State != "complete" || *m.InputTokens != 2 {
		t.Fatalf("large content hid usage: %+v", m)
	}
	o = ObserveResponse(Measurement{Version: 1, State: "unavailable", Reason: "usage_not_reported"}, "application/json", "gzip", time.Now())
	_, _ = o.Write([]byte(`{"usage":{"input_tokens":2,"output_tokens":3}}`))
	if m = o.Finish(true); m.State != "unavailable" || m.Reason != "unsupported_response_encoding" {
		t.Fatalf("%+v", m)
	}
}

func TestRequestMetricsContainNoContent(t *testing.T) {
	body := `{"model":"test-model","messages":[{"content":"private-conversation"}],"tools":[{"name":"secret-tool-name"}],"max_tokens":42}`
	r := ObserveRequest(strings.NewReader(body))
	got, err := io.ReadAll(r)
	if err != nil || string(got) != body {
		t.Fatal("observer changed the request")
	}
	m := r.Metadata()
	if m.Model != "test-model" || *m.Messages != 1 || *m.Tools != 1 || *m.MaxOutputTokens != 42 {
		t.Fatalf("%+v", m)
	}
	data, _ := json.Marshal(m)
	if strings.Contains(string(data), "private-conversation") || strings.Contains(string(data), "secret-tool-name") || len(r.buffer) != 0 {
		t.Fatal("retained content")
	}
	r = ObserveRequest(strings.NewReader(strings.Repeat("x", maxRequestMetadata+1)))
	_, _ = io.Copy(io.Discard, r)
	if m = r.Metadata(); m.Model != "" || m.Messages != nil {
		t.Fatal("parsed incomplete oversized request")
	}
}
