package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/gateway"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

// BenchmarkGatewayRequestStartup uses the real gateway, client, relay, journal,
// and mailbox with a loopback mock provider. Only the local HTTP listener is
// omitted. Persistence off means in-memory telemetry, not disabled accounting.
// Run fixed iteration counts to keep the retained-history workload comparable.
func BenchmarkGatewayRequestStartup(b *testing.B) {
	for _, persistent := range []bool{false, true} {
		for _, concurrent := range []bool{false, true} {
			b.Run(fmt.Sprintf("persistent=%t/mailbox-active=%t", persistent, concurrent), func(b *testing.B) {
				benchmarkGatewayRequestStartup(b, persistent, concurrent)
			})
		}
	}
}

func benchmarkGatewayRequestStartup(b *testing.B, persistent, concurrent bool) {
	directory := b.TempDir()
	providerStarted := make(chan time.Time, 1)
	const response = "data: baseline\n\ndata: [DONE]\n\n"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerStarted <- time.Now()
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, response)
	}))
	b.Cleanup(provider.Close)
	storage, err := store.Open(filepath.Join(directory, "relay"))
	if err != nil {
		b.Fatal(err)
	}
	rules := []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/v1/"}}
	// Bound background work to one 32 KiB append/read pair per foreground request.
	// Capacity scales with the fixed iteration count, not with an unbounded writer.
	h, err := New(Config{Store: storage, Token: "synthetic-relay-token", Upstreams: rules, AllowPrivateUpstreams: true,
		MaxResponseBytes: max(256<<20, int64(b.N)*(32<<10)), MaxResponseStorageBytes: max(4<<30, int64(b.N+1)*(33<<10)),
		MaxJournalRecords: max(100000, b.N+1)})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(h.Close)
	relay := httptest.NewServer(h)
	b.Cleanup(relay.Close)
	c, err := client.New(client.Config{URL: relay.URL, Token: "synthetic-relay-token", NoRetry: true, TempDir: directory})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(c.Close)
	body := []byte(`{"input":"` + strings.Repeat("x", 16<<10) + `"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	b.Cleanup(cancel)
	if _, err := c.Sync(ctx, bytes.NewReader(body)); err != nil {
		b.Fatal(err)
	}
	statsFile := ""
	if persistent {
		statsFile = filepath.Join(directory, "stats.json")
	}
	var gatewayReady time.Time
	var result gateway.Result
	g, err := gateway.New(gateway.Config{Client: c, LocalToken: "synthetic-local-token", Upstreams: rules, AllowPrivateUpstreams: true,
		StatsFile: statsFile, OnStart: func(string) { gatewayReady = time.Now() }, OnResult: func(r gateway.Result) { result = r }})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(g.Close)
	var work chan struct{}
	var completed chan error
	var mailboxTime time.Duration
	if concurrent {
		const id = "baseline-background-request"
		fingerprint := protocol.Sum([]byte("synthetic-background-request"))
		if _, created, err := h.mailbox.Accept(id, fingerprint, protocol.Sum(nil), func() error {
			return h.jobs.journal.Claim(id, fingerprint)
		}); err != nil || !created {
			b.Fatalf("background acceptance: %t %v", created, err)
		}
		if _, started, err := h.mailbox.Start(id, ctx, 5*time.Minute); err != nil || !started {
			b.Fatalf("background startup: %t %v", started, err)
		}
		work, completed = make(chan struct{}), make(chan error, 1)
		stopped := make(chan struct{})
		go func() {
			defer close(stopped)
			frame := bytes.Repeat([]byte("m"), 32<<10)
			var offset int64
			for range work {
				started := time.Now()
				err := h.mailbox.Append(id, frame)
				if err == nil {
					var data []byte
					_, data, _, err = h.mailbox.Read(id, offset)
					if err == nil && !bytes.Equal(data, frame) {
						err = fmt.Errorf("background response bytes changed at offset %d", offset)
					}
				}
				offset += int64(len(frame))
				mailboxTime += time.Since(started)
				completed <- err
			}
		}()
		b.Cleanup(func() { close(work); <-stopped })
	}
	var readyTime, providerTime time.Duration
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/proxy", bytes.NewReader(body)).WithContext(ctx)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-DeltaRelay-Local-Token", "synthetic-local-token")
		r.Header.Set("X-DeltaRelay-Target", provider.URL+"/v1/responses")
		r.Header.Set("X-DeltaRelay-Request-ID", fmt.Sprintf("baseline-request-%08d", i))
		r.Header.Set("X-DeltaRelay-Session-ID", "baseline-session")
		w := httptest.NewRecorder()
		started := time.Now()
		if concurrent {
			work <- struct{}{}
		}
		g.ServeHTTP(w, r)
		if concurrent {
			if err := <-completed; err != nil {
				b.Fatal(err)
			}
		}
		if w.Code != http.StatusOK || result.Failed || w.Body.String() != response || result.Stats.UploadedChunks != 0 {
			b.Fatalf("warm forwarding failed: status=%d result=%+v response=%q", w.Code, result, w.Body.String())
		}
		select {
		case at := <-providerStarted:
			providerTime += at.Sub(started)
		default:
			b.Fatal("request never reached the mock provider")
		}
		readyTime += gatewayReady.Sub(started)
	}
	b.StopTimer()
	b.ReportMetric(float64(readyTime.Nanoseconds())/float64(b.N), "gateway-ready-ns/op")
	b.ReportMetric(float64(providerTime.Nanoseconds())/float64(b.N), "provider-start-ns/op")
	if concurrent {
		b.ReportMetric(float64(mailboxTime.Nanoseconds())/float64(b.N), "mailbox-pair-ns/op")
	}
}
