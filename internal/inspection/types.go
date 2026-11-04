// Package inspection records private application-payload evidence. It is
// deliberately separate from metadata-only telemetry and from durable dispatch.
package inspection

import (
	"time"

	"deltarelay/internal/protocol"
	"deltarelay/internal/transfer"
)

const (
	DefaultMaxBytes        = 512 << 20
	DefaultMaxCaptureBytes = 64 << 20
	DefaultMaxCaptures     = 100
	DefaultMaxAge          = 24 * time.Hour
	maxMetadataBytes       = 32 << 20
	maxEvents              = 256
	maxReferences          = 131072
)

type Config struct {
	Dir             string
	MaxBytes        int64
	MaxCaptureBytes int64
	MaxCaptures     int
	MaxAge          time.Duration
}

type Status struct {
	Enabled         bool  `json:"enabled"`
	MaxBytes        int64 `json:"max_bytes"`
	MaxCaptureBytes int64 `json:"max_capture_bytes"`
	MaxCaptures     int   `json:"max_captures"`
	MaxAgeSeconds   int64 `json:"max_age_seconds"`
	Captures        int   `json:"captures"`
	UsedBytes       int64 `json:"used_bytes"`
	StorageError    bool  `json:"storage_error"`
}

// Artifact always describes the stored representation. SourceBytes and SHA256
// describe that representation before capture limits, NOT a redacted original.
type Artifact struct {
	ID             string `json:"id"`
	Representation string `json:"representation"` // captured or redacted
	ContentType    string `json:"content_type"`
	Encoding       string `json:"encoding"`
	SourceBytes    int64  `json:"source_bytes"`
	CapturedBytes  int64  `json:"captured_bytes"`
	SHA256         string `json:"sha256,omitempty"`
	Complete       bool   `json:"complete"`
	Truncated      bool   `json:"truncated"`
	WriteError     bool   `json:"write_error"`
}

type Chunk struct {
	Index  int    `json:"index"`
	Offset int64  `json:"offset"`
	Hash   string `json:"hash"`
	Size   int64  `json:"size"`
}

type Inventory struct {
	Index      int              `json:"index"`
	Kind       string           `json:"kind"`
	ObservedAt time.Time        `json:"observed_at"`
	StateID    string           `json:"state_id"`
	Scope      []protocol.Chunk `json:"scope,omitempty"` // nil means the complete body
	Missing    []protocol.Chunk `json:"missing"`
}

type Attempt struct {
	Index            int              `json:"index"`
	Operation        string           `json:"operation"`
	Method           string           `json:"method"`
	Path             string           `json:"path"`
	StartedAt        time.Time        `json:"started_at"`
	FinishedAt       *time.Time       `json:"finished_at,omitempty"`
	Encoding         string           `json:"encoding"`
	ContentType      string           `json:"content_type"`
	DecodedBytes     int64            `json:"decoded_bytes"`
	PreparedBytes    int64            `json:"prepared_bytes"`
	ConsumedBytes    int64            `json:"consumed_bytes"`
	Counted          bool             `json:"counted"`
	Status           int              `json:"status"`
	Outcome          string           `json:"outcome"`
	Payload          *Artifact        `json:"payload,omitempty"`
	Chunks           []protocol.Chunk `json:"chunks,omitempty"`
	AcknowledgmentOK bool             `json:"acknowledgment_ok"`
}

type Trace struct {
	Version       int            `json:"version"`
	ID            string         `json:"id"`
	RequestID     string         `json:"request_id"`
	Sequence      uint64         `json:"sequence"`
	StartedAt     time.Time      `json:"started_at"`
	FinishedAt    *time.Time     `json:"finished_at,omitempty"`
	State         string         `json:"state"`
	Body          Artifact       `json:"body"`
	Chunks        []Chunk        `json:"chunks"`
	Inventories   []Inventory    `json:"inventories"`
	Attempts      []Attempt      `json:"attempts"`
	DroppedEvents int            `json:"dropped_events"`
	StorageError  bool           `json:"storage_error"`
	Transfer      transfer.Stats `json:"transfer"`
}

type InventorySummary struct {
	Index            int       `json:"index"`
	Kind             string    `json:"kind"`
	ObservedAt       time.Time `json:"observed_at"`
	StateID          string    `json:"state_id"`
	ScopeChunks      int       `json:"scope_chunks"`
	MissingChunks    int       `json:"missing_chunks"`
	MissingBytes     int64     `json:"missing_bytes"`
	PresentBodyBytes int64     `json:"present_body_bytes"`
	MissingBodyBytes int64     `json:"missing_body_bytes"`
	UnknownBodyBytes int64     `json:"unknown_body_bytes"`
}

type AttemptSummary struct {
	Attempt
	ChunkCount int `json:"chunk_count"`
}

// Detail excludes potentially large chunk/hash lists. They have paged endpoints.
type Detail struct {
	Version       int                `json:"version"`
	ID            string             `json:"id"`
	RequestID     string             `json:"request_id"`
	Sequence      uint64             `json:"sequence"`
	StartedAt     time.Time          `json:"started_at"`
	FinishedAt    *time.Time         `json:"finished_at,omitempty"`
	State         string             `json:"state"`
	Body          Artifact           `json:"body"`
	ChunkCount    int                `json:"chunk_count"`
	Inventories   []InventorySummary `json:"inventories"`
	Attempts      []AttemptSummary   `json:"attempts"`
	DroppedEvents int                `json:"dropped_events"`
	StorageError  bool               `json:"storage_error"`
	Transfer      transfer.Stats     `json:"transfer"`
}

func (t Trace) Detail() Detail {
	d := Detail{Version: t.Version, ID: t.ID, RequestID: t.RequestID, Sequence: t.Sequence, StartedAt: t.StartedAt, FinishedAt: t.FinishedAt, State: t.State, Body: t.Body, ChunkCount: len(t.Chunks), Inventories: []InventorySummary{}, Attempts: []AttemptSummary{}, DroppedEvents: t.DroppedEvents, StorageError: t.StorageError, Transfer: t.Transfer}
	for _, i := range t.Inventories {
		scope := len(i.Scope)
		if i.Kind == "initial" {
			scope = len(t.Chunks)
		}
		missingHashes := make(map[string]bool, len(i.Missing))
		var missingBytes int64
		for _, c := range i.Missing {
			missingHashes[c.Hash] = true
			missingBytes += c.Size
		}
		scopeHashes := make(map[string]bool, len(i.Scope))
		for _, c := range i.Scope {
			scopeHashes[c.Hash] = true
		}
		summary := InventorySummary{Index: i.Index, Kind: i.Kind, ObservedAt: i.ObservedAt, StateID: i.StateID, ScopeChunks: scope, MissingChunks: len(i.Missing), MissingBytes: missingBytes}
		// These are manifest-occurrence bytes, so repeated chunks occupy their
		// actual body ranges. Recovery inventories cannot speak for hashes outside
		// their own scope; those body ranges remain explicitly unknown.
		for _, c := range t.Chunks {
			if i.Kind != "initial" && !scopeHashes[c.Hash] {
				summary.UnknownBodyBytes += c.Size
			} else if missingHashes[c.Hash] {
				summary.MissingBodyBytes += c.Size
			} else {
				summary.PresentBodyBytes += c.Size
			}
		}
		d.Inventories = append(d.Inventories, summary)
	}
	for _, a := range t.Attempts {
		count := len(a.Chunks)
		a.Chunks = nil
		d.Attempts = append(d.Attempts, AttemptSummary{Attempt: a, ChunkCount: count})
	}
	return d
}
