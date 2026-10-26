package client_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/server"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func disconnect(w http.ResponseWriter) {
	connection, _, err := w.(http.Hijacker).Hijack()
	if err == nil {
		_ = connection.Close()
	}
}

func copyRecorded(w http.ResponseWriter, record *httptest.ResponseRecorder, truncated bool) {
	for key, values := range record.Header() {
		w.Header()[key] = values
	}
	w.WriteHeader(record.Code)
	data := record.Body.Bytes()
	if truncated {
		data = data[:len(data)/2]
	}
	_, _ = w.Write(data)
	if truncated {
		w.(http.Flusher).Flush()
		disconnect(w)
	}
}

func recoveryConfig(url string) client.Config {
	return client.Config{URL: url, Token: token, RetryWindow: 2 * time.Second, RetryMin: time.Millisecond, RetryMax: 5 * time.Millisecond, StallTimeout: time.Second}
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for !condition() {
		select {
		case <-deadline.C:
			t.Fatal("condition did not become true")
		case <-ticker.C:
		}
	}
}

func recoveryServer(t *testing.T, provider *httptest.Server, wrap func(http.Handler) http.Handler) (*server.Server, *httptest.Server, *httptest.Server, string) {
	t.Helper()
	directory := t.TempDir()
	storage, err := store.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	rules := []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/"}}
	h, err := server.New(server.Config{Store: storage, Token: token, Upstreams: rules, AllowPrivateUpstreams: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	direct := httptest.NewServer(h)
	t.Cleanup(direct.Close)
	var handler http.Handler = h
	if wrap != nil {
		handler = wrap(h)
	}
	link := httptest.NewServer(handler)
	t.Cleanup(link.Close)
	return h, link, direct, directory
}

func TestLostSubmissionAckAndOfflineResponseResumeWithoutRegeneration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var calls, submissions, offlineAttempts atomic.Int32
	var offline atomic.Bool
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	first := "data: first\n\n"
	last := "data: tool-call\n\ndata: [DONE]\n\n"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, first)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, last)
	}))
	t.Cleanup(provider.Close)
	_, link, direct, _ := recoveryServer(t, provider, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if offline.Load() {
				offlineAttempts.Add(1)
				w.WriteHeader(503)
				return
			}
			if r.Method == http.MethodPut && submissions.Add(1) == 1 {
				record := httptest.NewRecorder()
				h.ServeHTTP(record, r)
				disconnect(w) // The durable acceptance exists, but its ACK is lost.
				return
			}
			h.ServeHTTP(w, r)
		})
	})
	c := newClient(t, recoveryConfig(link.URL))
	id := "offline-mailbox-request-0001"
	response, _, err := c.Forward(ctx, client.Request{ID: id, Target: provider.URL + "/responses", Method: "POST", Headers: http.Header{"Content-Type": []string{"application/json"}}}, strings.NewReader(`{"input":"original"}`))
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("stream did not start live: %q %v", line, err)
	}
	offline.Store(true)
	type result struct {
		data []byte
		err  error
	}
	completed := make(chan result, 1)
	go func() { data, err := io.ReadAll(reader); completed <- result{data, err} }()
	eventually(t, func() bool { return offlineAttempts.Load() > 0 })
	releaseOnce.Do(func() { close(release) })
	admin := newClient(t, recoveryConfig(direct.URL))
	eventually(t, func() bool {
		status, err := admin.Status(ctx, id)
		return err == nil && status.State == protocol.Completed
	})
	// Provider completion above was independent of the still-disconnected PC.
	offline.Store(false)
	select {
	case result := <-completed:
		if result.err != nil || line+string(result.data) != first+last {
			t.Fatalf("resumed stream changed: %q %v", line+string(result.data), result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	response.Body.Close()
	if calls.Load() != 1 || submissions.Load() < 2 {
		t.Fatalf("dispatches=%d submissions=%d", calls.Load(), submissions.Load())
	}
	// A new PC client can retrieve the entire saved answer using just its ID.
	restarted := newClient(t, recoveryConfig(link.URL))
	response, err = restarted.Resume(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(data) != first+last {
		t.Fatalf("saved answer lost: %q %v", data, err)
	}
	_, _, err = restarted.Forward(ctx, client.Request{ID: id, Target: provider.URL + "/responses", Method: "POST"}, strings.NewReader("different request"))
	var conflict *client.HTTPError
	if !errors.As(err, &conflict) || conflict.Status != 409 || calls.Load() != 1 {
		t.Fatalf("ID conflict replayed provider: %v", err)
	}
	if err := restarted.Ack(ctx, id, protocol.Receipt{Size: int64(len(data)), Hash: protocol.Sum(data)}); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Resume(ctx, id); !errors.As(err, &conflict) || conflict.Status != 410 {
		t.Fatalf("ACK did not release response: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatal("retrieval or ACK regenerated provider response")
	}
}

func TestTruncatedResponseSegmentRetriesSameOffset(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	payload := strings.Repeat("opaque-provider-bytes\x00", 30000)
	var calls, truncated atomic.Int32
	var offsetsMu sync.Mutex
	var offsets []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, payload)
	}))
	t.Cleanup(provider.Close)
	_, link, _, _ := recoveryServer(t, provider, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/response") {
				offsetsMu.Lock()
				offsets = append(offsets, r.URL.Query().Get("offset"))
				offsetsMu.Unlock()
				record := httptest.NewRecorder()
				h.ServeHTTP(record, r)
				cut := record.Body.Len() > 0 && truncated.CompareAndSwap(0, 1)
				copyRecorded(w, record, cut)
				return
			}
			h.ServeHTTP(w, r)
		})
	})
	c := newClient(t, recoveryConfig(link.URL))
	response, _, err := c.Forward(ctx, client.Request{ID: "segment-retry-request-0001", Target: provider.URL + "/responses", Method: "POST"}, strings.NewReader("request"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(data) != payload {
		t.Fatalf("segment recovery failed: bytes=%d %v", len(data), err)
	}
	offsetsMu.Lock()
	defer offsetsMu.Unlock()
	if len(offsets) < 2 || offsets[0] != "0" || offsets[1] != "0" || calls.Load() != 1 {
		t.Fatalf("wrong resume offsets or duplicate dispatch: %v %d", offsets, calls.Load())
	}
}

func TestInterruptedUploadReinventoriesPersistedChunks(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	provider := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(provider.Close)
	var interrupted atomic.Bool
	var firstHash string
	var uploadsMu sync.Mutex
	uploads := make(map[string]int)
	_, link, _, _ := recoveryServer(t, provider, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v2/chunks" {
				h.ServeHTTP(w, r)
				return
			}
			data, _ := io.ReadAll(r.Body)
			reader := bytes.NewReader(data)
			count, err := protocol.ReadBatchHeader(reader)
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			if interrupted.CompareAndSwap(false, true) {
				chunk, _, err := protocol.ReadChunk(reader)
				if err != nil || count < 2 {
					t.Errorf("batch too small: %d %v", count, err)
					w.WriteHeader(500)
					return
				}
				uploadsMu.Lock()
				firstHash = chunk.Hash
				uploads[chunk.Hash]++
				uploadsMu.Unlock()
				cut := len(data) - reader.Len() + 3 // One full verified chunk, then an incomplete frame.
				r.Body = io.NopCloser(bytes.NewReader(data[:cut]))
				r.ContentLength = int64(cut)
				h.ServeHTTP(httptest.NewRecorder(), r)
				disconnect(w)
				return
			}
			for i := 0; i < count; i++ {
				chunk, _, err := protocol.ReadChunk(reader)
				if err != nil {
					t.Error(err)
					break
				}
				uploadsMu.Lock()
				uploads[chunk.Hash]++
				uploadsMu.Unlock()
			}
			r.Body = io.NopCloser(bytes.NewReader(data))
			h.ServeHTTP(w, r)
		})
	})
	config := recoveryConfig(link.URL)
	config.NoCompression, config.Workers, config.BatchBytes = true, 1, 256<<10
	c := newClient(t, config)
	body := data(768 << 10)
	stats, err := c.Sync(ctx, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	uploadsMu.Lock()
	defer uploadsMu.Unlock()
	if uploads[firstHash] != 1 {
		t.Fatalf("persisted chunk retransmitted %d times", uploads[firstHash])
	}
	if stats.UploadedChunkBytes != int64(len(body)) || !interrupted.Load() {
		t.Fatal("recovered upload accounting is wrong")
	}
	output := filepath.Join(t.TempDir(), "body")
	if err := c.Fetch(ctx, stats.Hash, output); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(output)
	if !bytes.Equal(got, body) {
		t.Fatal("recovered upload changed bytes")
	}
}

func TestBodyDownloadCheckpointSurvivesClientRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	provider := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(provider.Close)
	var cut atomic.Bool
	cut.Store(true)
	var rangesMu sync.Mutex
	var ranges []string
	_, link, _, _ := recoveryServer(t, provider, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v2/bodies/") {
				rangesMu.Lock()
				ranges = append(ranges, r.Header.Get("Range"))
				rangesMu.Unlock()
				if r.Header.Get("Range") != "bytes=0-262143" && cut.CompareAndSwap(true, false) {
					record := httptest.NewRecorder()
					h.ServeHTTP(record, r)
					copyRecorded(w, record, true)
					return
				}
			}
			h.ServeHTTP(w, r)
		})
	})
	config := recoveryConfig(link.URL)
	config.NoRetry = true
	c := newClient(t, config)
	body := data(800 << 10)
	stats, err := c.Sync(ctx, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "download")
	if err := c.Fetch(ctx, stats.Hash, output); err == nil {
		t.Fatal("truncated range falsely completed")
	}
	if _, err := os.Stat(output); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial file published")
	}
	c.Close()
	rangesMu.Lock()
	ranges = nil
	rangesMu.Unlock()
	restarted := newClient(t, recoveryConfig(link.URL))
	if err := restarted.Fetch(ctx, stats.Hash, output); err != nil {
		t.Fatal(err)
	}
	rangesMu.Lock()
	defer rangesMu.Unlock()
	if len(ranges) == 0 || ranges[0] != "bytes=262144-524287" {
		t.Fatalf("download did not resume from durable prefix: %v", ranges)
	}
	got, _ := os.ReadFile(output)
	if !bytes.Equal(got, body) {
		t.Fatal("resumed export differs")
	}
	parts, _ := filepath.Glob(filepath.Join(filepath.Dir(output), ".deltarelay-*.part*"))
	if len(parts) != 0 {
		t.Fatal("successful download left partial checkpoints")
	}
}

func TestOfflineCancellationOutboxSurvivesGatewayRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var offline atomic.Bool
	stopped := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "first bytes")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(stopped)
	}))
	t.Cleanup(provider.Close)
	_, link, _, _ := recoveryServer(t, provider, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if offline.Load() {
				w.WriteHeader(503)
				return
			}
			h.ServeHTTP(w, r)
		})
	})
	config := recoveryConfig(link.URL)
	config.ControlDir = filepath.Join(t.TempDir(),"state")
	c := newClient(t, config)
	requestCtx, stop := context.WithCancel(ctx)
	response, _, err := c.Forward(requestCtx, client.Request{ID: "offline-cancel-request-0001", Target: provider.URL + "/responses", Method: "POST"}, strings.NewReader("request"))
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1)
	if _, err := response.Body.Read(buffer); err != nil {
		t.Fatal(err)
	}
	offline.Store(true)
	stop()
	response.Body.Close()
	eventually(t, func() bool { pending, _ := c.ControlStatus(); return pending == 1 })
	c.Close()
	files, _ := filepath.Glob(filepath.Join(config.ControlDir, "*.cancel.json"))
	if len(files) != 1 {
		t.Fatal("offline cancellation was not persisted")
	}
	select {
	case <-stopped:
		t.Fatal("PC link loss implicitly cancelled provider before cancellation could be delivered")
	default:
	}
	restarted := newClient(t, config)
	offline.Store(false)
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("pending cancellation was not delivered after reconnect")
	}
	eventually(t, func() bool { pending, _ := restarted.ControlStatus(); return pending == 0 })
	files, _ = filepath.Glob(filepath.Join(config.ControlDir, "*.cancel.json"))
	if len(files) != 0 {
		t.Fatal("delivered cancellation checkpoint not removed")
	}
}

func TestChangedRelayStateFailsClosedAcrossClientRestarts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first := fixture(t, t.TempDir())
	second := fixture(t, t.TempDir())
	directory := filepath.Join(t.TempDir(),"state")
	config := recoveryConfig(first.URL)
	config.ControlDir = directory
	c := newClient(t, config)
	if _, err := c.Info(ctx); err != nil {
		t.Fatal(err)
	}
	c.Close()
	config.URL = second.URL
	replacement := newClient(t, config)
	if _, err := replacement.Info(ctx); err == nil {
		t.Fatal("replacement relay was silently trusted")
	}
	if _, err := replacement.Sync(ctx, strings.NewReader("must not upload")); err == nil {
		t.Fatal("changed relay identity allowed upload")
	}
}

func TestRetryStopsForPermanentErrorsAndCallerCancellation(t *testing.T) {
	var attempts atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attempts.Add(1); w.WriteHeader(401) }))
	defer remote.Close()
	c := newClient(t, recoveryConfig(remote.URL))
	if _, err := c.Info(context.Background()); err == nil || attempts.Load() != 1 {
		t.Fatal("authentication failure retried")
	}
	stall := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer stall.Close()
	config := recoveryConfig(stall.URL)
	config.StallTimeout = 10 * time.Millisecond
	stalled := newClient(t, config)
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if _, err := stalled.Info(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancellation did not interrupt stalled RPC/retry: %v", err)
	}
}
