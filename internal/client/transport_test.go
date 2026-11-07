package client

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type trackedBody struct {
	reader io.Reader
	closes atomic.Int32
	err    error
}

func (b *trackedBody) Read(p []byte) (int, error) {
	if b.reader == nil {
		return 0, io.EOF
	}
	return b.reader.Read(p)
}

func (b *trackedBody) Close() error {
	b.closes.Add(1)
	return b.err
}

type failingReader struct{ err error }

func (r failingReader) Read([]byte) (int, error) { return 0, r.err }

func newTransportTestClient(t *testing.T, roundTrip roundTripFunc, workers int) *Client {
	t.Helper()
	c, err := New(Config{
		URL:          "http://127.0.0.1:8787",
		Token:        "transport-test-token",
		Workers:      workers,
		HTTPClient:   &http.Client{Transport: roundTrip},
		StallTimeout: 50 * time.Millisecond,
		RetryMin:     time.Millisecond,
		RetryMax:     2 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestRelayRequestsUseUnversionedUserAgent(t *testing.T) {
	for _, kind := range []string{"rpc", "upload"} {
		t.Run(kind, func(t *testing.T) {
			c := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
				if got := request.Header.Get("User-Agent"); got != "deltarelay" {
					t.Errorf("User-Agent = %q, want deltarelay", got)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}")), Request: request}, nil
			}, 1)
			var err error
			if kind == "rpc" {
				_, err = c.rpc(context.Background(), http.MethodGet, "/info", nil, nil, 64, nil, nil)
			} else {
				var result struct{}
				err = c.postOnce(context.Background(), "/missing", "application/json", []byte("{}"), &result, nil, nil)
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAttemptSuccessReleasesSlotAndClosesBody(t *testing.T) {
	body := &trackedBody{reader: strings.NewReader("ok")}
	c := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: body, Request: request}, nil
	}, 1)
	response, err := c.execute(context.Background(), attemptSpec{
		method:         http.MethodGet,
		path:           "/test",
		cacheSlot:      true,
		userAgent:      "test",
		acceptedStatus: acceptedOK,
		responseLimit:  8,
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(response.body) != "ok" || response.status != http.StatusOK {
		t.Fatalf("unexpected response: %+v", response)
	}
	if body.closes.Load() != 1 {
		t.Fatalf("response body closed %d times, want 1", body.closes.Load())
	}
	if len(c.cacheSlots) != 0 {
		t.Fatal("cache slot was not released")
	}
}

func TestAttemptMalformedAndOversizedResponsesReleaseResources(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		limit  int64
		want   string
	}{
		{name: "malformed-status", status: http.StatusBadRequest, body: `{"error":"rejected","code":"bad"}`, limit: 64, want: "HTTP 400"},
		{name: "oversized", status: http.StatusOK, body: "0123456789", limit: 4, want: "response exceeds size limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := &trackedBody{reader: strings.NewReader(test.body)}
			c := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: test.status, Header: make(http.Header), Body: body, Request: request}, nil
			}, 1)
			_, err := c.execute(context.Background(), attemptSpec{
				method:             http.MethodGet,
				path:               "/test",
				cacheSlot:          true,
				userAgent:          "test",
				acceptedStatus:     acceptedOK,
				responseLimit:      test.limit,
				responseLimitError: errors.New("response exceeds size limit"),
			})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("unexpected error: %v", err)
			}
			if body.closes.Load() != 1 {
				t.Fatalf("response body closed %d times, want 1", body.closes.Load())
			}
			if len(c.cacheSlots) != 0 {
				t.Fatal("cache slot was not released")
			}
		})
	}
}

func TestAttemptCancellationTimeoutAndReadFailureReleaseResources(t *testing.T) {
	canceledContext, cancel := context.WithCancel(context.Background())
	cancel()
	c := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
		t.Fatal("canceled attempt reached the transport")
		return nil, nil
	}, 1)
	if _, err := c.execute(canceledContext, attemptSpec{method: http.MethodGet, path: "/test", cacheSlot: true}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not propagated: %v", err)
	}
	if len(c.cacheSlots) != 0 {
		t.Fatal("canceled attempt retained a cache slot")
	}

	stalled := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	}, 1)
	_, err := stalled.execute(context.Background(), attemptSpec{
		method:           http.MethodPost,
		path:             "/test",
		contentType:      "application/json",
		data:             []byte("{}"),
		cacheSlot:        true,
		userAgent:        "test",
		transportContext: "relay request failed",
		responseLimit:    8,
	})
	var transport *TransportError
	if !errors.As(err, &transport) || !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "relay request failed") {
		t.Fatalf("stalled attempt not converted to a transport error: %v", err)
	}
	if len(stalled.cacheSlots) != 0 {
		t.Fatal("stalled attempt retained a cache slot")
	}

	body := &trackedBody{reader: failingReader{err: errors.New("read failed")}}
	broken := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: body, Request: request}, nil
	}, 1)
	_, err = broken.execute(context.Background(), attemptSpec{
		method:         http.MethodGet,
		path:           "/test",
		cacheSlot:      true,
		userAgent:      "test",
		acceptedStatus: acceptedOK,
		responseLimit:  8,
	})
	if !errors.As(err, &transport) {
		t.Fatalf("response read failure not converted to a transport error: %v", err)
	}
	if body.closes.Load() != 1 {
		t.Fatalf("response body closed %d times, want 1", body.closes.Load())
	}
	if len(broken.cacheSlots) != 0 {
		t.Fatal("read failure retained a cache slot")
	}
}

func TestReleaseBodyIsIdempotent(t *testing.T) {
	inner := &trackedBody{reader: strings.NewReader("")}
	var releases atomic.Int32
	body := &releaseBody{ReadCloser: inner, release: func() { releases.Add(1) }}
	if err := body.Close(); err != nil {
		t.Fatal(err)
	}
	if err := body.Close(); err != nil {
		t.Fatal(err)
	}
	if releases.Load() != 1 {
		t.Fatalf("released %d times, want 1", releases.Load())
	}
	if inner.closes.Load() != 2 {
		t.Fatalf("underlying body closed %d times, want 2", inner.closes.Load())
	}
}

func TestAttemptPoliciesExpressCompressionAndStatistics(t *testing.T) {
	var compression, contentEncoding string
	var bodyBytes int
	fake := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		contentEncoding = request.Header.Get("Content-Encoding")
		data, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
		}
		bodyBytes = len(data)
		compression = request.Header.Get("Content-Type")
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: &trackedBody{reader: strings.NewReader(`{}`)}, Request: request}, nil
	})
	c := newTransportTestClient(t, fake, 1)
	data := bytes.Repeat([]byte("repeated content"), 1024)
	var sent, requests atomic.Int64
	if _, err := c.execute(context.Background(), attemptSpec{
		method:         http.MethodPost,
		path:           "/test",
		contentType:    "application/json",
		data:           data,
		compressible:   true,
		cacheSlot:      true,
		userAgent:      "test",
		acceptedStatus: acceptedOK,
		responseLimit:  8,
		sent:           &sent,
		requests:       &requests,
	}); err != nil {
		t.Fatal(err)
	}
	if compression != "application/json" || contentEncoding != "gzip" {
		t.Fatalf("content type or compression policy changed: %q %q", compression, contentEncoding)
	}
	if bodyBytes >= len(data) || sent.Load() != int64(bodyBytes) {
		t.Fatalf("encoded byte accounting differs: sent=%d body=%d raw=%d", sent.Load(), bodyBytes, len(data))
	}
	if requests.Load() != 1 {
		t.Fatalf("attempt statistics counted %d requests, want 1", requests.Load())
	}

	compression, contentEncoding, bodyBytes = "", "", 0
	if _, err := c.execute(context.Background(), attemptSpec{
		method:         http.MethodPost,
		path:           "/test",
		contentType:    "application/octet-stream",
		data:           data,
		userAgent:      "test",
		acceptedStatus: acceptedOK,
		responseLimit:  8,
	}); err != nil {
		t.Fatal(err)
	}
	if compression != "application/octet-stream" || contentEncoding != "" || bodyBytes != len(data) {
		t.Fatalf("non-compressible policy changed: %q %q %d", compression, contentEncoding, bodyBytes)
	}
}
