package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

	"deltarelay/internal/protocol"
)

type downloadCheckpoint struct{ Kind, Key, Output, StateID string }
type download struct {
	file             *os.File
	metadata, output string
	digest           hash.Hash
	offset           int64
}

func (c *Client) openDownload(ctx context.Context, kind, key, output string) (*download, error) {
	absolute, err := filepath.Abs(output)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(absolute); err == nil {
		return nil, errors.New("download destination already exists; refusing to overwrite")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if _, err := c.Info(ctx); err != nil {
		return nil, err
	}
	c.stateMu.Lock()
	stateID := c.stateID
	c.stateMu.Unlock()
	part := filepath.Join(filepath.Dir(absolute), ".deltarelay-"+protocol.Sum([]byte(absolute+"\x00"+kind+"\x00"+key))+".part")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			f.Close()
		}
	}()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.New("another process owns this partial download")
	}
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > c.config.MaxBodySize {
		return nil, errors.New("invalid, non-private or oversized partial download")
	}
	checkpoint := downloadCheckpoint{Kind: kind, Key: key, Output: absolute, StateID: stateID}
	metadata := part + ".json"
	if data, err := privateRead(metadata, 8192); err == nil {
		var saved downloadCheckpoint
		if json.Unmarshal(data, &saved) != nil || saved != checkpoint {
			return nil, errors.New("partial download checkpoint does not match destination, request or relay identity")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else {
		if info.Size() != 0 {
			return nil, errors.New("nonempty partial download has no checkpoint; refusing to reuse it")
		}
		if err := f.Sync(); err != nil {
			return nil, err
		}
		if err := atomicJSON(metadata, checkpoint); err != nil {
			return nil, err
		}
	}
	digest := sha256.New()
	n, err := io.Copy(digest, f)
	if err != nil {
		return nil, err
	}
	ok = true
	return &download{file: f, metadata: metadata, output: absolute, digest: digest, offset: n}, nil
}

func (d *download) publish(size int64, hash string) error {
	if d.offset != size || hex.EncodeToString(d.digest.Sum(nil)) != hash {
		return errors.New("download length or SHA-256 verification failed; partial checkpoint retained")
	}
	if err := d.file.Sync(); err != nil {
		return err
	}
	// Linking atomically publishes without ever replacing an existing user file.
	if err := os.Link(d.file.Name(), d.output); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(d.output)); err != nil {
		return err
	}
	if err := os.Remove(d.file.Name()); err != nil {
		return err
	}
	if err := os.Remove(d.metadata); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(d.output))
}

// Fetch uses bounded HTTP byte ranges and private persistent checkpoints. A
// failed segment is retried, not the entire file. Existing outputs are sacred.
func (c *Client) Fetch(ctx context.Context, hash, output string) error {
	if !protocol.ValidHash(hash) {
		return errors.New("invalid body SHA-256")
	}
	d, err := c.openDownload(ctx, "body", hash, output)
	if err != nil {
		return err
	}
	defer d.file.Close()
	defer d.file.Sync()
	var head attemptResponse
	err = c.retry(ctx, func() error {
		var err error
		head, err = c.rpc(ctx, http.MethodHead, "/v2/bodies/"+hash, nil, nil, 0, nil, nil)
		return err
	})
	if err != nil {
		return err
	}
	size, err := strconv.ParseInt(head.header.Get("X-DeltaRelay-Body-Size"), 10, 64)
	if err != nil || size < d.offset || size > c.config.MaxBodySize || head.header.Get("ETag") != "\""+hash+"\"" {
		return errors.New("invalid download size or ETag")
	}
	for d.offset < size {
		end := min(size, d.offset+protocol.ResponseSegmentBytes) - 1
		headers := http.Header{"Range": []string{fmt.Sprintf("bytes=%d-%d", d.offset, end)}, "If-Range": []string{"\"" + hash + "\""}}
		var response attemptResponse
		err := c.retry(ctx, func() error {
			var err error
			response, err = c.rpc(ctx, http.MethodGet, "/v2/bodies/"+hash, nil, headers, protocol.ResponseSegmentBytes, nil, nil)
			return err
		})
		if err != nil {
			return err
		}
		expectedRange := fmt.Sprintf("bytes %d-%d/%d", d.offset, end, size)
		if response.status != 206 || response.header.Get("Content-Range") != expectedRange || response.header.Get("ETag") != "\""+hash+"\"" || int64(len(response.body)) != end-d.offset+1 {
			return errors.New("relay returned an invalid range or changed representation")
		}
		if _, err := d.file.Write(response.body); err != nil {
			return err
		}
		_, _ = d.digest.Write(response.body)
		d.offset += int64(len(response.body))
		if err := d.file.Sync(); err != nil {
			return err
		}
	}
	return d.publish(size, hash)
}

// FetchResponse exports the original provider payload (possibly raw SSE) to a
// verified durable file. Retrieval interruption never cancels generation.
// With acknowledge=true, ACK occurs only after local fsync and publication.
func (c *Client) FetchResponse(ctx context.Context, id, output string, acknowledge bool) (protocol.Receipt, error) {
	if !protocol.ValidRequestID(id) {
		return protocol.Receipt{}, errors.New("invalid request ID")
	}
	d, err := c.openDownload(ctx, "response", id, output)
	if err != nil {
		return protocol.Receipt{}, err
	}
	defer d.file.Close()
	defer d.file.Sync()
	response, err := c.resume(ctx, id, "", d.offset, d.digest, false)
	if err != nil {
		return protocol.Receipt{}, err
	}
	defer response.Body.Close()
	n, err := io.Copy(d.file, io.LimitReader(response.Body, c.config.MaxBodySize-d.offset+1))
	d.offset += n
	if err != nil {
		return protocol.Receipt{}, err
	}
	if d.offset > c.config.MaxBodySize {
		return protocol.Receipt{}, errors.New("response download exceeds configured size limit")
	}
	// LimitReader must not hide the explicit terminal state/checksum validation.
	var extra [1]byte
	if _, err := response.Body.Read(extra[:]); err != io.EOF {
		return protocol.Receipt{}, errors.New("response has not completed successfully")
	}
	receipt := protocol.Receipt{Size: d.offset, Hash: hex.EncodeToString(d.digest.Sum(nil))}
	if err := d.publish(receipt.Size, receipt.Hash); err != nil {
		return receipt, err
	}
	if acknowledge {
		if err := c.Ack(ctx, id, receipt); err != nil {
			return receipt, fmt.Errorf("response saved locally, but remote ACK failed (use request ack): %w", err)
		}
	}
	return receipt, nil
}
