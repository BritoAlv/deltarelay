package gateway_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/gateway"
	"deltarelay/internal/protocol"
	"deltarelay/internal/transfer"
	"deltarelay/internal/upstream"
)

type finalStateRelay struct {
	mu      sync.Mutex
	body    []byte
	status  protocol.RequestStatus
	queries int
}

func (r *finalStateRelay) Forward(ctx context.Context, _ client.Request, _ io.Reader) (*http.Response, transfer.Stats, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       &cancelWaitBody{ctx: ctx, first: r.body},
	}, transfer.Stats{}, nil
}

func (r *finalStateRelay) Health(context.Context) (client.Health, error) {
	return client.Health{}, nil
}

func (r *finalStateRelay) ControlStatus() (int, string) { return 0, "" }

func (r *finalStateRelay) Status(context.Context, string) (protocol.RequestStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.queries++
	return r.status, nil
}

type cancelWaitBody struct {
	ctx     context.Context
	first   []byte
	started bool
}

func (b *cancelWaitBody) Read(p []byte) (int, error) {
	if !b.started {
		b.started = true
		return copy(p, b.first), nil
	}
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}

func (b *cancelWaitBody) Close() error { return nil }

func TestClientCloseAfterCompletedStreamIsRecordedAsCompleted(t *testing.T) {
	first := []byte("data: {\"delta\":\"complete\"}\n\ndata: [DONE]\n\n")
	relay := &finalStateRelay{
		body:   first,
		status: protocol.RequestStatus{State: protocol.Completed, Status: http.StatusOK, Bytes: int64(len(first))},
	}
	results := make(chan gateway.Result, 1)
	g, err := gateway.New(gateway.Config{
		Client:        relay,
		LocalToken:    localToken,
		Upstreams:     []upstream.Rule{{Name: "mock", Origin: "https://example.com", PathPrefix: "/v1/"}},
		MaxConcurrent: 1,
		OnResult:      func(result gateway.Result) { results <- result },
	})
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(g)
	defer local.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, local.URL+"/proxy", bytes.NewReader([]byte(`{"input":"test"}`)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-DeltaRelay-Local-Token", localToken)
	request.Header.Set("X-DeltaRelay-Target", "https://example.com/v1/responses")
	request.Header.Set("X-DeltaRelay-Request-ID", "completed-client-close-0001")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	received := make([]byte, len(first))
	if _, err := io.ReadFull(response.Body, received); err != nil {
		t.Fatalf("read stream: %v", err)
	}
	cancel()
	response.Body.Close()

	select {
	case result := <-results:
		if result.Status != http.StatusOK || result.Failed || result.Cancelled || result.ErrorCode != "" {
			t.Fatalf("completed stream was recorded as unsuccessful: %+v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gateway did not finish the cancelled downstream request")
	}
	snapshot := readDashboard(t, local.URL)
	if snapshot.History.Totals.Requests != 1 || snapshot.History.Totals.Active != 0 || snapshot.History.Totals.Failed != 0 || snapshot.History.Totals.Cancelled != 0 || snapshot.History.RecentRequests[0].State != "completed" {
		t.Fatalf("final state was not reconciled: %+v", snapshot.History.Totals)
	}
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if relay.queries != 1 {
		t.Fatalf("relay final state queried %d times, want 1", relay.queries)
	}
}
