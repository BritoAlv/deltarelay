import { savings } from "./metrics.js"
import type { RelayRequest, Session } from "./types.js"

export interface SessionMeasurement {
  original: number
  encoded: number
  saved: number
  reduction: number | null
  reused: number
  uploaded: number
  reusedPercent: number | null
  totalRequests: number
  retainedRequests: number
  missingRequests: number
}

export interface RequestMeasurement {
  original: number
  encoded: number
  saved: number
  reduction: number | null
  reused: number
  uploaded: number
  missing: number
  reusedPercent: number | null
  httpRequests: number
  pending: boolean
  elapsedMs: number
}

export interface BarComparison {
  originalPercent: number
  encodedPercent: number
  savedPercent: number
  negative: boolean
}

export function sessionMeasurement(session: Session, retained: RelayRequest[]): SessionMeasurement {
  return {
    original: session.body_bytes,
    encoded: session.encoded_upload_bytes,
    saved: session.body_bytes - session.encoded_upload_bytes,
    reduction: savings(session.body_bytes, session.encoded_upload_bytes),
    reused: session.reused_body_bytes,
    uploaded: session.uploaded_chunk_bytes,
    reusedPercent: session.body_bytes > 0 ? session.reused_body_bytes / session.body_bytes * 100 : null,
    totalRequests: session.requests,
    retainedRequests: retained.length,
    missingRequests: Math.max(0, session.requests - retained.length),
  }
}

// Running requests have no final transfer accounting yet. Never turn their
// placeholder zeros into a 100% saving; expose elapsed time and pending state.
export function requestMeasurement(request: RelayRequest, collectedAt: string): RequestMeasurement {
  const pending = request.state === "running"
  const original = pending ? 0 : request.transfer.body_bytes
  const encoded = pending ? 0 : request.transfer.request_body_bytes_sent
  const elapsedMs = pending
    ? Math.max(0, Date.parse(collectedAt) - Date.parse(request.started_at))
    : request.duration_ms
  return {
    original,
    encoded,
    saved: original - encoded,
    reduction: savings(original, encoded),
    reused: pending ? 0 : request.transfer.reused_body_bytes,
    uploaded: pending ? 0 : request.transfer.uploaded_chunk_bytes,
    missing: pending ? 0 : request.transfer.missing_chunk_bytes,
    reusedPercent: original > 0 ? request.transfer.reused_body_bytes / original * 100 : null,
    httpRequests: pending ? 0 : request.transfer.requests,
    pending,
    elapsedMs,
  }
}

// One scale for both bars keeps the comparison honest when encoded bytes exceed
// the original body. The saved segment is always the absolute gap.
export function barComparison(original: number, encoded: number): BarComparison {
  const max = Math.max(original, encoded, 1)
  return {
    originalPercent: original / max * 100,
    encodedPercent: encoded / max * 100,
    savedPercent: Math.abs(original - encoded) / max * 100,
    negative: encoded > original,
  }
}
