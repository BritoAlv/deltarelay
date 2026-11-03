package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/journal"
	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func testJobService(t *testing.T, providerURL string, maxConcurrent int) (*jobService, *store.Store, *mailbox.Mailbox) {
	t.Helper()
	directory := t.TempDir()
	storage, err := store.Open(filepath.Join(directory, "relay"))
	if err != nil {
		t.Fatal(err)
	}
	box, err := mailbox.Open(filepath.Join(directory, "mailbox"), mailbox.Config{})
	if err != nil {
		t.Fatal(err)
	}
	requests, err := journal.Open(filepath.Join(directory, "requests"), 100)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := upstream.NewPolicy([]upstream.Rule{{Name: "mock", Origin: providerURL, PathPrefix: "/"}}, true)
	if err != nil {
		t.Fatal(err)
	}
	service := newJobService(jobServiceConfig{
		Store: storage, Mailbox: box, Journal: requests, Policy: policy,
		Upstream: policy.HTTPClient(time.Second), MaxConcurrent: maxConcurrent,
		MaxRuntime: time.Minute, IdleTimeout: time.Second, Context: context.Background(),
	})
	t.Cleanup(service.Close)
	return service, storage, box
}

func submitDirect(t *testing.T, service *jobService, storage *store.Store, target, id string, body []byte) (protocol.RequestStatus, bool, error) {
	t.Helper()
	input := protocol.ForwardRequest{Version: protocol.RelayVersion, ID: id, Target: target, Method: http.MethodPost, Manifest: manifest(body)}
	if len(input.Manifest.Chunks) > 0 {
		if err := storage.PutChunk(input.Manifest.Chunks[0], body); err != nil {
			t.Fatal(err)
		}
	}
	input, fingerprint, err := prepareProviderRequest(service.policy, protocol.DefaultMaxBodySize, input)
	if err != nil {
		t.Fatal(err)
	}
	return service.Submit(context.Background(), input, fingerprint)
}

func waitJobTerminal(t *testing.T, box *mailbox.Mailbox, id string) protocol.RequestStatus {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		record, changed, err := box.Lookup(id)
		if err != nil {
			t.Fatal(err)
		}
		if protocol.Terminal(record.State) {
			return record
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-changed:
		}
	}
}

func TestJobServiceSubmissionAndDuplicateWithoutHTTP(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "data: saved\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(provider.Close)
	service, storage, box := testJobService(t, provider.URL, 2)
	body := []byte("direct-service-request")
	record, created, err := submitDirect(t, service, storage, provider.URL+"/responses", "direct-service-request-0001", body)
	if err != nil || !created || record.State != protocol.Accepted {
		t.Fatalf("direct submission: created=%t state=%s err=%v", created, record.State, err)
	}
	terminal := waitJobTerminal(t, box, record.ID)
	if terminal.State != protocol.Completed || terminal.Hash == "" || calls.Load() != 1 {
		t.Fatalf("direct job did not complete once: %+v calls=%d", terminal, calls.Load())
	}
	repeated, created, err := submitDirect(t, service, storage, provider.URL+"/responses", record.ID, body)
	if err != nil || created || repeated.State != protocol.Completed || calls.Load() != 1 {
		t.Fatalf("duplicate regenerated: created=%t state=%s calls=%d err=%v", created, repeated.State, calls.Load(), err)
	}
}

func TestJobServiceCancelBeforeSubmitDoesNotDispatch(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	t.Cleanup(provider.Close)
	service, storage, box := testJobService(t, provider.URL, 1)
	const id = "cancel-before-service-0001"
	cancelled, err := service.Cancel(id)
	if err != nil || cancelled.State != protocol.Cancelled {
		t.Fatalf("cancellation tombstone: %+v %v", cancelled, err)
	}
	if _, _, err := submitDirect(t, service, storage, provider.URL+"/responses", id, []byte("late body")); !errors.Is(err, errDifferentContent) {
		t.Fatalf("late submission escaped cancellation: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("cancelled request reached provider: %d", calls.Load())
	}
	record, _, err := box.Lookup(id)
	if err != nil || record.State != protocol.Cancelled {
		t.Fatalf("cancellation tombstone changed: %+v %v", record, err)
	}
}

func TestJobServiceRunningCancellationKeepsSingleDispatch(t *testing.T) {
	started := make(chan struct{}, 1)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "first")
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(provider.Close)
	service, storage, box := testJobService(t, provider.URL, 1)
	body := []byte("running cancellation body")
	record, created, err := submitDirect(t, service, storage, provider.URL+"/responses", "running-cancel-request-0001", body)
	if err != nil || !created {
		t.Fatalf("submission: created=%t err=%v", created, err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider job never started")
	}
	cancelled, err := service.Cancel(record.ID)
	if err != nil || cancelled.State != protocol.Cancelled {
		t.Fatalf("running cancellation: %+v %v", cancelled, err)
	}
	terminal := waitJobTerminal(t, box, record.ID)
	if terminal.State != protocol.Cancelled || calls.Load() != 1 {
		t.Fatalf("cancellation lost or replayed: %+v calls=%d", terminal, calls.Load())
	}
	if _, created, err := submitDirect(t, service, storage, provider.URL+"/responses", record.ID, body); err != nil || created || calls.Load() != 1 {
		t.Fatalf("cancelled request was redispatched: created=%t calls=%d err=%v", created, calls.Load(), err)
	}
}

func TestJobServiceShutdownCancelsAndWaitTerminal(t *testing.T) {
	started := make(chan struct{}, 1)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(provider.Close)
	service, storage, box := testJobService(t, provider.URL, 1)
	body := []byte("shutdown body")
	record, created, err := submitDirect(t, service, storage, provider.URL+"/responses", "shutdown-request-0001", body)
	if err != nil || !created {
		t.Fatalf("submission: created=%t err=%v", created, err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider job never started")
	}
	service.Close()
	terminal, _, err := box.Lookup(record.ID)
	if err != nil || terminal.State != protocol.Interrupted || terminal.ErrorCode != "job_deadline_or_shutdown" {
		t.Fatalf("shutdown did not persist a terminal record: %+v %v", terminal, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("shutdown replayed the provider call: %d", calls.Load())
	}
	// Submission after shutdown is admitted only long enough to persist an
	// interrupted record; it must never dispatch.
	late, created, err := submitDirect(t, service, storage, provider.URL+"/responses", "shutdown-late-request-0001", []byte("late shutdown body"))
	if !errors.Is(err, errShuttingDown) || !created || late.State != protocol.Accepted {
		t.Fatalf("post-shutdown admission: created=%t state=%s err=%v", created, late.State, err)
	}
	lateRecord, _, lookupErr := box.Lookup(late.ID)
	if lookupErr != nil || lateRecord.State != protocol.Interrupted {
		t.Fatalf("post-shutdown record not terminal: %+v %v", lateRecord, lookupErr)
	}
	if calls.Load() != 1 {
		t.Fatalf("post-shutdown submission reached provider: %d", calls.Load())
	}
}

func TestJobServiceConcurrencyLimitDoesNotClaimOrLeak(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "ok")
	}))
	t.Cleanup(provider.Close)
	service, storage, box := testJobService(t, provider.URL, 1)
	service.slots <- struct{}{}
	const id = "limit-then-retry-request-0001"
	body := []byte("limit retry body")
	if _, _, err := submitDirect(t, service, storage, provider.URL+"/responses", id, body); !errors.Is(err, errJobLimit) {
		t.Fatalf("concurrency limit not enforced: %v", err)
	}
	if _, _, err := box.Lookup(id); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("bounded admission created a record: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("bounded admission reached provider")
	}
	<-service.slots
	if _, created, err := submitDirect(t, service, storage, provider.URL+"/responses", id, body); err != nil || !created {
		t.Fatalf("retry after limit: created=%t err=%v", created, err)
	}
	terminal := waitJobTerminal(t, box, id)
	if terminal.State != protocol.Completed || calls.Load() != 1 {
		t.Fatalf("retry did not complete once: %+v calls=%d", terminal, calls.Load())
	}
}
