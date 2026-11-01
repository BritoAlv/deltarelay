package mailbox

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"deltarelay/internal/protocol"
)

func TestAckAndExpiryTombstonesSurviveRestart(t *testing.T) {
	for _, release := range []string{"ack", "expiry"} {
		t.Run(release, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "mailbox")
			config := Config{MaxRecords: 1}
			m := open(t, directory, config)
			const id = "released-response-request-0001"
			start(t, m, id)
			payload := []byte("data: durable response\n\n")
			if err := m.Append(id, payload); err != nil {
				t.Fatal(err)
			}
			if err := m.Finish(id, protocol.Completed, "", protocol.Sum(payload)); err != nil {
				t.Fatal(err)
			}
			if release == "ack" {
				if _, err := m.Ack(id, protocol.Receipt{Size: int64(len(payload)), Hash: protocol.Sum(payload)}); err != nil {
					t.Fatal(err)
				}
			} else {
				// Advance this record's deadline instead of sleeping or changing a global clock.
				m.entries[id].record.Expires = time.Now().Add(-time.Second).Unix()
				if err := m.Sweep(); err != nil {
					t.Fatal(err)
				}
			}
			identity := m.StateID()
			m.Close()
			restarted := open(t, directory, config)
			record, _, err := restarted.Lookup(id)
			if err != nil || restarted.StateID() != identity || restarted.Usage() != 0 ||
				release == "ack" && !record.Acknowledged || release == "expiry" && !record.Expired {
				t.Fatalf("release lost on restart: %+v %v", record, err)
			}
			if _, _, _, err := restarted.Read(id, 0); !errors.Is(err, ErrGone) {
				t.Fatalf("released payload became readable again: %v", err)
			}
			claim := func() error { t.Fatal("released request was claimed again"); return nil }
			if _, created, err := restarted.Accept(id, "fingerprint", "body", claim); err != nil || created {
				t.Fatalf("duplicate lost its tombstone: created=%t %v", created, err)
			}
			if _, _, err := restarted.Accept(id, "different-fingerprint", "body", claim); !errors.Is(err, ErrConflict) {
				t.Fatalf("changed content escaped tombstone: %v", err)
			}
			if _, _, err := restarted.Accept("another-request-0002", "fingerprint", "body", claim); !errors.Is(err, ErrFull) {
				t.Fatalf("payload release unexpectedly freed a tombstone record: %v", err)
			}
		})
	}
}
