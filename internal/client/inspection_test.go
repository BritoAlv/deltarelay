package client_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"deltarelay/internal/client"
	"deltarelay/internal/inspection"
)

func captureDetail(t *testing.T, s *inspection.Store, id string) inspection.Detail {
	t.Helper()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/v1/inspection/"+id, nil))
	var detail inspection.Detail
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &detail) != nil {
		t.Fatalf("capture unavailable: %d %s", w.Code, w.Body.String())
	}
	return detail
}

func TestCapturedAttemptsMatchActualRelayBodies(t *testing.T) {
	relay := fixture(t, t.TempDir())
	var mu sync.Mutex
	var received [][]byte
	link := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
			}
			mu.Lock()
			received = append(received, bytes.Clone(body))
			mu.Unlock()
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		relay.Config.Handler.ServeHTTP(w, r)
	}))
	defer link.Close()
	c := newClient(t, client.Config{URL: link.URL, Workers: 1})
	dir := t.TempDir()
	s, err := inspection.Open(inspection.Config{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	body := bytes.Repeat([]byte("Repeated Unicode é and binary \x00\xff\n"), 10000)
	for run := 0; run < 2; run++ {
		capture := s.Begin("observed-upload-0001", uint64(run+1), "application/octet-stream")
		mu.Lock()
		received = nil
		mu.Unlock()
		stats, err := c.Sync(inspection.WithCapture(context.Background(), capture), bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		capture.Finish(stats, "completed")
		detail := captureDetail(t, s, capture.ID())
		if detail.Body.SHA256 != stats.Hash || detail.Body.SourceBytes != stats.BodyBytes || detail.Body.CapturedBytes != int64(len(body)) || len(detail.Inventories) != 1 {
			t.Fatal("source and inventory evidence differ from transfer")
		}
		mu.Lock()
		if len(detail.Attempts) != len(received) || int64(len(detail.Attempts)) != stats.Requests {
			t.Fatalf("attempt scope mismatch: %d %d %d", len(detail.Attempts), len(received), stats.Requests)
		}
		var total int64
		for i, attempt := range detail.Attempts {
			stored, err := os.ReadFile(filepath.Join(dir, capture.ID(), attempt.Payload.ID+".bin"))
			if err != nil || !bytes.Equal(stored, received[i]) {
				t.Fatalf("attempt %d bytes differ from actual relay input: %v", i, err)
			}
			if attempt.ConsumedBytes != int64(len(received[i])) || attempt.PreparedBytes != int64(len(received[i])) {
				t.Fatal("consumed/prepared lengths not observed")
			}
			if attempt.Operation == "chunks" && !attempt.AcknowledgmentOK {
				t.Fatal("valid upload acknowledgment not captured")
			}
			total += attempt.ConsumedBytes
		}
		mu.Unlock()
		if total != stats.RequestBodyBytesSent {
			t.Fatalf("capture consumption does not reconcile: %d vs %d", total, stats.RequestBodyBytesSent)
		}
		if run == 1 && (detail.Inventories[0].MissingChunks != 0 || stats.UploadedChunks != 0 || stats.ReusedBodyBytes != int64(len(body))) {
			t.Fatal("warm inventory fabricated missing chunks or uploads")
		}
	}
}
