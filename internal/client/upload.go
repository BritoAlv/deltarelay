package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync/atomic"

	"deltarelay/internal/inspection"
	"deltarelay/internal/protocol"
)

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
			if err := c.postJSON(ctx, "/missing", inventory, &missing, sent, requests); err != nil {
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
			c.stateMu.Lock()
			stateID := c.stateID
			c.stateMu.Unlock()
			inspection.FromContext(ctx).Inventory("recovery", stateID, original, missing.Missing)
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
	ctx = inspection.WithChunks(ctx, chunks)
	attempt, err := c.postOnceObserved(ctx, "/chunks", protocol.BatchContentType, batch.Bytes(), &result, sent, requests)
	if err == nil && (result.Chunks != len(chunks) || result.Bytes != expectedBytes) {
		err = errors.New("server chunk acknowledgment does not match uploaded batch")
		inspection.FromContext(ctx).RefineOutcome(attempt, "ack_mismatch")
	}
	if err == nil {
		inspection.FromContext(ctx).AckBatch(attempt)
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
	_, err := c.postOnceObserved(ctx, path, contentType, data, result, sent, requests)
	return err
}

func (c *Client) postOnceObserved(ctx context.Context, path, contentType string, data []byte, result any, sent, requests *atomic.Int64) (int, error) {
	response, err := c.execute(ctx, attemptSpec{
		method:             "POST",
		path:               path,
		contentType:        contentType,
		data:               data,
		compressible:       true,
		cacheSlot:          true,
		userAgent:          "deltarelay",
		acceptedStatus:     acceptedOK,
		responseLimit:      protocol.MaxManifestBytes,
		responseLimitError: errors.New("server response exceeds size limit"),
		transportContext:   "relay request failed",
		sent:               sent,
		requests:           requests,
	})
	if err != nil {
		return -1, err
	}
	err = json.Unmarshal(response.body, result)
	if err != nil {
		inspection.FromContext(ctx).RefineOutcome(response.inspectionIndex, "invalid_response")
	}
	return response.inspectionIndex, err
}
