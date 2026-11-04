package inspection

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"deltarelay/internal/protocol"
)

// ValidRoute is shared with the credential-bearing dashboard proxy. It accepts
// only inspection operations and bounded, endpoint-specific query parameters.
func ValidRoute(suffix string, query url.Values) bool {
	p := strings.Split(suffix, "/")
	if len(p) == 0 || !validID(p[0]) {
		return false
	}
	allowed := map[string]int{}
	switch {
	case len(p) == 1:
	case len(p) == 2 && p[1] == "chunks":
		allowed = map[string]int{"start": protocol.DefaultMaxChunks, "limit": 256, "inventory": maxEvents - 1}
	case len(p) == 3 && p[1] == "attempts":
		if !decimal(p[2], maxEvents-1) {
			return false
		}
	case (len(p) == 3 || len(p) == 4 && p[3] == "download") && p[1] == "artifacts":
		if p[2] != "body" && !(strings.HasPrefix(p[2], "attempt-") && decimal(strings.TrimPrefix(p[2], "attempt-"), maxEvents-1)) {
			return false
		}
		allowed = map[string]int{"decode": 1}
		if len(p) == 3 {
			allowed["offset"], allowed["limit"] = 1<<30, 65536
		}
	default:
		return false
	}
	for key, values := range query {
		max, ok := allowed[key]
		if !ok || len(values) != 1 || !decimal(values[0], max) {
			return false
		}
	}
	return true
}

func decimal(s string, max int) bool {
	if s == "" || len(s) > 10 || len(s) > 1 && s[0] == '0' {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && n <= uint64(max)
}

func number(q url.Values, key string, fallback int) int {
	if q.Get(key) == "" {
		return fallback
	}
	n, _ := strconv.Atoi(q.Get(key))
	return n
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func unavailable(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

type ChunkView struct {
	Chunk
	Availability string `json:"availability"`
	Occurrences  int    `json:"occurrences"`
}

func chunkPage(t Trace, start, limit, inventory int) any {
	scope, missing, occurrences := map[string]bool{}, map[string]bool{}, map[string]int{}
	for _, c := range t.Chunks {
		occurrences[c.Hash]++
	}
	var observed *Inventory
	if inventory >= 0 && inventory < len(t.Inventories) {
		observed = &t.Inventories[inventory]
		for _, c := range observed.Scope {
			scope[c.Hash] = true
		}
		for _, c := range observed.Missing {
			missing[c.Hash] = true
		}
	}
	chunks := []ChunkView{}
	for _, c := range t.Chunks[min(start, len(t.Chunks)):min(start+limit, len(t.Chunks))] {
		availability := "unknown"
		if observed != nil && (observed.Kind == "initial" || scope[c.Hash]) {
			availability = "present"
			if missing[c.Hash] {
				availability = "missing"
			}
		}
		chunks = append(chunks, ChunkView{Chunk: c, Availability: availability, Occurrences: occurrences[c.Hash]})
	}
	return struct {
		Start     int         `json:"start"`
		Total     int         `json:"total"`
		Inventory int         `json:"inventory"`
		Chunks    []ChunkView `json:"chunks"`
	}{start, len(t.Chunks), inventory, chunks}
}

// ServeHTTP is mounted only behind gateway authentication. Captures do not
// initiate relay calls and paths never name arbitrary files on either server.
func (s *Store) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s == nil {
		unavailable(w, http.StatusNotFound, "capture_disabled")
		return
	}
	suffix := strings.TrimPrefix(r.URL.Path, "/inspection/")
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || !ValidRoute(suffix, q) {
		unavailable(w, http.StatusBadRequest, "invalid_inspection_route")
		return
	}
	p := strings.Split(suffix, "/")
	c, ok := s.get(p[0])
	if !ok {
		unavailable(w, http.StatusNotFound, "capture_not_retained")
		return
	}
	t := c.snapshot()
	if len(p) == 1 {
		writeJSON(w, t.Detail())
		return
	}
	if p[1] == "chunks" {
		inventory := number(q, "inventory", -1)
		if q.Get("inventory") == "" && len(t.Inventories) > 0 {
			inventory = 0
		}
		if inventory >= len(t.Inventories) {
			unavailable(w, http.StatusNotFound, "inventory_not_captured")
			return
		}
		writeJSON(w, chunkPage(t, number(q, "start", 0), max(1, number(q, "limit", 128)), inventory))
		return
	}
	if p[1] == "attempts" {
		index, _ := strconv.Atoi(p[2])
		if index >= len(t.Attempts) {
			unavailable(w, http.StatusNotFound, "attempt_not_captured")
			return
		}
		writeJSON(w, t.Attempts[index])
		return
	}
	var artifact *Artifact
	var decodedSize int64
	if p[2] == "body" {
		artifact, decodedSize = &t.Body, t.Body.SourceBytes
	} else {
		index, _ := strconv.Atoi(strings.TrimPrefix(p[2], "attempt-"))
		if index < len(t.Attempts) {
			artifact, decodedSize = t.Attempts[index].Payload, t.Attempts[index].DecodedBytes
		}
	}
	if artifact == nil {
		unavailable(w, http.StatusNotFound, "artifact_not_captured")
		return
	}
	offset, limit := int64(0), int64(0)
	if len(p) == 3 {
		offset, limit = int64(number(q, "offset", 0)), int64(max(1, number(q, "limit", 4096)))
	}
	reader, closeReader, total, err := s.artifactReader(t.ID, *artifact, q.Get("decode") == "1", decodedSize, offset)
	if err != nil {
		if errors.Is(err, errOffsetOutOfRange) {
			unavailable(w, http.StatusRequestedRangeNotSatisfiable, "offset_out_of_range")
		} else {
			unavailable(w, http.StatusConflict, "artifact_unavailable_or_incomplete")
		}
		return
	}
	defer closeReader()
	if len(p) == 4 {
		// Always an inert attachment, never active HTML or a guessed MIME type.
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="deltarelay-`+t.ID+`-`+artifact.ID+`.bin"`)
		w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
		_, _ = io.CopyN(w, reader, total)
		return
	}
	data, err := io.ReadAll(io.LimitReader(reader, min(limit, total-offset)))
	if err != nil || int64(len(data)) != min(limit, total-offset) {
		unavailable(w, http.StatusConflict, "artifact_read_failed")
		return
	}
	writeJSON(w, struct {
		Offset   int64    `json:"offset"`
		Total    int64    `json:"total"`
		Data     string   `json:"data"`
		Decoded  bool     `json:"decoded"`
		Artifact Artifact `json:"artifact"`
	}{offset, total, base64.StdEncoding.EncodeToString(data), q.Get("decode") == "1" && artifact.Encoding == "gzip", *artifact})
}

var errOffsetOutOfRange = errors.New("inspection offset out of range")

func (s *Store) artifactReader(id string, a Artifact, decode bool, decodedSize, offset int64) (io.Reader, func(), int64, error) {
	if a.CapturedBytes == 0 {
		if offset > 0 {
			return nil, nil, 0, errOffsetOutOfRange
		}
		return strings.NewReader(""), func() {}, 0, nil
	}
	f, err := privateFile(filepath.Join(s.config.Dir, id, a.ID+".bin"), 1<<30)
	if err != nil {
		return nil, nil, 0, err
	}
	closeReader := func() { _ = f.Close() }
	info, err := f.Stat()
	if err != nil || info.Size() < a.CapturedBytes {
		closeReader()
		return nil, nil, 0, errors.New("short inspection artifact")
	}
	var reader io.Reader
	total := a.CapturedBytes
	if decode && a.Encoding == "gzip" {
		if a.Truncated || a.WriteError || a.CapturedBytes != a.SourceBytes || !a.Complete || decodedSize < 0 || decodedSize > protocol.MaxUploadBatchBytes {
			closeReader()
			return nil, nil, 0, errors.New("incomplete compressed artifact")
		}
		gz, err := gzip.NewReader(io.LimitReader(f, a.CapturedBytes))
		if err != nil {
			closeReader()
			return nil, nil, 0, err
		}
		reader, total = io.LimitReader(gz, decodedSize), decodedSize
		closeReader = func() { _ = gz.Close(); _ = f.Close() }
	} else {
		if offset > total {
			closeReader()
			return nil, nil, 0, errOffsetOutOfRange
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			closeReader()
			return nil, nil, 0, err
		}
		reader = io.LimitReader(f, total-offset)
	}
	if offset > total {
		closeReader()
		return nil, nil, 0, errOffsetOutOfRange
	}
	if decode && a.Encoding == "gzip" && offset > 0 {
		if _, err := io.CopyN(io.Discard, reader, offset); err != nil {
			closeReader()
			return nil, nil, 0, err
		}
	}
	return reader, closeReader, total, nil
}
