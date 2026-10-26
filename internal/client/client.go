// Package client chunks local bodies and transfers only missing content.
package client

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"deltarelay/internal/chunker"
	"deltarelay/internal/protocol"
)

type Config struct {
	URL             string
	Token           string
	HTTPClient      *http.Client
	AllowHTTP       bool
	Chunking        chunker.Config
	Workers         int
	BatchBytes      int
	NoCompression   bool
	MaxBodySize     int64
	HeaderTimeout   time.Duration
	RetryWindow     time.Duration
	RetryMin        time.Duration
	RetryMax        time.Duration
	StallTimeout    time.Duration
	NoRetry         bool
	ControlDir      string
	ExpectedStateID string
	// Nil permits initial synchronization. A non-nil value caps missing raw
	// bytes BEFORE upload; zero allows cache hits only. There is no bypass.
	MaxUploadBytes *int64
	TempDir        string
}

type Client struct {
	config     Config
	http       *http.Client
	base       string
	cacheSlots chan struct{}
	stateMu    sync.Mutex
	stateID    string
	control    *controls
}

var ErrUploadBudget = errors.New("upload budget exceeded")
var ErrBodyLimit = errors.New("input exceeds configured body or chunk-count limit")

type Stats struct {
	Hash                 string `json:"hash"`
	BodyBytes            int64  `json:"body_bytes"`
	Chunks               int    `json:"chunks"`
	UniqueChunks         int    `json:"unique_chunks"`
	UploadedChunks       int    `json:"uploaded_chunks"`
	UploadedChunkBytes   int64  `json:"uploaded_chunk_bytes"`
	MissingChunkBytes    int64  `json:"missing_chunk_bytes"`
	ReusedBodyBytes      int64  `json:"reused_body_bytes"`
	RequestBodyBytesSent int64  `json:"request_body_bytes_sent"`
	Requests             int64  `json:"requests"`
	DurationMillis       int64  `json:"duration_ms"`
}

type HTTPError struct {
	Status     int
	Detail     string
	Code       string
	RetryAfter time.Duration
}

// TransportError means the relay could not be reached, or the connection broke
// before a complete HTTP response. MayHaveDispatched is set only for the final
// forwarding request, where the VPS may already have contacted the provider.
type TransportError struct {
	Err               error
	MayHaveDispatched bool
}

func (e *TransportError) Error() string { return e.Err.Error() }
func (e *TransportError) Unwrap() error { return e.Err }

func (e *HTTPError) Error() string {
	return fmt.Sprintf("relay returned HTTP %d: %s", e.Status, e.Detail)
}

func New(config Config) (*Client, error) {
	u, err := url.Parse(config.URL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("server URL must be an HTTP(S) origin without credentials, path, query, or fragment")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
		if u.Scheme != "http" || (!loopback && !config.AllowHTTP) {
			return nil, errors.New("HTTPS required except on loopback; use an SSH tunnel or explicitly allow insecure HTTP")
		}
	}
	if config.Token == "" {
		return nil, errors.New("authentication token is required")
	}
	if config.Chunking == (chunker.Config{}) {
		config.Chunking = chunker.DefaultConfig()
	}
	if err := config.Chunking.Validate(); err != nil {
		return nil, err
	}
	if config.Workers == 0 {
		config.Workers = 4
	}
	if config.Workers < 1 || config.Workers > 32 {
		return nil, errors.New("workers must be between 1 and 32")
	}
	if config.BatchBytes == 0 {
		config.BatchBytes = 256 << 10
	}
	if config.BatchBytes < config.Chunking.Max+protocol.ChunkHeaderSize+protocol.BatchHeaderSize || config.BatchBytes > protocol.MaxUploadBatchBytes {
		return nil, errors.New("batch size must fit a maximum-sized chunk and be at most 16 MiB")
	}
	if config.MaxBodySize == 0 {
		config.MaxBodySize = protocol.DefaultMaxBodySize
	}
	if config.MaxBodySize < 1 || config.MaxBodySize > protocol.DefaultMaxBodySize {
		return nil, errors.New("maximum body size must be between 1 and 256 MiB")
	}
	if config.MaxUploadBytes != nil && *config.MaxUploadBytes < 0 {
		return nil, errors.New("upload budget must be non-negative")
	}
	if config.RetryWindow == 0 {
		config.RetryWindow = time.Hour
	}
	if config.RetryMin == 0 {
		config.RetryMin = time.Second
	}
	if config.RetryMax == 0 {
		config.RetryMax = 30 * time.Second
	}
	if config.StallTimeout == 0 {
		config.StallTimeout = 2 * time.Minute
	}
	if config.RetryWindow < 0 || config.RetryMin <= 0 || config.RetryMax < config.RetryMin || config.StallTimeout <= 0 {
		return nil, errors.New("invalid retry or stall timeouts")
	}
	if config.ExpectedStateID != "" && !protocol.ValidHash(config.ExpectedStateID) {
		return nil, errors.New("invalid expected relay state ID")
	}
	var transport *http.Client
	if config.HTTPClient != nil {
		copy := *config.HTTPClient
		transport = &copy
	} else {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.MaxIdleConns = 32
		t.MaxIdleConnsPerHost = config.Workers + 2
		// Long-lived inference streams must not consume every connection and
		// starve chunk uploads. Cache RPC concurrency is bounded separately.
		t.MaxConnsPerHost = 0
		t.ResponseHeaderTimeout = config.HeaderTimeout
		if t.ResponseHeaderTimeout == 0 {
			t.ResponseHeaderTimeout = 5 * time.Minute
		}
		transport = &http.Client{Transport: t}
	}
	// A redirect must never leak the bearer token or silently change endpoints.
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	c := &Client{config: config, http: transport, base: strings.TrimSuffix(config.URL, "/"), cacheSlots: make(chan struct{}, config.Workers), stateID: config.ExpectedStateID}
	if err := c.openControls(); err != nil {
		return nil, err
	}
	return c, nil
}

type localChunk struct {
	chunk  protocol.Chunk
	offset int64
}

// Sync spools the input to a private temporary file, so memory does not grow
// with conversation size and changes to an input file cannot invalidate chunks
// already hashed. The temporary plaintext spool is removed when Sync returns.
func (c *Client) Sync(ctx context.Context, source io.Reader) (Stats, error) {
	stats, _, err := c.sync(ctx, source, true)
	return stats, err
}

func (c *Client) sync(ctx context.Context, source io.Reader, persist bool) (Stats, protocol.Manifest, error) {
	started := time.Now()
	var stats Stats
	var manifest protocol.Manifest
	var sent, requests atomic.Int64
	finish := func(err error) (Stats, protocol.Manifest, error) {
		stats.RequestBodyBytesSent = sent.Load()
		stats.Requests = requests.Load()
		stats.DurationMillis = time.Since(started).Milliseconds()
		return stats, manifest, err
	}
	spool, err := os.CreateTemp(c.config.TempDir, "deltarelay-spool-*")
	if err != nil {
		return finish(err)
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	// POSIX systems release this spool automatically even if the PC process is
	// killed. Other systems retain the ordinary deferred cleanup fallback.
	_ = os.Remove(spool.Name())
	hash := sha256.New()
	manifest = protocol.Manifest{Version: protocol.Version, Chunks: make([]protocol.Chunk, 0)}
	local := make(map[string]localChunk)
	reader := &contextReader{ctx: ctx, reader: source}
	err = chunker.Split(reader, c.config.Chunking, func(data []byte) error {
		if int64(len(data)) > c.config.MaxBodySize-manifest.Size || len(manifest.Chunks) >= protocol.DefaultMaxChunks {
			return ErrBodyLimit
		}
		chunk := protocol.Chunk{Hash: protocol.Sum(data), Size: int64(len(data))}
		if _, err := spool.Write(data); err != nil {
			return err
		}
		_, _ = hash.Write(data)
		if _, ok := local[chunk.Hash]; !ok {
			local[chunk.Hash] = localChunk{chunk: chunk, offset: manifest.Size}
		}
		manifest.Chunks = append(manifest.Chunks, chunk)
		manifest.Size += chunk.Size
		return nil
	})
	if err != nil {
		return finish(err)
	}
	manifest.Hash = hex.EncodeToString(hash.Sum(nil))
	stats.Hash, stats.BodyBytes = manifest.Hash, manifest.Size
	stats.Chunks, stats.UniqueChunks = len(manifest.Chunks), len(local)
	if err := manifest.Validate(c.config.MaxBodySize, protocol.DefaultMaxChunks); err != nil {
		return finish(err)
	}
	var missing protocol.MissingResponse
	if _, err := c.Info(ctx); err != nil {
		return finish(err)
	}
	if err := c.postJSON(ctx, "/v2/missing", manifest, &missing, &sent, &requests); err != nil {
		return finish(err)
	}
	seen := make(map[string]bool, len(missing.Missing))
	var missingBytes int64
	for _, chunk := range missing.Missing {
		found, ok := local[chunk.Hash]
		if !ok || found.chunk != chunk || seen[chunk.Hash] {
			return finish(errors.New("server requested an unknown, duplicate, or inconsistent chunk"))
		}
		seen[chunk.Hash] = true
		missingBytes += chunk.Size
	}
	stats.MissingChunkBytes = missingBytes
	if c.config.MaxUploadBytes != nil && missingBytes > *c.config.MaxUploadBytes {
		return finish(fmt.Errorf("%w: server needs %d raw chunk bytes, limit is %d; no chunks uploaded", ErrUploadBudget, missingBytes, *c.config.MaxUploadBytes))
	}
	for _, chunk := range manifest.Chunks {
		if !seen[chunk.Hash] {
			stats.ReusedBodyBytes += chunk.Size
		}
	}
	// Batching avoids one network round trip per chunk. Parallel workers reuse
	// pooled HTTP connections; each worker holds at most one bounded batch.
	var batches [][]protocol.Chunk
	batch := make([]protocol.Chunk, 0)
	batchSize := protocol.BatchHeaderSize
	for _, chunk := range missing.Missing {
		frameSize := protocol.ChunkHeaderSize + int(chunk.Size)
		if len(batch) > 0 && (batchSize+frameSize > c.config.BatchBytes || len(batch) >= protocol.MaxUploadBatchCount) {
			batches = append(batches, batch)
			batch = nil
			batchSize = protocol.BatchHeaderSize
		}
		batch = append(batch, chunk)
		batchSize += frameSize
	}
	if len(batch) > 0 {
		batches = append(batches, batch)
	}
	if len(batches) > 0 {
		workCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		var next, uploadedChunks, uploadedBytes atomic.Int64
		var firstErr error
		var once sync.Once
		var workers sync.WaitGroup
		for i := 0; i < min(c.config.Workers, len(batches)); i++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for workCtx.Err() == nil {
					index := int(next.Add(1) - 1)
					if index >= len(batches) {
						return
					}
					result, err := c.upload(workCtx, spool, local, batches[index], &sent, &requests)
					if err != nil {
						once.Do(func() { firstErr = err; cancel() })
						return
					}
					uploadedChunks.Add(int64(result.Chunks))
					uploadedBytes.Add(result.Bytes)
				}
			}()
		}
		workers.Wait()
		stats.UploadedChunks = int(uploadedChunks.Load())
		stats.UploadedChunkBytes = uploadedBytes.Load()
		if firstErr != nil {
			return finish(firstErr)
		}
	}
	if persist {
		var assembled protocol.AssembleResponse
		if err := c.postJSON(ctx, "/v2/assemble", manifest, &assembled, &sent, &requests); err != nil {
			return finish(err)
		}
		if assembled.Hash != manifest.Hash || assembled.Size != manifest.Size {
			return finish(errors.New("server assembly acknowledgment does not match the original body"))
		}
	}
	return finish(nil)
}

func (c *Client) upload(ctx context.Context, spool *os.File, local map[string]localChunk, chunks []protocol.Chunk, sent, requests *atomic.Int64) (protocol.UploadResponse, error) {
	// Re-inventory after an ambiguous batch failure, rather than retransmitting
	// the whole batch. Verified frames can have persisted before a lost ACK.
	original := append([]protocol.Chunk(nil), chunks...)
	var expectedBytes int64
	h := sha256.New()
	for _, chunk := range chunks {
		data := make([]byte, int(chunk.Size))
		if _, err := spool.ReadAt(data, local[chunk.Hash].offset); err != nil {
			return protocol.UploadResponse{}, err
		}
		_, _ = h.Write(data)
		expectedBytes += chunk.Size
	}
	inventory := protocol.Manifest{Version: protocol.Version, Hash: hex.EncodeToString(h.Sum(nil)), Size: expectedBytes, Chunks: original}
	attempted := false
	target := c.config.BatchBytes
	err := c.retry(ctx, func() error {
		if attempted {
			target = max(c.config.Chunking.Max+protocol.ChunkHeaderSize+protocol.BatchHeaderSize, target/2)
			var missing protocol.MissingResponse
			if err := c.postJSON(ctx, "/v2/missing", inventory, &missing, sent, requests); err != nil {
				return err
			}
			allowed := make(map[string]protocol.Chunk, len(original))
			for _, chunk := range original {
				allowed[chunk.Hash] = chunk
			}
			seen := make(map[string]bool)
			for _, chunk := range missing.Missing {
				if allowed[chunk.Hash] != chunk || seen[chunk.Hash] {
					return errors.New("invalid recovery chunk inventory")
				}
				seen[chunk.Hash] = true
			}
			chunks = missing.Missing
		}
		attempted = true
		if len(chunks) == 0 {
			return nil
		}
		for start := 0; start < len(chunks); {
			end, size := start, protocol.BatchHeaderSize
			for end < len(chunks) && (end == start || size+protocol.ChunkHeaderSize+int(chunks[end].Size) <= target) {
				size += protocol.ChunkHeaderSize + int(chunks[end].Size)
				end++
			}
			if _, err := c.uploadOnce(ctx, spool, local, chunks[start:end], sent, requests); err != nil {
				return err
			}
			start = end
		}
		return nil
	})
	return protocol.UploadResponse{Chunks: len(original), Bytes: expectedBytes}, err
}

func (c *Client) uploadOnce(ctx context.Context, spool *os.File, local map[string]localChunk, chunks []protocol.Chunk, sent, requests *atomic.Int64) (protocol.UploadResponse, error) {
	var batch bytes.Buffer
	if err := protocol.WriteBatchHeader(&batch, len(chunks)); err != nil {
		return protocol.UploadResponse{}, err
	}
	var expectedBytes int64
	for _, chunk := range chunks {
		data := make([]byte, int(chunk.Size))
		if _, err := spool.ReadAt(data, local[chunk.Hash].offset); err != nil {
			return protocol.UploadResponse{}, err
		}
		if err := protocol.WriteChunk(&batch, chunk, data); err != nil {
			return protocol.UploadResponse{}, err
		}
		expectedBytes += chunk.Size
	}
	var result protocol.UploadResponse
	err := c.postOnce(ctx, "/v2/chunks", protocol.BatchContentType, batch.Bytes(), &result, sent, requests)
	if err == nil && (result.Chunks != len(chunks) || result.Bytes != expectedBytes) {
		err = errors.New("server chunk acknowledgment does not match uploaded batch")
	}
	return result, err
}

func (c *Client) postJSON(ctx context.Context, path string, value, result any, sent, requests *atomic.Int64) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.post(ctx, path, "application/json", data, result, sent, requests)
}

func (c *Client) post(ctx context.Context, path, contentType string, data []byte, result any, sent, requests *atomic.Int64) error {
	return c.retry(ctx, func() error { return c.postOnce(ctx, path, contentType, data, result, sent, requests) })
}

func (c *Client) postOnce(ctx context.Context, path, contentType string, data []byte, result any, sent, requests *atomic.Int64) error {
	response, err := c.doPost(ctx, path, contentType, data, sent, requests)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return responseError(response)
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, protocol.MaxManifestBytes+1))
	if err != nil {
		return &TransportError{Err: err}
	}
	if len(data) > protocol.MaxManifestBytes {
		return errors.New("server response exceeds size limit")
	}
	return json.Unmarshal(data, result)
}

func (c *Client) doPost(ctx context.Context, path, contentType string, data []byte, sent, requests *atomic.Int64) (*http.Response, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	release := func() {}
	if path != "/v1/forward" {
		select {
		case c.cacheSlots <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		var once sync.Once
		release = func() { once.Do(func() { <-c.cacheSlots }) }
	}
	keepSlot := false
	defer func() {
		if !keepSlot {
			release()
		}
	}()
	compressed := false
	if !c.config.NoCompression {
		var buffer bytes.Buffer
		gz, _ := gzip.NewWriterLevel(&buffer, gzip.BestSpeed)
		if _, err := gz.Write(data); err != nil {
			return nil, err
		}
		if err := gz.Close(); err != nil {
			return nil, err
		}
		if buffer.Len() < len(data) {
			data, compressed = buffer.Bytes(), true
		}
	}
	attemptCtx, cancel, touch := c.attempt(ctx)
	body := &countingReader{reader: bytes.NewReader(data), count: sent, touch: touch}
	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, c.base+path, body)
	if err != nil {
		cancel()
		return nil, err
	}
	req.ContentLength = int64(len(data))
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("User-Agent", "deltarelay/1")
	req.Header.Set("Accept-Encoding", "identity")
	c.addState(req)
	if compressed {
		req.Header.Set("Content-Encoding", "gzip")
	}
	requests.Add(1)
	response, err := c.http.Do(req)
	if err != nil {
		cancel()
		// Do not expose request URLs, transport credentials, or response bodies.
		return nil, &TransportError{Err: fmt.Errorf("relay request failed: %w", err)}
	}
	response.Body = &activityReader{ReadCloser: response.Body, touch: touch}
	response.Body = &releaseBody{ReadCloser: response.Body, release: func() { cancel(); release() }}
	keepSlot = true
	return response, nil
}

type releaseBody struct {
	io.ReadCloser
	release func()
}

func (b *releaseBody) Close() error { defer b.release(); return b.ReadCloser.Close() }

func responseError(response *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	var detail protocol.ErrorResponse
	if json.Unmarshal(data, &detail) != nil || detail.Error == "" {
		detail.Error = http.StatusText(response.StatusCode)
	}
	delay := time.Duration(0)
	if seconds, err := strconv.ParseInt(response.Header.Get("Retry-After"), 10, 64); err == nil && seconds >= 0 && seconds <= 86400 {
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
		delay = max(0, time.Until(at))
	}
	return &HTTPError{Status: response.StatusCode, Detail: detail.Error, Code: detail.Code, RetryAfter: delay}
}

type countingReader struct {
	reader io.Reader
	count  *atomic.Int64
	touch  func()
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.count.Add(int64(n))
	if n > 0 && r.touch != nil {
		r.touch()
	}
	return n, err
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
