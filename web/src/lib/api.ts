import type { Snapshot } from "./types.js"

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function numeric(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0)
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

const totalKeys = ["requests", "active", "failed", "body_bytes", "uploaded_chunk_bytes", "encoded_upload_bytes", "reused_body_bytes", "response_bytes", "duration_ms"]

// Reject incompatible/partial diagnostics rather than quietly showing false 0s.
export function isSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || value.version !== 1 || !timestamp(value.collected_at)) return false
  const { gateway, relay, history, providers } = value
  if (!object(gateway) || !numeric(gateway, ["active", "concurrency", "pending_cancellations"]) || !timestamp(gateway.started_at)) return false
  if (!object(relay) || typeof relay.reachable !== "boolean" || !numeric(relay, ["latency_ms"]) || !object(relay.health)) return false
  if (!numeric(relay.health, ["version", "cache_bytes", "max_cache_bytes", "response_storage_bytes", "max_response_storage_bytes"]) || typeof relay.health.forwarding !== "boolean" || typeof relay.health.state_id !== "string") return false
  if (!object(history) || history.version !== 1 || !timestamp(history.since) || !object(history.totals) || !numeric(history.totals, totalKeys)) return false
  if (!numeric(history, ["session_limit", "request_limit", "evicted_sessions", "dropped_requests"]) || typeof history.persistent !== "boolean" || typeof history.persistence_error !== "boolean") return false
  if (!Array.isArray(history.sessions) || history.sessions.length > 256 || !history.sessions.every((s) => object(s) && numeric(s, totalKeys) && typeof s.id === "string" && typeof s.upstream === "string" && timestamp(s.started_at) && timestamp(s.updated_at) && numeric(s, ["last_status"]))) return false
  if (!Array.isArray(history.recent_requests) || history.recent_requests.length > 1000 || !history.recent_requests.every((r) => object(r) && typeof r.id === "string" && typeof r.session_id === "string" && typeof r.upstream === "string" && typeof r.kind === "string" && ["running", "completed", "failed", "cancelled", "interrupted"].includes(String(r.state)) && timestamp(r.started_at) && (r.finished_at === undefined || timestamp(r.finished_at)) && numeric(r, ["sequence", "status", "response_bytes", "duration_ms"]) && object(r.transfer) && numeric(r.transfer, ["body_bytes", "request_body_bytes_sent", "reused_body_bytes", "uploaded_chunk_bytes", "uploaded_chunks", "chunks"]))) return false
  return Array.isArray(providers) && providers.every((p) => object(p) && typeof p.name === "string" && numeric(p, ["active", "last_status"]) && (p.last_seen === undefined || timestamp(p.last_seen)))
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
