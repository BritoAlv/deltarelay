import type { OpenCodeSessions, Snapshot } from "./types.js"
import { captureID, isCaptureStatus } from "./inspection.js"
import { counters, nonnegativeInteger, object, optionalString, optionalTimestamp, timestamp } from "./validation.js"
import type { TrafficRange } from "./traffic.js"
import type { RelayRequest } from "./types.js"
import { isAPIKey, isUsageMeasurement, usageParams, type UsageFilter } from "./usage.js"

const totalKeys = ["requests", "active", "failed", "cancelled", "body_bytes", "uploaded_chunk_bytes", "encoded_upload_bytes", "reused_body_bytes", "response_bytes", "duration_ms"]
const transferKeys = ["body_bytes", "chunks", "unique_chunks", "uploaded_chunks", "uploaded_chunk_bytes", "missing_chunk_bytes", "reused_body_bytes", "request_body_bytes_sent", "requests", "duration_ms"]
const trafficBucketKeys = ["requests", "failed", "cancelled", "body_bytes", "uploaded_chunk_bytes", "encoded_upload_bytes", "reused_body_bytes", "response_bytes", "duration_ms"]
const hostLabel = (value: unknown) => value === undefined || typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)
const clientLabels = (value: unknown) => value === undefined || Array.isArray(value) &&
  value.every((item) => typeof item === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(item)) && new Set(value).size === value.length
const optionalLegacy = (value: Record<string, unknown>) => value.legacy === undefined || nonnegativeInteger(value.legacy)
const outcomes = (value: Record<string, unknown>) => (value.active as number) + (value.failed as number) + (value.cancelled as number) + (typeof value.legacy === "number" ? value.legacy : 0)

function session(value: unknown): boolean {
  return object(value) && hostLabel(value.host) && counters(value, totalKeys) && optionalLegacy(value) && outcomes(value) <= (value.requests as number) &&
    typeof value.id === "string" && typeof value.upstream === "string" &&
    timestamp(value.started_at) && timestamp(value.updated_at) && counters(value, ["last_status"]) &&
    typeof value.last_request_id === "string" && optionalString(value.last_error) && clientLabels(value.clients)
}

function request(value: unknown): boolean {
  return object(value) && hostLabel(value.host) && hostLabel(value.client) && typeof value.id === "string" && typeof value.session_id === "string" && typeof value.upstream === "string" &&
    typeof value.kind === "string" && typeof value.state === "string" && ["running", "completed", "failed", "cancelled", "interrupted"].includes(value.state) &&
    timestamp(value.started_at) && optionalTimestamp(value.finished_at) && optionalString(value.error_code) &&
    counters(value, ["sequence", "status", "response_bytes", "duration_ms"]) && object(value.transfer) &&
    typeof value.transfer.hash === "string" && counters(value.transfer, transferKeys) && (value.capture_id === undefined || captureID(value.capture_id)) &&
    (value.api_key === undefined || isAPIKey(value.api_key)) && (value.usage === undefined || isUsageMeasurement(value.usage))
}

function trafficBucket(value: unknown): boolean {
  return object(value) && hostLabel(value.host) && timestamp(value.start) && counters(value, trafficBucketKeys) && (value.failed as number) + (value.cancelled as number) <= (value.requests as number)
}

function trafficSeries(value: unknown, expectedSeconds: number): boolean {
  if (!object(value) || !timestamp(value.since) || !counters(value, ["bucket_seconds", "retention_seconds"]) || !Array.isArray(value.buckets)) return false
  const bucketSeconds = value.bucket_seconds as number
  const retentionSeconds = value.retention_seconds as number
  if (bucketSeconds !== expectedSeconds) return false
  const hosts = new Set<string>()
  let previous = -Infinity
  let previousHost = ""
  for (const bucket of value.buckets) {
    if (!trafficBucket(bucket)) return false
    const host = (bucket as { host?: string }).host ?? ""
    hosts.add(host)
    const at = Date.parse((bucket as { start: string }).start)
    if (at < previous || at === previous && host <= previousHost) return false
    previous = at
    previousHost = host
  }
  return retentionSeconds === 0 || value.buckets.length <= (Math.ceil(retentionSeconds / bucketSeconds) + 2) * Math.max(1, hosts.size)
}

function traffic(value: unknown): boolean {
  return object(value) && trafficSeries(value.hourly, 3600) && trafficSeries(value.daily, 86400)
}

// Reject incompatible/partial diagnostics rather than quietly showing false 0s.
export function isSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || value.version !== 1 || !timestamp(value.collected_at)) return false
  if (value.requests_paged !== undefined && typeof value.requests_paged !== "boolean") return false
  if (value.inspection !== undefined && !isCaptureStatus(value.inspection)) return false
  if (value.overview !== undefined) {
    const summary = value.overview
    if (!object(summary) || !counters(summary, ["start", "end", "bucket_ms", "sessions", "active_sessions", "running"]) ||
      typeof summary.host !== "string" || !Array.isArray(summary.points) || summary.points.length > 200 ||
      !["hourly", "daily", "requests"].includes(String(summary.source)) || !nonnegativeInteger(summary.coverage_start) || typeof summary.incomplete !== "boolean" || typeof summary.incomplete_sessions !== "boolean" ||
      !summary.points.every((point) => object(point) && counters(point, ["at", "end", "requests", "failed", "cancelled", "body", "encoded", "reused", "uploadedChunkBytes", "response", "duration"]))) return false
  }
  const { gateway, relay, history, providers } = value
  if (!object(gateway) || !counters(gateway, ["active", "concurrency", "pending_cancellations"]) || !timestamp(gateway.started_at) || !optionalString(gateway.control_error)) return false
  if (!object(relay) || typeof relay.reachable !== "boolean" || !counters(relay, ["latency_ms"]) || !object(relay.health)) return false
  if (!counters(relay.health, ["version", "cache_bytes", "max_cache_bytes", "response_storage_bytes", "max_response_storage_bytes", "pending_cancellations"]) || typeof relay.health.forwarding !== "boolean" || typeof relay.health.state_id !== "string" || !optionalString(relay.health.control_error)) return false
  if (!object(history) || history.version !== 1 || !hostLabel(history.host) || !timestamp(history.since) || !object(history.totals) || !counters(history.totals, totalKeys) || !optionalLegacy(history.totals)) return false
  if (outcomes(history.totals) > (history.totals.requests as number)) return false
  if (history.host_totals !== undefined) {
    if (!object(history.host_totals) || Object.keys(history.host_totals).length > 1000) return false
    for (const [host, totals] of Object.entries(history.host_totals)) {
      if (!host || !/^[A-Za-z0-9._-]{1,128}$/.test(host) || !object(totals) || !counters(totals, totalKeys) || !optionalLegacy(totals) || outcomes(totals) > (totals.requests as number)) return false
    }
  }
  if (!counters(history, ["session_limit", "request_limit", "evicted_sessions", "dropped_requests"]) || typeof history.persistent !== "boolean" || typeof history.persistence_error !== "boolean") return false
  const sessionLimit = history.session_limit as number
  const requestLimit = history.request_limit as number
  if (!Array.isArray(history.sessions) || sessionLimit > 0 && history.sessions.length > sessionLimit || !history.sessions.every(session)) return false
  if (!Array.isArray(history.recent_requests) || requestLimit > 0 && history.recent_requests.length > requestLimit || !history.recent_requests.every(request)) return false
  if (!traffic(history.traffic)) return false
  return Array.isArray(providers) && providers.every((p) => object(p) && typeof p.name === "string" && optionalString(p.origin) && optionalString(p.path_prefix) && counters(p, ["active", "last_status"]) && optionalString(p.last_error) && optionalTimestamp(p.last_seen))
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

export async function fetchSnapshot(signal: AbortSignal, options?: { compact: true; range?: TrafficRange; host?: string; now?: number }): Promise<Snapshot> {
  const params = new URLSearchParams()
  if (options) {
    params.set("compact", "1")
    if (options.range) {
      params.set("start", String(options.range.start))
      params.set("end", String(options.range.end))
      params.set("bucket", String(Math.min(options.range.bucketMs, options.range.end - options.range.start)))
      if (options.range.preset === "last" || options.range.preset === "datetime") params.set("exact", "1")
      if (options.now !== undefined) params.set("now", String(options.now))
      if (options.host) params.set("host", options.host)
    }
  }
  const response = await fetch(`/api/dashboard${params.size ? `?${params}` : ""}`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
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

export interface RequestPage {
  requests: RelayRequest[]
  total: number
  next_before: number
}

export async function fetchRequestPage(session: string, host: string, before: number, limit: number, signal: AbortSignal, filter: UsageFilter = {}): Promise<RequestPage> {
  const params = usageParams({ ...filter, session, host })
  params.set("limit", String(limit))
  if (host) params.set("host", host)
  if (before) params.set("before", String(before))
  const response = await fetch(`/api/dashboard/requests?${params}`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  if (!response.ok) throw new Error("Request history is unavailable. Retry to load this page.")
  const data: unknown = await response.json()
  if (!object(data) || !counters(data, ["total", "next_before"]) || !Array.isArray(data.requests) ||
    data.requests.length > limit || !data.requests.every(request)) throw new Error("The gateway returned incompatible request history.")
  return data as unknown as RequestPage
}
