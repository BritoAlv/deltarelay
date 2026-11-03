package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"deltarelay/internal/chunker"
	"deltarelay/internal/protocol"
)

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
