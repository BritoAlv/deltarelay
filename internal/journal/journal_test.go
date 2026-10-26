package journal

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"deltarelay/internal/protocol"
)

func TestDurableExclusiveClaimsAndLimit(t *testing.T) {
	directory := t.TempDir()
	j, err := Open(directory, 2)
	if err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := j.Claim("logical-request-id-0001", protocol.Sum([]byte("request")))
			if err == nil {
				accepted.Add(1)
			} else if !errors.Is(err, ErrUsed) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 1 {
		t.Fatal("duplicate ID claimed more than once")
	}
	restarted, err := Open(directory, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Claim("logical-request-id-0001", protocol.Sum([]byte("different body"))); !errors.Is(err, ErrUsed) {
		t.Fatal("restart permitted replay")
	}
	if err := restarted.Claim("logical-request-id-0002", "hash"); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Claim("logical-request-id-0003", "hash"); !errors.Is(err, ErrFull) {
		t.Fatal("journal limit ignored")
	}
}
