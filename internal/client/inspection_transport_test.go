package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"deltarelay/internal/inspection"
)

func TestInspectionMarksUnusableSuccessfulResponse(t *testing.T) {
	s, err := inspection.Open(inspection.Config{Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	capture := s.Begin("invalid-response-0001", 1, "application/json")
	c := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("not json")), Request: request}, nil
	}, 1)
	var sent, requests atomic.Int64
	var result map[string]any
	_, err = c.postOnceObserved(inspection.WithCapture(context.Background(), capture), "/missing", "application/json", []byte("{}"), &result, &sent, &requests)
	if err == nil {
		t.Fatal("invalid response was accepted")
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/inspection/"+capture.ID(), nil))
	var detail inspection.Detail
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Attempts) != 1 || detail.Attempts[0].Status != 200 || detail.Attempts[0].Outcome != "invalid_response" {
		t.Fatalf("unusable response presented as success: %+v", detail.Attempts)
	}
}

func TestInspectionDistinguishesPreparedFromPartiallyConsumedPayload(t *testing.T) {
	s, err := inspection.Open(inspection.Config{Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	capture := s.Begin("partial-consumption-0001", 1, "application/json")
	c := newTransportTestClient(t, func(request *http.Request) (*http.Response, error) {
		_, _ = io.CopyN(io.Discard, request.Body, 7)
		return nil, errors.New("simulated failed connection")
	}, 1)
	var sent, requests atomic.Int64
	_, err = c.execute(inspection.WithCapture(context.Background(), capture), attemptSpec{method: "POST", path: "/missing", contentType: "application/json", data: []byte(strings.Repeat("payload", 100)), sent: &sent, requests: &requests})
	if err == nil {
		t.Fatal("transport failure was hidden")
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/inspection/"+capture.ID(), nil))
	var detail inspection.Detail
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Attempts) != 1 || detail.Attempts[0].ConsumedBytes != 7 || detail.Attempts[0].PreparedBytes != 700 || detail.Attempts[0].Outcome != "transport_error" || sent.Load() != 7 {
		t.Fatalf("prepared bytes mislabeled as sent: %+v", detail.Attempts)
	}
}
