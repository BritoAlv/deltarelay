// Package transfer owns metadata-only measurements of a body transfer. It has no
// dependency on the client transport or on optional telemetry persistence.
package transfer

// Stats counts raw body/chunk bytes separately from encoded RPC request bytes.
// Requests and RequestBodyBytesSent retain the client's existing accounting
// semantics; they do not count provider response bytes or every control RPC.
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
