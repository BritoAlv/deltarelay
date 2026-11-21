package usage

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"time"
)

const maxRequestMetadata = 8 << 20
const maxResponseEvent = 1 << 20

// RequestReader observes the already-decoded local request. Its bounded,
// temporary buffer is released after metadata extraction, even without capture.
type RequestReader struct {
	io.Reader
	buffer   []byte
	overflow bool
}

func ObserveRequest(r io.Reader) *RequestReader { return &RequestReader{Reader: r} }
func (r *RequestReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if !r.overflow {
		if len(r.buffer)+n > maxRequestMetadata {
			r.buffer = nil
			r.overflow = true
		} else {
			r.buffer = append(r.buffer, p[:n]...)
		}
	}
	return n, err
}

func (r *RequestReader) Metadata() Measurement {
	m := Measurement{Version: 1, State: "unavailable", Reason: "usage_not_reported"}
	if r.overflow {
		m.Reason = "request_metadata_too_large"
	} else {
		v := decode(r.buffer)
		m.Model = modelLabel(text(v, "model"))
		m.Messages, m.Tools = count(v, "messages"), count(v, "tools")
		if m.Messages == nil {
			m.Messages = count(v, "input")
		}
		for _, key := range []string{"max_output_tokens", "max_completion_tokens", "max_tokens"} {
			if m.MaxOutputTokens = number(v, key); m.MaxOutputTokens != nil {
				break
			}
		}
	}
	r.buffer = nil
	return m
}

// ResponseObserver consumes copies of bytes as the local response is read. It
// never rewrites, buffers delivery, requests usage, or makes a network call.
type ResponseObserver struct {
	m                                     Measurement
	stream, supported, terminal, overflow bool
	lineBytes                             int
	buffer, event                         []byte
	started                               time.Time
	anthropicInput                        *int64
}

func ObserveResponse(metadata Measurement, contentType, encoding string, started time.Time) *ResponseObserver {
	o := &ResponseObserver{m: metadata, started: started}
	o.stream = strings.HasPrefix(strings.ToLower(contentType), "text/event-stream")
	o.supported = o.stream || strings.Contains(strings.ToLower(contentType), "json")
	if encoding != "" && encoding != "identity" {
		o.supported = false
		o.m.Reason = "unsupported_response_encoding"
	}
	if !o.supported && o.m.Reason == "usage_not_reported" {
		o.m.Reason = "unsupported_response_format"
	}
	return o
}

func (o *ResponseObserver) Write(p []byte) (int, error) {
	size := len(p)
	if o.m.FirstResponseMS == nil && len(p) > 0 {
		o.m.FirstResponseMS = Number(max(0, time.Since(o.started).Milliseconds()))
	}
	if !o.supported {
		return len(p), nil
	}
	if !o.stream {
		if len(o.buffer)+len(p) <= maxResponseEvent && !o.overflow {
			o.buffer = append(o.buffer, p...)
		} else {
			o.buffer = nil
			o.overflow = true
			o.m.Reason = "response_metadata_too_large"
		}
		return len(p), nil
	}
	// Consume line fragments, including CRLF and events spanning transport reads.
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			o.lineFragment(p)
			break
		}
		o.lineFragment(p[:i])
		o.line()
		p = p[i+1:]
	}
	return size, nil
}

func (o *ResponseObserver) lineFragment(p []byte) {
	o.lineBytes += len(p)
	if len(o.buffer)+len(p) > maxResponseEvent {
		o.buffer = nil
		o.overflow = true
		o.m.Reason = "response_metadata_too_large"
	}
	if !o.overflow {
		o.buffer = append(o.buffer, p...)
	}
}

func (o *ResponseObserver) line() {
	line := bytes.TrimSuffix(o.buffer, []byte{'\r'})
	blank := o.lineBytes == 0 || o.lineBytes == 1 && len(o.buffer) == 1 && o.buffer[0] == '\r'
	if blank {
		if !o.overflow {
			o.consume(o.event)
		}
		o.event = nil
		o.overflow = false
	} else if !o.overflow && bytes.HasPrefix(line, []byte("data:")) {
		data := bytes.TrimPrefix(line[5:], []byte{' '})
		if len(o.event)+len(data)+1 <= maxResponseEvent {
			o.event = append(o.event, data...)
			o.event = append(o.event, '\n')
		} else {
			o.event = nil
			o.overflow = true
		}
	}
	o.buffer = nil
	o.lineBytes = 0
}

func (o *ResponseObserver) consume(data []byte) {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("[DONE]")) {
		o.terminal = true
		return
	}
	v := decode(data)
	if v == nil {
		return
	}
	if model := modelLabel(text(v, "model")); model != "" {
		o.m.ResponseModel = model
	}
	t := text(v, "type")
	var choices []object
	if json.Unmarshal(v["choices"], &choices) == nil && len(choices) > 0 {
		if reason := modelLabel(text(choices[0], "finish_reason")); reason != "" {
			o.m.FinishReason = reason
		}
	}
	switch {
	case t == "message_start":
		msg := nested(v, "message")
		o.m.Source = "anthropic.messages"
		o.m.ResponseModel = modelLabel(text(msg, "model"))
		o.anthropic(nested(msg, "usage"))
	case t == "message_delta":
		o.m.Source = "anthropic.messages"
		o.anthropic(nested(v, "usage"))
		o.m.FinishReason = modelLabel(text(nested(v, "delta"), "stop_reason"))
	case t == "message_stop":
		o.terminal = true
	case strings.HasPrefix(t, "response."):
		resp := nested(v, "response")
		if model := modelLabel(text(resp, "model")); model != "" {
			o.m.ResponseModel = model
		}
		o.openAI(nested(resp, "usage"), false)
		if t == "response.completed" || t == "response.incomplete" || t == "response.failed" {
			o.terminal = true
		}
	default:
		u := nested(v, "usage")
		if u == nil {
			return
		}
		if text(v, "type") == "message" || number(u, "cache_creation_input_tokens") != nil || number(u, "cache_read_input_tokens") != nil {
			o.m.Source = "anthropic.messages"
			o.anthropic(u)
			o.m.FinishReason = modelLabel(text(v, "stop_reason"))
		} else {
			o.openAI(u, number(u, "prompt_tokens") != nil)
		}
	}
}

func assign(target **int64, value *int64) {
	if value != nil {
		*target = value
	}
}

func (o *ResponseObserver) openAI(u object, chat bool) {
	if u == nil {
		return
	}
	input, output, inputDetails, outputDetails := "input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details"
	o.m.Source = "openai.responses"
	if chat {
		o.m.Source = "openai.chat"
		input, output, inputDetails, outputDetails = "prompt_tokens", "completion_tokens", "prompt_tokens_details", "completion_tokens_details"
	}
	assign(&o.m.InputTokens, number(u, input))
	assign(&o.m.OutputTokens, number(u, output))
	assign(&o.m.TotalTokens, number(u, "total_tokens"))
	if cached := number(nested(u, inputDetails), "cached_tokens"); cached != nil {
		o.m.CacheReadTokens = cached
	} else {
		assign(&o.m.CacheReadTokens, number(u, "prompt_cache_hit_tokens"))
	}
	assign(&o.m.ReasoningTokens, number(nested(u, outputDetails), "reasoning_tokens"))
	assign(&o.m.InputAudioTokens, number(nested(u, inputDetails), "audio_tokens"))
	assign(&o.m.OutputAudioTokens, number(nested(u, outputDetails), "audio_tokens"))
}

func (o *ResponseObserver) anthropic(u object) {
	assign(&o.anthropicInput, number(u, "input_tokens"))
	assign(&o.m.OutputTokens, number(u, "output_tokens"))
	assign(&o.m.CacheReadTokens, number(u, "cache_read_input_tokens"))
	assign(&o.m.CacheWriteTokens, number(u, "cache_creation_input_tokens"))
	if o.anthropicInput != nil {
		input := *o.anthropicInput
		if o.m.CacheReadTokens != nil {
			input += *o.m.CacheReadTokens
		}
		if o.m.CacheWriteTokens != nil {
			input += *o.m.CacheWriteTokens
		}
		if input <= MaxCounter {
			o.m.InputTokens = Number(input)
		}
	}
}

func (o *ResponseObserver) Finish(eof bool) Measurement {
	if o.supported {
		if !o.stream && !o.overflow && eof {
			o.consume(o.buffer)
			o.terminal = true
		} else if o.stream && eof {
			if len(o.buffer) > 0 {
				o.line()
			}
			if len(o.event) > 0 && !o.overflow {
				o.consume(o.event)
			}
		}
	}
	if o.m.InputTokens != nil || o.m.OutputTokens != nil {
		o.m.State, o.m.Reason = "partial", "incomplete_usage"
		if o.terminal && o.m.InputTokens != nil && o.m.OutputTokens != nil {
			o.m.State, o.m.Reason = "complete", ""
		}
		if o.m.TotalTokens == nil && o.m.InputTokens != nil && o.m.OutputTokens != nil && *o.m.InputTokens <= MaxCounter-*o.m.OutputTokens {
			o.m.TotalTokens = Number(*o.m.InputTokens + *o.m.OutputTokens)
		}
	}
	o.buffer, o.event = nil, nil
	return o.m
}
