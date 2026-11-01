package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"deltarelay/internal/protocol"
)

type pendingCancel struct {
	ID      string `json:"id"`
	StateID string `json:"state_id"`
}
type controls struct {
	mu        sync.Mutex
	pending   map[string]pendingCancel
	lastError string
	ctx       context.Context
	cancel    context.CancelFunc
	wake      chan struct{}
	once      sync.Once
	wg        sync.WaitGroup
	closed    bool
}

func privateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("local state directory must be private (0700), not a symlink")
	}
	return nil
}

func privateRead(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > limit {
		return nil, errors.New("local checkpoint must be a small private regular file")
	}
	return io.ReadAll(io.LimitReader(f, limit+1))
}

func atomicJSON(path string, value any) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".pending-*")
	if err != nil {
		return err
	}
	defer f.Close()
	defer os.Remove(f.Name())
	if err := json.NewEncoder(f).Encode(value); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (c *Client) openControls() error {
	ctx, cancel := context.WithCancel(context.Background())
	c.control = &controls{ctx: ctx, cancel: cancel, pending: make(map[string]pendingCancel), wake: make(chan struct{}, 1)}
	if c.config.ControlDir == "" {
		return nil
	}
	if err := privateDir(c.config.ControlDir); err != nil {
		cancel()
		return err
	}
	data, err := privateRead(filepath.Join(c.config.ControlDir, "relay-state.json"), 4096)
	if err == nil {
		var id string
		if json.Unmarshal(data, &id) != nil || !protocol.ValidHash(id) {
			cancel()
			return errors.New("invalid saved relay identity")
		}
		if c.stateID != "" && c.stateID != id {
			cancel()
			return errors.New("expected relay identity conflicts with saved identity")
		}
		c.stateID = id
	} else if !errors.Is(err, os.ErrNotExist) {
		cancel()
		return err
	}
	files, err := os.ReadDir(c.config.ControlDir)
	if err != nil {
		cancel()
		return err
	}
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".cancel.json") {
			continue
		}
		data, err := privateRead(filepath.Join(c.config.ControlDir, f.Name()), 4096)
		if err != nil {
			cancel()
			return err
		}
		var op pendingCancel
		if json.Unmarshal(data, &op) != nil || !protocol.ValidRequestID(op.ID) || !protocol.ValidHash(op.StateID) || protocol.Sum([]byte(op.ID))+".cancel.json" != f.Name() {
			cancel()
			return errors.New("invalid pending cancellation checkpoint")
		}
		c.control.pending[op.ID] = op
	}
	if len(c.control.pending) > 1024 {
		cancel()
		return errors.New("pending cancellation queue exceeds 1024 records")
	}
	c.startControls()
	return nil
}

func (c *Client) savePin(id string) error {
	if c.config.ControlDir == "" {
		return nil
	}
	// Multiple local clients can share this directory, but cannot race to pin it
	// to different servers. flock is released automatically on a process crash.
	f, err := os.OpenFile(filepath.Join(c.config.ControlDir, "identity.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	path := filepath.Join(c.config.ControlDir, "relay-state.json")
	if data, err := privateRead(path, 4096); err == nil {
		var saved string
		if json.Unmarshal(data, &saved) != nil || saved != id {
			return errors.New("saved relay state identity differs; explicit migration required")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return atomicJSON(path, id)
}

// QueueCancel durably records an explicit cancellation before attempting it.
// A network disconnect alone must never call this method.
func (c *Client) QueueCancel(id string) error {
	if !protocol.ValidRequestID(id) {
		return errors.New("invalid request ID")
	}
	c.stateMu.Lock()
	stateID := c.stateID
	c.stateMu.Unlock()
	if stateID == "" {
		return errors.New("cannot queue cancellation without a pinned relay identity")
	}
	ctl := c.control
	ctl.mu.Lock()
	defer ctl.mu.Unlock()
	if ctl.closed {
		return errors.New("client is closed")
	}
	if len(ctl.pending) >= 1024 {
		ctl.lastError = "cancel_queue_full"
		return errors.New("pending cancellation queue is full")
	}
	op := pendingCancel{ID: id, StateID: stateID}
	if c.config.ControlDir != "" {
		if err := atomicJSON(filepath.Join(c.config.ControlDir, protocol.Sum([]byte(id))+".cancel.json"), op); err != nil {
			ctl.lastError = "cancel_queue_persistence_failed"
			return err
		}
	}
	ctl.pending[id] = op
	c.startControls()
	select {
	case ctl.wake <- struct{}{}:
	default:
	}
	return nil
}

func (c *Client) startControls() {
	c.control.once.Do(func() { c.control.wg.Add(1); go c.controlLoop() })
}

func (c *Client) controlLoop() {
	ctl := c.control
	defer ctl.wg.Done()
	delay := c.config.RetryMin
	for {
		// Another command can enqueue cancellation while the gateway is running.
		// Re-scan this small bounded outbox, including when it was initially empty.
		if c.config.ControlDir != "" {
			files, err := os.ReadDir(c.config.ControlDir)
			if err == nil {
				ctl.mu.Lock()
				for _, f := range files {
					if !strings.HasSuffix(f.Name(), ".cancel.json") {
						continue
					}
					data, err := privateRead(filepath.Join(c.config.ControlDir, f.Name()), 4096)
					var op pendingCancel
					if err != nil || json.Unmarshal(data, &op) != nil || !protocol.ValidRequestID(op.ID) || !protocol.ValidHash(op.StateID) || protocol.Sum([]byte(op.ID))+".cancel.json" != f.Name() {
						if !errors.Is(err, os.ErrNotExist) {
							ctl.lastError = "invalid_cancellation_checkpoint"
						}
						continue
					}
					if len(ctl.pending) < 1024 {
						ctl.pending[op.ID] = op
					}
				}
				ctl.mu.Unlock()
			}
		}
		ctl.mu.Lock()
		ops := make([]pendingCancel, 0, len(ctl.pending))
		for _, op := range ctl.pending {
			ops = append(ops, op)
		}
		ctl.mu.Unlock()
		for _, op := range ops {
			if ctl.ctx.Err() != nil {
				return
			}
			headers := http.Header{"X-Deltarelay-State-Id": []string{op.StateID}}
			// Never let addState replace an old queued operation's identity with a
			// replacement server's identity. A changed state must fail closed.
			c.stateMu.Lock()
			current := c.stateID
			c.stateMu.Unlock()
			var err error
			if current != op.StateID {
				err = errors.New("queued cancellation belongs to another relay")
			} else {
				_, _, err = c.rpc(ctl.ctx, http.MethodPost, "/v2/requests/"+op.ID+"/cancel", nil, headers, protocol.MaxManifestBytes, nil, nil)
			}
			ctl.mu.Lock()
			if err == nil {
				if c.config.ControlDir != "" {
					err = os.Remove(filepath.Join(c.config.ControlDir, protocol.Sum([]byte(op.ID))+".cancel.json"))
					if errors.Is(err, os.ErrNotExist) {
						err = nil
					}
					if err == nil {
						err = syncDirectory(c.config.ControlDir)
					}
				}
				if err == nil {
					delete(ctl.pending, op.ID)
					ctl.lastError = ""
					delay = c.config.RetryMin
				}
			}
			if err != nil {
				ctl.lastError = "remote_cancellation_pending"
			}
			ctl.mu.Unlock()
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctl.ctx.Done():
			timer.Stop()
			return
		case <-ctl.wake:
			timer.Stop()
		case <-timer.C:
		}
		delay = min(c.config.RetryMax, delay*2)
	}
}

func (c *Client) ControlStatus() (int, string) {
	c.control.mu.Lock()
	defer c.control.mu.Unlock()
	return len(c.control.pending), c.control.lastError
}

// Close leaves persisted cancellations queued for the next gateway start.
func (c *Client) Close() {
	c.control.mu.Lock()
	c.control.closed = true
	c.control.cancel()
	c.control.mu.Unlock()
	c.control.wg.Wait()
	c.http.CloseIdleConnections()
}
