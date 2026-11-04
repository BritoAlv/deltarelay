import type { CaptureStatus } from "./inspection.js"

export interface Totals {
  requests: number
  active: number
  failed: number
  cancelled: number
  body_bytes: number
  uploaded_chunk_bytes: number
  encoded_upload_bytes: number
  reused_body_bytes: number
  response_bytes: number
  duration_ms: number
}

export interface Session extends Totals {
  id: string
  started_at: string
  updated_at: string
  upstream: string
  last_status: number
  last_error?: string
  last_request_id: string
}

export interface Transfer {
  hash: string
  body_bytes: number
  chunks: number
  unique_chunks: number
  uploaded_chunks: number
  uploaded_chunk_bytes: number
  missing_chunk_bytes: number
  reused_body_bytes: number
  request_body_bytes_sent: number
  requests: number
  duration_ms: number
}

export interface RelayRequest {
  capture_id?: string
  sequence: number
  id: string
  session_id: string
  upstream: string
  kind: string
  started_at: string
  finished_at?: string
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted"
  status: number
  error_code?: string
  transfer: Transfer
  response_bytes: number
  duration_ms: number
}

export interface TrafficBucket {
  start: string
  requests: number
  failed: number
  cancelled: number
  body_bytes: number
  uploaded_chunk_bytes: number
  encoded_upload_bytes: number
  reused_body_bytes: number
  response_bytes: number
  duration_ms: number
}

export interface TrafficSeries {
  since: string
  bucket_seconds: number
  retention_seconds: number
  buckets: TrafficBucket[]
}

export interface Traffic {
  hourly: TrafficSeries
  daily: TrafficSeries
}

export interface OpenCodeSession {
  id: string
  title?: string
  created_at: string
  updated_at: string
  project?: string
  agent?: string
  model?: string
}

export interface OpenCodeSessions {
  version: 1
  checked_at: string
  sessions: OpenCodeSession[]
  truncated: boolean
  stale: boolean
}

export interface Snapshot {
  inspection?: CaptureStatus
  version: 1
  collected_at: string
  gateway: {
    started_at: string
    active: number
    concurrency: number
    pending_cancellations: number
    control_error?: string
  }
  relay: {
    reachable: boolean
    latency_ms: number
    health: {
      version: number
      state_id: string
      forwarding: boolean
      cache_bytes: number
      max_cache_bytes: number
      response_storage_bytes: number
      max_response_storage_bytes: number
      pending_cancellations: number
      control_error?: string
    }
  }
  providers: {
    name: string
    active: number
    last_status: number
    last_error?: string
    last_seen?: string
  }[]
  history: {
    version: 1
    since: string
    totals: Totals
    sessions: Session[]
    recent_requests: RelayRequest[]
    traffic: Traffic
    session_limit: number
    request_limit: number
    evicted_sessions: number
    dropped_requests: number
    persistent: boolean
    persistence_error: boolean
  }
}
