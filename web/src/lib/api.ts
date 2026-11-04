import type { OpenCodeSessions, Snapshot } from "./types.js"
import { captureID, isCaptureStatus } from "./inspection.js"
import { counters, object, optionalString, optionalTimestamp, timestamp } from "./validation.js"

const totalKeys = ["requests", "active", "failed", "cancelled", "body_bytes", "uploaded_chunk_bytes", "encoded_upload_bytes", "reused_body_bytes", "response_bytes", "duration_ms"]
const transferKeys = ["body_bytes", "chunks", "unique_chunks", "uploaded_chunks", "uploaded_chunk_bytes", "missing_chunk_bytes", "reused_body_bytes", "request_body_bytes_sent", "requests", "duration_ms"]
const trafficBucketKeys = ["requests", "failed", "cancelled", "body_bytes", "uploaded_chunk_bytes", "encoded_upload_bytes", "reused_body_bytes", "response_bytes", "duration_ms"]

function session(value: unknown): boolean {
  return object(value) && counters(value, totalKeys) && typeof value.id === "string" && typeof value.upstream === "string" &&
    timestamp(value.started_at) && timestamp(value.updated_at) && counters(value, ["last_status"]) &&
    typeof value.last_request_id === "string" && optionalString(value.last_error)
}

function request(value: unknown): boolean {
  return object(value) && typeof value.id === "string" && typeof value.session_id === "string" && typeof value.upstream === "string" &&
    typeof value.kind === "string" && typeof value.state === "string" && ["running", "completed", "failed", "cancelled", "interrupted"].includes(value.state) &&
    timestamp(value.started_at) && optionalTimestamp(value.finished_at) && optionalString(value.error_code) &&
    counters(value, ["sequence", "status", "response_bytes", "duration_ms"]) && object(value.transfer) &&
    typeof value.transfer.hash === "string" && counters(value.transfer, transferKeys) && (value.capture_id === undefined || captureID(value.capture_id))
}

function trafficBucket(value: unknown): boolean {
  return object(value) && timestamp(value.start) && counters(value, trafficBucketKeys) && (value.failed as number) + (value.cancelled as number) <= (value.requests as number)
}

function trafficSeries(value: unknown, expectedSeconds: number): boolean {
  if (!object(value) || !timestamp(value.since) || !counters(value, ["bucket_seconds", "retention_seconds"]) || !Array.isArray(value.buckets)) return false
  const bucketSeconds = value.bucket_seconds as number
  const retentionSeconds = value.retention_seconds as number
  if (bucketSeconds !== expectedSeconds || retentionSeconds <= 0) return false
  if (value.buckets.length > Math.ceil(retentionSeconds / bucketSeconds) + 2) return false
  let previous = -Infinity
  for (const bucket of value.buckets) {
    if (!trafficBucket(bucket)) return false
    const at = Date.parse((bucket as { start: string }).start)
    if (at <= previous) return false
    previous = at
  }
  return true
}

function traffic(value: unknown): boolean {
  return object(value) && trafficSeries(value.hourly, 3600) && trafficSeries(value.daily, 86400)
}

// Reject incompatible/partial diagnostics rather than quietly showing false 0s.
export function isSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || value.version !== 1 || !timestamp(value.collected_at)) return false
  if (value.inspection !== undefined && !isCaptureStatus(value.inspection)) return false
  const { gateway, relay, history, providers } = value
  if (!object(gateway) || !counters(gateway, ["active", "concurrency", "pending_cancellations"]) || !timestamp(gateway.started_at) || !optionalString(gateway.control_error)) return false
  if (!object(relay) || typeof relay.reachable !== "boolean" || !counters(relay, ["latency_ms"]) || !object(relay.health)) return false
  if (!counters(relay.health, ["version", "cache_bytes", "max_cache_bytes", "response_storage_bytes", "max_response_storage_bytes", "pending_cancellations"]) || typeof relay.health.forwarding !== "boolean" || typeof relay.health.state_id !== "string" || !optionalString(relay.health.control_error)) return false
  if (!object(history) || history.version !== 1 || !timestamp(history.since) || !object(history.totals) || !counters(history.totals, totalKeys)) return false
  if ((history.totals.active as number) + (history.totals.failed as number) + (history.totals.cancelled as number) > (history.totals.requests as number)) return false
  if (!counters(history, ["session_limit", "request_limit", "evicted_sessions", "dropped_requests"]) || typeof history.persistent !== "boolean" || typeof history.persistence_error !== "boolean") return false
  if ((history.session_limit as number) > 256 || (history.request_limit as number) > 1000) return false
  if (!Array.isArray(history.sessions) || history.sessions.length > (history.session_limit as number) || !history.sessions.every(session)) return false
  if (!Array.isArray(history.recent_requests) || history.recent_requests.length > (history.request_limit as number) || !history.recent_requests.every(request)) return false
  if (!traffic(history.traffic)) return false
  return Array.isArray(providers) && providers.every((p) => object(p) && typeof p.name === "string" && counters(p, ["active", "last_status"]) && optionalString(p.last_error) && optionalTimestamp(p.last_seen))
}

function openCodeSession(value: unknown): boolean {
  return object(value) && typeof value.id === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value.id) &&
    optionalString(value.title) && timestamp(value.created_at) && timestamp(value.updated_at) &&
    optionalString(value.project) && optionalString(value.agent) && optionalString(value.model)
}

export function isOpenCodeSessions(value: unknown): value is OpenCodeSessions {
  return object(value) && value.version === 1 && timestamp(value.checked_at) &&
    Array.isArray(value.sessions) && value.sessions.length <= 2000 && value.sessions.every(openCodeSession) &&
    typeof value.truncated === "boolean" && typeof value.stale === "boolean"
}

export async function fetchOpenCodeSessions(signal: AbortSignal): Promise<OpenCodeSessions> {
  const response = await fetch("/api/opencode/sessions", { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  if (!response.ok) throw new Error("OpenCode session metadata is unavailable.")
  const data: unknown = await response.json().catch(() => null)
  if (!isOpenCodeSessions(data)) throw new Error("The local OpenCode service returned incompatible session metadata.")
  return data
}

export async function fetchSnapshot(signal: AbortSignal): Promise<Snapshot> {
  const response = await fetch("/api/dashboard", { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null)
    switch (object(data) ? data.error : "") {
      case "gateway_authentication": throw new Error("Gateway authentication failed. Check the dashboard’s local token file.")
      case "gateway_upgrade_required": throw new Error("This gateway needs the dashboard-enabled DeltaRelay build. Rebuild and restart the gateway.")
      default: throw new Error("Cannot reach the local gateway. Start the gateway and dashboard server; no provider requests have been sent by this page.")
    }
  }
  const data: unknown = await response.json()
  if (!isSnapshot(data)) throw new Error("The gateway returned incompatible diagnostics. Rebuild both the gateway and dashboard.")
  return data
}
