package protocol

import "net/http"

// RelayVersion versions the mailbox contract. The immutable chunk/manifest
// encoding remains Version (1), independently of the HTTP API version.
const RelayVersion = 2

const ResponseSegmentBytes = 256 << 10

const (
	Accepted    = "accepted"
	Running     = "running"
	Completed   = "completed"
	Failed      = "failed"
	Cancelled   = "cancelled"
	Interrupted = "interrupted"
)

func Terminal(state string) bool { return state != Accepted && state != Running }

type Info struct {
	Version                 int      `json:"version"`
	ChunkVersion            int      `json:"chunk_version"`
	StateID                 string   `json:"state_id"`
	Forwarding              bool     `json:"forwarding"`
	Capabilities            []string `json:"capabilities"`
	MaxBodyBytes            int64    `json:"max_body_bytes"`
	MaxChunkBytes           int64    `json:"max_chunk_bytes"`
	MaxManifestBytes        int64    `json:"max_manifest_bytes"`
	MaxBatchBytes           int64    `json:"max_batch_bytes"`
	MaxBatchChunks          int      `json:"max_batch_chunks"`
	ResponseSegmentBytes    int      `json:"response_segment_bytes"`
	PollTimeoutSeconds      int      `json:"poll_timeout_seconds"`
	MaxResponseBytes        int64    `json:"max_response_bytes"`
	MaxResponseStorageBytes int64    `json:"max_response_storage_bytes"`
	ResponseStorageBytes    int64    `json:"response_storage_bytes"`
	RetentionSeconds        int64    `json:"retention_seconds"`
	MaxRuntimeSeconds       int64    `json:"max_runtime_seconds"`
	MaxConcurrent           int      `json:"max_concurrent"`
	MaxJournalRecords       int      `json:"max_journal_records"`
	CacheBytes              int64    `json:"cache_bytes"`
	MaxCacheBytes           int64    `json:"max_cache_bytes"`
}

// RequestStatus contains no provider credentials, original URL or request body.
// Bytes describes the durable prefix, not bytes merely received from upstream.
type RequestStatus struct {
	ID           string      `json:"id"`
	StateID      string      `json:"state_id"`
	Fingerprint  string      `json:"fingerprint"`
	BodyHash     string      `json:"body_hash"`
	State        string      `json:"state"`
	Status       int         `json:"status"`
	Headers      http.Header `json:"headers,omitempty"`
	Bytes        int64       `json:"bytes"`
	Hash         string      `json:"hash,omitempty"`
	Created      int64       `json:"created_unix"`
	Finished     int64       `json:"finished_unix,omitempty"`
	Expires      int64       `json:"expires_unix,omitempty"`
	Acknowledged bool        `json:"acknowledged"`
	Expired      bool        `json:"expired"`
	ErrorCode    string      `json:"error_code,omitempty"`
}

type Receipt struct {
	Size int64  `json:"size"`
	Hash string `json:"hash"`
}
