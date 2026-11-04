package inspection

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"deltarelay/internal/protocol"
	"deltarelay/internal/transfer"
)

func openTestStore(t *testing.T, config Config) *Store {
	t.Helper()
	if config.Dir == "" {
		config.Dir = t.TempDir()
	}
	s, err := Open(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func inspect(t *testing.T, s *Store, suffix string, want int, target any) []byte {
	t.Helper()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/inspection/"+suffix, nil))
	if w.Code != want {
		t.Fatalf("inspection %s: %d %s", suffix, w.Code, w.Body.String())
	}
	if target != nil {
		if err := json.Unmarshal(w.Body.Bytes(), target); err != nil {
			t.Fatal(err)
		}
	}
	return w.Body.Bytes()
}

func TestBodyInventoryAndPagingAreActualByteEvidence(t *testing.T) {
	s := openTestStore(t, Config{})
	c := s.Begin("request-evidence-0001", 9, "application/octet-stream")
	body := []byte{0, 0xff, 'a', 0, 0xff, 'a', 0xc3, 0xa9}
	ctx := WithCapture(context.Background(), c)
	read, err := io.ReadAll(ObserveBody(ctx, bytes.NewReader(body)))
	if err != nil || !bytes.Equal(read, body) {
		t.Fatal("capture altered source")
	}
	a, b := protocol.Chunk{Hash: protocol.Sum(body[:3]), Size: 3}, protocol.Chunk{Hash: protocol.Sum(body[6:]), Size: 2}
	c.Chunk(a, 0)
	c.Chunk(a, 3)
	c.Chunk(b, 6)
	c.Inventory("initial", strings.Repeat("a", 64), nil, []protocol.Chunk{b})
	c.Inventory("recovery", strings.Repeat("a", 64), []protocol.Chunk{b}, nil)
	c.Finish(transfer.Stats{Hash: protocol.Sum(body), BodyBytes: 8}, "completed")
	var detail Detail
	inspect(t, s, c.ID(), 200, &detail)
	if !detail.Body.Complete || detail.Body.SHA256 != protocol.Sum(body) || detail.Body.CapturedBytes != 8 || detail.ChunkCount != 3 {
		t.Fatalf("wrong body evidence: %+v", detail)
	}
	if detail.Inventories[0].PresentBodyBytes != 6 || detail.Inventories[0].MissingBodyBytes != 2 || detail.Inventories[0].UnknownBodyBytes != 0 || detail.Inventories[0].MissingBytes != 2 {
		t.Fatalf("wrong initial inventory byte accounting: %+v", detail.Inventories[0])
	}
	if detail.Inventories[1].PresentBodyBytes != 2 || detail.Inventories[1].MissingBodyBytes != 0 || detail.Inventories[1].UnknownBodyBytes != 6 {
		t.Fatalf("recovery inventory invented scope: %+v", detail.Inventories[1])
	}
	var page struct {
		Chunks []ChunkView `json:"chunks"`
	}
	inspect(t, s, c.ID()+"/chunks?start=0&limit=2&inventory=0", 200, &page)
	if len(page.Chunks) != 2 || page.Chunks[1].Offset != 3 || page.Chunks[1].Occurrences != 2 || page.Chunks[1].Availability != "present" {
		t.Fatalf("invented ranges: %+v", page)
	}
	inspect(t, s, c.ID()+"/chunks?start=0&inventory=1", 200, &page)
	if page.Chunks[0].Availability != "unknown" || page.Chunks[2].Availability != "present" {
		t.Fatalf("recovery incorrectly applied outside its scope: %+v", page)
	}
	var artifact struct {
		Data   string `json:"data"`
		Offset int64  `json:"offset"`
		Total  int64  `json:"total"`
	}
	inspect(t, s, c.ID()+"/artifacts/body?offset=1&limit=4", 200, &artifact)
	got, _ := base64.StdEncoding.DecodeString(artifact.Data)
	if !bytes.Equal(got, body[1:5]) || artifact.Offset != 1 || artifact.Total != 8 {
		t.Fatal("byte window changed original binary bytes")
	}
	if got := inspect(t, s, c.ID()+"/artifacts/body/download", 200, nil); !bytes.Equal(got, body) {
		t.Fatal("download was not byte exact")
	}
	for _, name := range []string{"body.bin", "capture.json"} {
		info, err := os.Stat(filepath.Join(s.config.Dir, c.ID(), name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("capture file not private: %s %v", name, err)
		}
	}
}

func TestEncodedPayloadCompressionAndCredentialProjection(t *testing.T) {
	s := openTestStore(t, Config{})
	c := s.Begin("request-evidence-0002", 1, "application/json")
	ctx := WithCapture(context.Background(), c)
	plain := bytes.Repeat([]byte("actual chunk batch bytes"), 100)
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write(plain)
	_ = gz.Close()
	index := c.BeginAttempt(ctx, "chunks", "POST", "/chunks", protocol.BatchContentType, "gzip", plain, compressed.Bytes(), true)
	c.Consume(index, 7)
	c.EndAttempt(index, 0, "transport_error")
	var page struct {
		Data    string `json:"data"`
		Decoded bool   `json:"decoded"`
	}
	inspect(t, s, c.ID()+"/artifacts/attempt-0?limit=65536", 200, &page)
	got, _ := base64.StdEncoding.DecodeString(page.Data)
	if !bytes.Equal(got, compressed.Bytes()) {
		t.Fatal("stored bytes were recompressed or reconstructed")
	}
	inspect(t, s, c.ID()+"/artifacts/attempt-0?decode=1&limit=65536", 200, &page)
	got, _ = base64.StdEncoding.DecodeString(page.Data)
	if !bytes.Equal(got, plain) || !page.Decoded {
		t.Fatal("decoded view does not match actual gzip content")
	}
	forward, _ := json.Marshal(protocol.ForwardRequest{Version: 2, ID: "request-evidence-0002", Target: "https://private-target.example/path?secret=query", Method: "POST", Headers: http.Header{"Authorization": {"Bearer provider-secret"}, "X-Custom-Credential": {"custom-secret"}}})
	index = c.BeginAttempt(ctx, "dispatch", "PUT", "/requests/"+c.ID(), "application/json", "identity", forward, forward, true)
	c.Consume(index, len(forward))
	c.EndAttempt(index, 200, "response_read")
	c.Finish(transfer.Stats{RequestBodyBytesSent: int64(len(forward) + 7)}, "completed")
	s.flush()
	tree, err := os.ReadDir(filepath.Join(s.config.Dir, c.ID()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range tree {
		data, _ := os.ReadFile(filepath.Join(s.config.Dir, c.ID(), file.Name()))
		for _, secret := range []string{"provider-secret", "custom-secret", "private-target", "secret=query"} {
			if bytes.Contains(data, []byte(secret)) {
				t.Fatalf("credential/URL retained in %s: %s", file.Name(), secret)
			}
		}
	}
	a := c.snapshot().Attempts[1]
	if a.Payload.Representation != "redacted" || a.PreparedBytes != int64(len(forward)) || a.ConsumedBytes != int64(len(forward)) || a.Payload.SourceBytes == a.PreparedBytes {
		t.Fatalf("redaction was presented as original evidence: %+v", a)
	}
}

func TestUnknownOperationRetainsLengthsButNoPayload(t *testing.T) {
	s := openTestStore(t, Config{})
	c := s.Begin("request-evidence-0011", 11, "application/json")
	secret := []byte(`{"Authorization":"Bearer provider-secret","target":"https://private.example"}`)
	index := c.BeginAttempt(WithCapture(context.Background(), c), "control", "POST", "/unknown-future-operation", "application/json", "identity", secret, secret, true)
	c.Consume(index, 7)
	c.EndAttempt(index, 200, "response_ok")
	c.Finish(transfer.Stats{BodyBytes: 7, RequestBodyBytesSent: int64(len(secret))}, "completed")
	s.flush()
	detail := inspect(t, s, c.ID(), 200, nil)
	if !bytes.Contains(detail, []byte(`"path":"/unknown-future-operation"`)) || bytes.Contains(detail, []byte("provider-secret")) {
		t.Fatal("unknown operation metadata was lost or its payload was retained")
	}
	var d Detail
	_ = json.Unmarshal(detail, &d)
	if len(d.Attempts) != 1 || d.Attempts[0].Payload != nil || d.Attempts[0].PreparedBytes != int64(len(secret)) || d.Attempts[0].ConsumedBytes != 7 {
		t.Fatalf("unknown operation evidence was not length-only: %+v", d.Attempts)
	}
	files, _ := os.ReadDir(filepath.Join(s.config.Dir, c.ID()))
	for _, file := range files {
		data, _ := os.ReadFile(filepath.Join(s.config.Dir, c.ID(), file.Name()))
		if bytes.Contains(data, []byte("provider-secret")) {
			t.Fatal("unknown operation payload reached disk")
		}
	}
}

func TestQuotaKeepsContiguousPrefixAndSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	config := Config{Dir: dir, MaxBytes: 128 << 10, MaxCaptureBytes: 32 << 10}
	s := openTestStore(t, config)
	c := s.Begin("request-evidence-0003", 3, "text/plain")
	body := bytes.Repeat([]byte("secret body"), 10000)
	got, err := io.ReadAll(ObserveBody(WithCapture(context.Background(), c), bytes.NewReader(body)))
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("quota interfered with source read")
	}
	c.Finish(transfer.Stats{BodyBytes: int64(len(body)), Hash: protocol.Sum(body)}, "completed")
	s.Close()
	s2 := openTestStore(t, config)
	restored, ok := s2.get(c.ID())
	if !ok {
		t.Fatal("completed capture lost on restart")
	}
	a := restored.snapshot().Body
	if !a.Complete || !a.Truncated || a.CapturedBytes >= int64(len(body)) || a.SHA256 != protocol.Sum(body) {
		t.Fatalf("missing explicit truncation: %+v", a)
	}
	retained := inspect(t, s2, c.ID()+"/artifacts/body/download", 200, nil)
	if !bytes.Equal(retained, body[:a.CapturedBytes]) {
		t.Fatal("capture is not a contiguous source prefix")
	}
	files, _ := os.ReadDir(filepath.Join(dir, c.ID()))
	var diskBytes int64
	for _, f := range files {
		info, _ := f.Info()
		diskBytes += info.Size()
	}
	if diskBytes > config.MaxCaptureBytes {
		t.Fatalf("quota exceeded: %d", diskBytes)
	}
}

func TestShortArtifactAfterCrashIsClampedAndLabeled(t *testing.T) {
	dir := t.TempDir()
	config := Config{Dir: dir}
	s := openTestStore(t, config)
	c := s.Begin("request-evidence-0010", 10, "text/plain")
	body := []byte("the retained file is deliberately shortened")
	_, _ = io.Copy(io.Discard, ObserveBody(WithCapture(context.Background(), c), bytes.NewReader(body)))
	c.Finish(transfer.Stats{BodyBytes: int64(len(body))}, "completed")
	s.Close()
	path := filepath.Join(dir, c.ID(), "body.bin")
	if err := os.Truncate(path, 7); err != nil {
		t.Fatal(err)
	}
	s2 := openTestStore(t, config)
	restored, ok := s2.get(c.ID())
	if !ok {
		t.Fatal("clamped capture was discarded")
	}
	a := restored.snapshot().Body
	if a.CapturedBytes != 7 || !a.Truncated || !a.WriteError || !restored.snapshot().StorageError {
		t.Fatalf("short artifact was still claimed complete: %+v", a)
	}
	if data := inspect(t, s2, c.ID()+"/artifacts/body/download", 200, nil); string(data) != string(body[:7]) {
		t.Fatal("short artifact did not expose exactly its retained prefix")
	}
}

func TestRetentionInterruptionAndUnsafePaths(t *testing.T) {
	config := Config{Dir: t.TempDir(), MaxCaptures: 2, MaxAge: time.Hour}
	s := openTestStore(t, config)
	a := s.Begin("request-evidence-0004", 1, "")
	b := s.Begin("request-evidence-0004", 2, "")
	if a.ID() == b.ID() {
		t.Fatal("reused request IDs mixed observations")
	}
	if s.Begin("request-evidence-0005", 3, "") != nil {
		t.Fatal("active capture evicted to admit another")
	}
	a.Finish(transfer.Stats{}, "completed")
	s.prune(time.Now(), 0, 0)
	if _, ok := s.get(a.ID()); !ok {
		t.Fatal("exactly-full count incorrectly pruned")
	}
	c := s.Begin("request-evidence-0005", 3, "")
	if c == nil {
		t.Fatal("idle capture was not evicted")
	}
	if _, ok := s.get(a.ID()); ok {
		t.Fatal("old capture remains retained")
	}
	c.Finish(transfer.Stats{}, "completed")
	s.Close()
	s2 := openTestStore(t, config)
	restored, _ := s2.get(b.ID())
	if restored.snapshot().State != "interrupted" {
		t.Fatal("restart fabricated a finished transfer")
	}
	for _, route := range []string{b.ID() + "/artifacts/../../capture.json", b.ID() + "/chunks?limit=257", b.ID() + "?target=http://attacker", b.ID() + "/chunks?start=-1", b.ID() + "/artifacts/body?limit=65537", b.ID() + "/attempts/999", b.ID() + "/artifacts/body?offset=0&offset=1"} {
		if parts := strings.SplitN(route, "?", 2); len(parts) == 2 {
			q, _ := url.ParseQuery(parts[1])
			if ValidRoute(parts[0], q) {
				t.Fatalf("unsafe route accepted: %s", route)
			}
		} else if ValidRoute(route, nil) {
			t.Fatalf("unsafe route accepted: %s", route)
		}
	}
	s2.prune(time.Now().Add(2*time.Hour), 0, 0)
	inspect(t, s2, b.ID(), 404, nil)
}

func TestInterruptedCaptureSurvivesRepeatedRestart(t *testing.T) {
	dir := t.TempDir()
	config := Config{Dir: dir}
	s := openTestStore(t, config)
	c := s.Begin("request-evidence-0012", 12, "")
	_, _ = io.Copy(io.Discard, ObserveBody(WithCapture(context.Background(), c), strings.NewReader("partial")))
	s.Close()
	for attempt := 0; attempt < 2; attempt++ {
		reopened := openTestStore(t, config)
		restored, ok := reopened.get(c.ID())
		if !ok {
			t.Fatal("interrupted capture disappeared across restart")
		}
		snapshot := restored.snapshot()
		if snapshot.State != "interrupted" || snapshot.FinishedAt == nil {
			t.Fatalf("restart %d did not record an interrupted observation: %+v", attempt, snapshot)
		}
		reopened.Close()
	}
}

func TestUncommittedCaptureDirectoryDoesNotBlockStartup(t *testing.T) {
	dir := t.TempDir()
	s := openTestStore(t, Config{Dir: dir})
	s.Close()
	emptyID := strings.Repeat("d", 32)
	if err := os.Mkdir(filepath.Join(dir, emptyID), 0700); err != nil {
		t.Fatal(err)
	}
	pendingID := strings.Repeat("e", 32)
	if err := os.Mkdir(filepath.Join(dir, pendingID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pendingID, ".pending-initial"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	reopened := openTestStore(t, Config{Dir: dir})
	if _, ok := reopened.get(emptyID); ok {
		t.Fatal("empty uncommitted capture was exposed")
	}
	if _, err := os.Stat(filepath.Join(dir, emptyID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("empty uncommitted capture was not removed")
	}
	if _, err := os.Stat(filepath.Join(dir, pendingID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("pending-only uncommitted capture was not removed")
	}
	reopened.Close()
	foreignID := strings.Repeat("f", 32)
	if err := os.Mkdir(filepath.Join(dir, foreignID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, foreignID, "body.bin"), []byte("unowned"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(Config{Dir: dir}); err == nil {
		t.Fatal("directory without metadata but with artifact data was silently adopted")
	}
}

func TestCaptureDirectoryLockPermissionsAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	s := openTestStore(t, Config{Dir: dir})
	if _, err := Open(Config{Dir: dir}); err == nil {
		t.Fatal("two writers allowed")
	}
	c := s.Begin("request-evidence-0006", 6, "")
	_, _ = io.Copy(io.Discard, ObserveBody(WithCapture(context.Background(), c), strings.NewReader("content")))
	c.Finish(transfer.Stats{}, "completed")
	path := filepath.Join(dir, c.ID(), "body.bin")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, c.ID(), "capture.json"), path); err != nil {
		t.Fatal(err)
	}
	inspect(t, s, c.ID()+"/artifacts/body", 409, nil)
	public := t.TempDir()
	_ = os.Chmod(public, 0755)
	if _, err := Open(Config{Dir: public}); err == nil {
		t.Fatal("public capture directory accepted")
	}
}

func TestConcurrentEvidenceAndStorageFailureDoNotChangeSource(t *testing.T) {
	s := openTestStore(t, Config{})
	c := s.Begin("request-evidence-0007", 7, "")
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := WithCapture(context.Background(), c)
			index := c.BeginAttempt(ctx, "inventory", "POST", "/missing", "application/json", "identity", []byte("{}"), []byte("{}"), true)
			c.Consume(index, 2)
			c.EndAttempt(index, 200, "response_read")
			_ = c.snapshot()
		}()
	}
	wg.Wait()
	if len(c.snapshot().Attempts) != 12 {
		t.Fatal("concurrent attempts mixed")
	}
	// A non-file at the body path simulates an artifact write error without
	// relying on root/non-root permission differences in CI.
	if err := os.Mkdir(filepath.Join(s.config.Dir, c.ID(), "body.bin"), 0700); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(ObserveBody(WithCapture(context.Background(), c), strings.NewReader("unchanged")))
	if err != nil || string(got) != "unchanged" || !c.snapshot().Body.WriteError {
		t.Fatal("capture failure changed source or was hidden")
	}
	// Remove only the directory created above so retention sees normal files.
	_ = os.Remove(filepath.Join(s.config.Dir, c.ID(), "body.bin"))
	c.Finish(transfer.Stats{}, "completed")
}

type brokenSource struct{}

func (brokenSource) Read(p []byte) (int, error) {
	copy(p, "partial")
	return 7, errors.New("source failure")
}

func TestIncompleteAndEmptyBodiesAreNotInvented(t *testing.T) {
	s := openTestStore(t, Config{})
	c := s.Begin("request-evidence-0008", 8, "")
	_, err := io.ReadAll(ObserveBody(WithCapture(context.Background(), c), brokenSource{}))
	if err == nil || c.snapshot().Body.Complete || c.snapshot().Body.SHA256 != "" {
		t.Fatal("failed source presented as complete")
	}
	empty := s.Begin("request-evidence-0009", 9, "")
	_, _ = io.ReadAll(ObserveBody(WithCapture(context.Background(), empty), strings.NewReader("")))
	if !empty.snapshot().Body.Complete || empty.snapshot().Body.SHA256 != protocol.Sum(nil) {
		t.Fatal("empty source not distinguished from missing capture")
	}
	if data := inspect(t, s, empty.ID()+"/artifacts/body/download", 200, nil); len(data) != 0 {
		t.Fatal("empty body was replaced")
	}
}
