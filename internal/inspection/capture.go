package inspection

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"deltarelay/internal/protocol"
	"deltarelay/internal/transfer"
)

type Capture struct {
	mu            sync.Mutex
	store         *Store
	data          Trace
	bodyHash      hash.Hash
	references    int
	revision      uint64
	written       uint64
	metadataBytes int64 // accessed under Store.mu
	evicted       atomic.Bool
}

type contextKey struct{}
type chunksKey struct{}

func WithCapture(ctx context.Context, capture *Capture) context.Context {
	if capture == nil {
		return ctx
	}
	return context.WithValue(ctx, contextKey{}, capture)
}

func FromContext(ctx context.Context) *Capture {
	c, _ := ctx.Value(contextKey{}).(*Capture)
	return c
}

func WithChunks(ctx context.Context, chunks []protocol.Chunk) context.Context {
	return context.WithValue(ctx, chunksKey{}, chunks)
}

func (c *Capture) ID() string {
	if c == nil {
		return ""
	}
	return c.data.ID
}

func (c *Capture) appendArtifact(a *Artifact, data []byte) {
	a.SourceBytes += int64(len(data))
	if a.Truncated || a.WriteError || len(data) == 0 {
		return
	}
	n := c.store.reserve(c.data.ID, int64(len(data)))
	if n < int64(len(data)) {
		a.Truncated = true
	}
	if n == 0 {
		return
	}
	f, err := os.OpenFile(filepath.Join(c.store.config.Dir, c.data.ID, a.ID+".bin"), os.O_CREATE|os.O_WRONLY|os.O_APPEND|syscall.O_NOFOLLOW, 0600)
	if err == nil {
		var written int
		written, err = f.Write(data[:n])
		a.CapturedBytes += int64(written)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		a.WriteError = true
		c.data.StorageError = true
		c.store.failed.Store(true)
	}
}

type bodyReader struct {
	source  io.Reader
	capture *Capture
}

// ObserveBody sees precisely the decoded source bytes read by the chunker,
// including a partial read on failure. A short capture never changes that read.
func ObserveBody(ctx context.Context, source io.Reader) io.Reader {
	c := FromContext(ctx)
	if c == nil {
		return source
	}
	return &bodyReader{source: source, capture: c}
}

func (r *bodyReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	c := r.capture
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bodyHash == nil {
		c.bodyHash = sha256.New()
	}
	_, _ = c.bodyHash.Write(p[:n])
	c.appendArtifact(&c.data.Body, p[:n])
	if err == io.EOF {
		c.data.Body.Complete = true
		c.data.Body.SHA256 = hex.EncodeToString(c.bodyHash.Sum(nil))
	}
	c.revision++
	return n, err
}

func (c *Capture) Chunk(chunk protocol.Chunk, offset int64) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.data.Chunks) >= protocol.DefaultMaxChunks || c.references >= maxReferences {
		c.data.DroppedEvents++
		c.revision++
		return
	}
	c.data.Chunks = append(c.data.Chunks, Chunk{Index: len(c.data.Chunks), Offset: offset, Hash: chunk.Hash, Size: chunk.Size})
	c.references++
	c.revision++
}

// Inventory is called only after the client validates the actual relay reply.
// Recovery observations have their own scope; absent scope members are unknown.
func (c *Capture) Inventory(kind, stateID string, scope, missing []protocol.Chunk) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.data.Inventories) >= maxEvents || c.references+len(scope)+len(missing) > maxReferences {
		c.data.DroppedEvents++
		c.revision++
		return
	}
	c.data.Inventories = append(c.data.Inventories, Inventory{Index: len(c.data.Inventories), Kind: kind, ObservedAt: time.Now().UTC(), StateID: stateID, Scope: append([]protocol.Chunk(nil), scope...), Missing: append([]protocol.Chunk{}, missing...)})
	c.references += len(scope) + len(missing)
	c.revision++
}

func attemptArtifact(index int) string { return "attempt-" + strconv.Itoa(index) }

// BeginAttempt receives the actual chosen (possibly gzipped) bytes. Authenticated
// HTTP headers are never accepted here. The caller's Content-Type is retained as
// a label. Forwarding RPC bodies embed credentials: their exact bytes are
// deliberately NOT stored, only a safe projection.
func (c *Capture) BeginAttempt(ctx context.Context, operation, method, path, contentType, encoding string, decoded, encoded []byte, counted bool) int {
	if c == nil {
		return -1
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	chunks, _ := ctx.Value(chunksKey{}).([]protocol.Chunk)
	if len(c.data.Attempts) >= maxEvents || c.references+len(chunks) > maxReferences {
		c.data.DroppedEvents++
		c.revision++
		return -1
	}
	index := len(c.data.Attempts)
	// Endpoint paths are code-owned protocol paths, never target URLs. Still cut
	// any query string and bound the label so a future caller cannot leak query
	// credentials or an unbounded value into evidence.
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if len(path) > 512 {
		path = ""
	}
	a := Attempt{Index: index, Operation: operation, Method: method, Path: path, StartedAt: time.Now().UTC(), ContentType: contentType, Encoding: encoding, DecodedBytes: int64(len(decoded)), PreparedBytes: int64(len(encoded)), Counted: counted, Outcome: "running", Chunks: append([]protocol.Chunk(nil), chunks...)}
	if encoded != nil {
		// Only protocol operations with a known non-credential payload shape are
		// stored verbatim. Unknown future counted operations retain lengths and
		// outcome but no payload; dispatch keeps only an allowlisted projection.
		payload := encoded
		capturePayload := operation == "inventory" || operation == "chunks" || operation == "assemble" || operation == "dispatch"
		if operation == "dispatch" {
			// Allowlist, rather than attempting to enumerate sensitive header names
			// or URL query parameters. No target/header values reach disk/browser.
			var forward protocol.ForwardRequest
			if json.Unmarshal(decoded, &forward) == nil {
				payload, _ = json.Marshal(struct {
					Version  int               `json:"version"`
					ID       string            `json:"id"`
					Method   string            `json:"method"`
					Manifest protocol.Manifest `json:"manifest"`
					Omitted  string            `json:"omitted"`
				}{forward.Version, forward.ID, forward.Method, forward.Manifest, "Target URL and all forwarded headers omitted. This is not the original upload payload."})
			} else {
				payload = []byte(`{"omitted":"Credential-bearing dispatch payload not retained."}`)
			}
		}
		if capturePayload {
			artifact := &Artifact{ID: attemptArtifact(index), Representation: "captured", ContentType: contentType, Encoding: encoding, Complete: true}
			if operation == "dispatch" {
				artifact.Representation, artifact.Encoding = "redacted", "identity"
			}
			c.appendArtifact(artifact, payload)
			artifact.SHA256 = protocol.Sum(payload)
			a.Payload = artifact
		}
	}
	c.data.Attempts = append(c.data.Attempts, a)
	c.references += len(chunks)
	c.revision++
	return index
}

func (c *Capture) Consume(index int, n int) {
	if c == nil || index < 0 || n <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data.Attempts[index].ConsumedBytes += int64(n)
	c.revision++
}

// RefineOutcome changes a successful HTTP-attempt outcome only when its response
// body or acknowledgment could not be used. It never upgrades a failed attempt.
func (c *Capture) RefineOutcome(index int, outcome string) {
	if c == nil || index < 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if index < len(c.data.Attempts) && c.data.Attempts[index].Outcome == "response_ok" {
		c.data.Attempts[index].Outcome = outcome
		c.revision++
	}
}

func (c *Capture) EndAttempt(index, status int, outcome string) {
	if c == nil || index < 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now().UTC()
	a := &c.data.Attempts[index]
	a.FinishedAt, a.Status, a.Outcome = &now, status, outcome
	c.revision++
}

// AckBatch marks only the successful HTTP attempt whose decoded acknowledgment
// passed the existing chunk-count/byte-count checks. An HTTP 200 alone is not it.
func (c *Capture) AckBatch(index int) {
	if c == nil || index < 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if index < len(c.data.Attempts) {
		c.data.Attempts[index].AcknowledgmentOK = true
		c.revision++
	}
}

func (c *Capture) Finish(stats transfer.Stats, state string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	now := time.Now().UTC()
	c.data.Transfer, c.data.State, c.data.FinishedAt = stats, state, &now
	c.revision++
	c.mu.Unlock()
	c.store.mu.Lock()
	if e := c.store.entries[c.data.ID]; e != nil {
		e.active = false
	}
	c.store.mu.Unlock()
}

func (c *Capture) snapshot() Trace {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.data
	t.Chunks = append([]Chunk{}, t.Chunks...)
	t.Inventories = append([]Inventory{}, t.Inventories...)
	t.Attempts = append([]Attempt{}, t.Attempts...)
	for i := range t.Attempts {
		if p := t.Attempts[i].Payload; p != nil {
			copy := *p
			t.Attempts[i].Payload = &copy
		}
	}
	return t
}
