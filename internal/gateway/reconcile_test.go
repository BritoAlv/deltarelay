package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/transfer"
)

type statusRelay struct {
	record  protocol.RequestStatus
	err     error
	queries int
	ctxErr  error
}

func (r *statusRelay) Forward(context.Context, client.Request, io.Reader) (*http.Response, transfer.Stats, error) {
	return nil, transfer.Stats{}, errors.New("not used")
}

func (r *statusRelay) Health(context.Context) (client.Health, error) {
	return client.Health{}, errors.New("not used")
}

func (r *statusRelay) ControlStatus() (int, string) { return 0, "" }

func (r *statusRelay) Status(ctx context.Context, _ string) (protocol.RequestStatus, error) {
	r.queries++
	r.ctxErr = ctx.Err()
	return r.record, r.err
}

func TestReconcilePromotesCompletedClientClose(t *testing.T) {
	relay := &statusRelay{record: protocol.RequestStatus{State: protocol.Completed, Status: http.StatusOK, Bytes: 4096}}
	g := &Gateway{config: Config{Client: relay}}
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	result := Result{ID: "request-00000000001", Status: statusClientClosedRequest, ResponseBytes: 4096, Failed: false, Cancelled: true}

	g.reconcileFinalState(parent, 1, &result)

	if relay.queries != 1 || relay.ctxErr != nil {
		t.Fatalf("status lookup was not detached from the cancelled request: queries=%d ctxErr=%v", relay.queries, relay.ctxErr)
	}
	if result.Status != http.StatusOK || result.Failed || result.Cancelled || result.ErrorCode != "" || result.ResponseBytes != 4096 {
		t.Fatalf("completed stream was not reconciled: %+v", result)
	}
}

func TestReconcileKeepsIncompleteOrFailedStates(t *testing.T) {
	cases := []struct {
		name          string
		record        protocol.RequestStatus
		responseBytes int64
		observation   uint64
		queries       int
		wantStatus    int
		wantFailed    bool
		wantCancelled bool
	}{
		{name: "running", record: protocol.RequestStatus{State: protocol.Running}, responseBytes: 10, observation: 1, queries: 1, wantStatus: statusClientClosedRequest, wantCancelled: true},
		{name: "partial completed response", record: protocol.RequestStatus{State: protocol.Completed, Status: http.StatusOK, Bytes: 20}, responseBytes: 10, observation: 1, queries: 1, wantStatus: statusClientClosedRequest, wantCancelled: true},
		{name: "relay failure", record: protocol.RequestStatus{State: protocol.Failed, ErrorCode: "provider_connection_unknown"}, responseBytes: 10, observation: 1, queries: 1, wantStatus: http.StatusBadGateway, wantFailed: true},
		{name: "relay cancellation", record: protocol.RequestStatus{State: protocol.Cancelled, ErrorCode: "client_cancelled"}, responseBytes: 10, observation: 1, queries: 1, wantStatus: statusClientClosedRequest, wantCancelled: true},
		{name: "unknown request", record: protocol.RequestStatus{State: protocol.Completed, Status: http.StatusOK, Bytes: 10}, responseBytes: 10, observation: 0, queries: 0, wantStatus: statusClientClosedRequest, wantCancelled: true},
		{name: "no delivered bytes", record: protocol.RequestStatus{State: protocol.Completed, Status: http.StatusOK, Bytes: 0}, responseBytes: 0, observation: 1, queries: 0, wantStatus: statusClientClosedRequest, wantCancelled: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			relay := &statusRelay{record: tc.record}
			g := &Gateway{config: Config{Client: relay}}
			result := Result{ID: "request-00000000001", Status: statusClientClosedRequest, ResponseBytes: tc.responseBytes, Failed: false, Cancelled: true}

			g.reconcileFinalState(context.Background(), tc.observation, &result)

			if relay.queries != tc.queries {
				t.Fatalf("status queries=%d, want %d", relay.queries, tc.queries)
			}
			if result.Status != tc.wantStatus || result.Failed != tc.wantFailed || result.Cancelled != tc.wantCancelled {
				t.Fatalf("unexpected result: %+v", result)
			}
		})
	}
}

func TestReconcileLeavesCancellationWhenStatusLookupFails(t *testing.T) {
	relay := &statusRelay{err: errors.New("relay unavailable")}
	g := &Gateway{config: Config{Client: relay}}
	result := Result{ID: "request-00000000001", Status: statusClientClosedRequest, ResponseBytes: 10, Failed: false, Cancelled: true}

	g.reconcileFinalState(context.Background(), 1, &result)

	if result.Status != statusClientClosedRequest || result.Failed || !result.Cancelled {
		t.Fatalf("lookup failure changed cancellation accounting: %+v", result)
	}
}
