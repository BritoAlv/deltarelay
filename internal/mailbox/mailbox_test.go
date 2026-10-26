package mailbox

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"deltarelay/internal/protocol"
)

func open(t *testing.T, dir string, config Config) *Mailbox {
	t.Helper()
	m, err := Open(dir, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func start(t *testing.T, m *Mailbox, id string) {
	t.Helper()
	_, created, err := m.Accept(id, "fingerprint", "body", func() error { return nil })
	if err != nil || !created {
		t.Fatalf("accept: %v %v", created, err)
	}
	if _, started, err := m.Start(id, context.Background(), time.Hour); err != nil || !started {
		t.Fatalf("start: %v %v", started, err)
	}
	if err := m.SetHeaders(id, 200, http.Header{"Content-Type": []string{"text/event-stream"}}); err != nil {
		t.Fatal(err)
	}
}

func TestDurableFramesRestartAckAndTombstones(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "mailbox")
	m := open(t, dir, Config{})
	id := "durable-request-0001"
	start(t, m, id)
	payload := []byte("data: first\n\ndata: second\n\n")
	if err := m.Append(id, payload[:8]); err != nil {
		t.Fatal(err)
	}
	if err := m.Append(id, payload[8:]); err != nil {
		t.Fatal(err)
	}
	if err := m.Finish(id, protocol.Completed, "", protocol.Sum(payload)); err != nil {
		t.Fatal(err)
	}
	identity := m.StateID()
	m.Close()
	restarted := open(t, dir, Config{})
	if restarted.StateID() != identity {
		t.Fatal("persistent identity changed")
	}
	r, data, _, err := restarted.Read(id, 5)
	if err != nil || !bytes.Equal(data, payload[5:]) || r.Hash != protocol.Sum(payload) {
		t.Fatalf("resume: %s %v", data, err)
	}
	if _, err := restarted.Ack(id, protocol.Receipt{Size: int64(len(payload)), Hash: protocol.Sum([]byte("wrong"))}); !errors.Is(err, ErrConflict) {
		t.Fatal("incorrect receipt accepted")
	}
	for i := 0; i < 2; i++ {
		if _, err := restarted.Ack(id, protocol.Receipt{Size: int64(len(payload)), Hash: protocol.Sum(payload)}); err != nil {
			t.Fatal(err)
		}
	}
	if restarted.Usage() != 0 {
		t.Fatal("ACK did not reclaim payload storage")
	}
	if _, _, _, err := restarted.Read(id, 0); !errors.Is(err, ErrGone) {
		t.Fatal("acknowledged response not gone")
	}
	called := false
	r, created, err := restarted.Accept(id, "fingerprint", "body", func() error { called = true; return nil })
	if err != nil || created || called || !r.Acknowledged {
		t.Fatal("ACK lost dispatch protection")
	}
}

func TestCrashRecoveryTruncatesOnlyUncommittedTail(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "mailbox")
	m := open(t, dir, Config{})
	id := "crashed-request-0001"
	start(t, m, id)
	if err := m.Append(id, []byte("durable prefix")); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(m.payload(id), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("uncommitted tail"))
	f.Close()
	m.Close()
	restarted := open(t, dir, Config{})
	r, data, _, err := restarted.Read(id, 0)
	if err != nil || string(data) != "durable prefix" || r.State != protocol.Interrupted || r.ErrorCode != "server_restarted_dispatch_unknown" {
		t.Fatalf("unsafe crash recovery: %+v %s %v", r, data, err)
	}
	info, _ := os.Stat(restarted.payload(id))
	if info.Size() != int64(frameHeader+len(data)) {
		t.Fatal("uncommitted tail not truncated")
	}
}

func TestCorruptionFailsClosed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "mailbox")
	m := open(t, dir, Config{})
	id := "corrupt-request-0001"
	start(t, m, id)
	_ = m.Append(id, []byte("exact original"))
	f, err := os.OpenFile(m.payload(id), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteAt([]byte("X"), frameHeader)
	f.Close()
	if _, _, _, err := m.Read(id, 0); !errors.Is(err, ErrIntegrity) {
		t.Fatal("corrupt frame delivered")
	}
	m.Close()
	if _, err := Open(dir, Config{}); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("corrupt saved data not rejected at startup: %v", err)
	}
}

func TestCapacityExpiryAndCancellationBeforeSubmission(t *testing.T) {
	m := open(t, filepath.Join(t.TempDir(), "mailbox"), Config{MaxBytes: frameHeader + 5, MaxResponseBytes: 5})
	id := "capacity-request-0001"
	start(t, m, id)
	if err := m.Append(id, []byte("12345")); err != nil {
		t.Fatal(err)
	}
	if err := m.Append(id, []byte("6")); !errors.Is(err, ErrFull) {
		t.Fatal("response limit ignored")
	}
	_, _, err := m.Accept("another-request-0002", "fp", "body", func() error { t.Fatal("claimed before capacity check"); return nil })
	if !errors.Is(err, ErrFull) {
		t.Fatal("full storage accepted new work")
	}
	_ = m.Finish(id, protocol.Completed, "", protocol.Sum([]byte("12345")))
	m.entries[id].record.Expires = time.Now().Add(-time.Second).Unix()
	if err := m.Sweep(); err != nil {
		t.Fatal(err)
	}
	if m.Usage() != 0 {
		t.Fatal("expired payload was not reclaimed")
	}
	r, _, err := m.Lookup(id)
	if err != nil || !r.Expired {
		t.Fatal("expiry not explicit")
	}
	if _, _, _, err := m.Read(id, 0); !errors.Is(err, ErrGone) {
		t.Fatal("expired bytes delivered")
	}
	cancelID := "cancel-before-submit-0001"
	if _, err := m.Cancel(cancelID, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.Accept(cancelID, "late submit", "body", func() error { t.Fatal("late cancelled dispatch claimed"); return nil }); !errors.Is(err, ErrConflict) {
		t.Fatal("late submission bypassed cancellation tombstone")
	}
}
