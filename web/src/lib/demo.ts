import { emptyTotals } from "./metrics.js"
import type { RelayRequest, Session, Snapshot } from "./types.js"

// Explicitly opt-in illustrative data. Never returned by the diagnostics API.
export function makeDemoSnapshot(now = Date.now()): Snapshot {
  const sessions: Session[] = ["ses_7fd82a_relay-dashboard", "ses_a93f10_api-refactor", "ses_2c817d_test-suite", "ses_8b12e6_docs-update", "ses_4d903a_cache-worker", "ses_1e77b4_release-check"].map((id, i) => ({
    ...emptyTotals(), id, upstream: i % 3 === 0 ? "openai" : "opencode-go", started_at: new Date(now - (24 - i * 2) * 3_600_000).toISOString(), updated_at: new Date(now - i * 17 * 60_000).toISOString(), last_status: i === 4 ? 503 : 200, last_error: i === 4 ? "relay_unreachable" : undefined, last_request_id: "",
  }))
  const requests: RelayRequest[] = []
  const totals = emptyTotals()
  for (let i = 0; i < 72; i++) {
    const session = sessions[i % sessions.length]!
    const body = (3 + i % 8) * 1024 * 1024 + i * 7919
    const encoded = Math.round(body * (i < 6 ? .19 : .012 + (i % 7) * .003))
    const failed = i === 64
    const at = now - (72 - i) * 18 * 60_000
    const transfer = { hash: "0".repeat(64), body_bytes: body, chunks: Math.ceil(body / 16384), unique_chunks: Math.ceil(body / 16384), uploaded_chunks: 8, uploaded_chunk_bytes: encoded * 2, missing_chunk_bytes: encoded * 2, reused_body_bytes: Math.round(body * .965), request_body_bytes_sent: encoded, requests: 5, duration_ms: 1700 + i * 11 }
    const request: RelayRequest = { sequence: i + 1, id: `sample-request-${String(i + 1).padStart(4, "0")}`, session_id: session.id, upstream: session.upstream, kind: i % 12 === 0 ? "compaction" : "primary", started_at: new Date(at).toISOString(), finished_at: new Date(at + 17_000).toISOString(), state: failed ? "failed" : "completed", status: failed ? 503 : 200, error_code: failed ? "relay_unreachable" : undefined, transfer, response_bytes: 42_000, duration_ms: 17_000 + i * 327 }
    requests.push(request)
    for (const target of [session, totals]) {
      target.requests++
      target.failed += Number(failed)
      target.body_bytes += body
      target.encoded_upload_bytes += encoded
      target.uploaded_chunk_bytes += transfer.uploaded_chunk_bytes
      target.reused_body_bytes += transfer.reused_body_bytes
      target.response_bytes += request.response_bytes
      target.duration_ms += request.duration_ms
    }
    session.last_request_id = request.id
  }
  sessions[0]!.requests++
  sessions[0]!.active++
  totals.requests++
  totals.active++
  requests.push({ sequence: 73, id: "sample-request-active", session_id: sessions[0]!.id, upstream: "openai", kind: "primary", started_at: new Date(now - 12_000).toISOString(), state: "running", status: 0, transfer: { hash: "", body_bytes: 0, chunks: 0, unique_chunks: 0, uploaded_chunks: 0, uploaded_chunk_bytes: 0, missing_chunk_bytes: 0, reused_body_bytes: 0, request_body_bytes_sent: 0, requests: 0, duration_ms: 0 }, response_bytes: 0, duration_ms: 0 })
  return {
    version: 1, collected_at: new Date(now).toISOString(),
    gateway: { started_at: new Date(now - 48 * 3_600_000).toISOString(), active: 1, concurrency: 8, pending_cancellations: 0 },
    relay: { reachable: true, latency_ms: 42, health: { version: 2, state_id: "c7a41b9f8e2d".repeat(5) + "c7a4", forwarding: true, cache_bytes: 241_000_000, max_cache_bytes: 10 * 1024 ** 3, response_storage_bytes: 18_400_000, max_response_storage_bytes: 4 * 1024 ** 3, pending_cancellations: 0 } },
    providers: [{ name: "openai", active: 1, last_status: 200, last_seen: new Date(now - 40_000).toISOString() }, { name: "opencode-go", active: 0, last_status: 200, last_seen: new Date(now - 120_000).toISOString() }],
    history: { version: 1, since: new Date(now - 48 * 3_600_000).toISOString(), totals, sessions, recent_requests: requests, session_limit: 256, request_limit: 1000, evicted_sessions: 0, dropped_requests: 0, persistent: true, persistence_error: false },
  }
}
