import type { RelayRequest, Session, Snapshot, Totals } from "./types.js"

export function bytes(value: number, precision = 1): string {
  if (!Number.isFinite(value)) return "—"
  const absolute = Math.abs(value)
  if (absolute < 1024) return `${Math.round(value).toLocaleString()}\u00A0B`
  const unit = Math.min(Math.floor(Math.log(absolute) / Math.log(1024)), 4)
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: precision })}\u00A0${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`
}

// Keep negative savings: metadata and retries can exceed the original body.
export function savings(body: number, encoded: number): number | null {
  return body > 0 ? (1 - encoded / body) * 100 : null
}

export function percentage(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

export function duration(ms: number): string {
  ms = Math.max(0, ms)
  if (ms < 1000) return `${Math.round(ms)}\u00A0ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}\u00A0s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m\u00A0${seconds % 60}s`
}

export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(value)) / 1000)
  if (!Number.isFinite(seconds)) return "—"
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function sessionState(session: Session): "active" | "attention" | "idle" {
  if (session.active > 0) return "active"
  // 499 records a client-closed request, not a provider or relay failure.
  if (session.last_status !== 499 && (session.last_status >= 400 || session.last_error)) return "attention"
  return "idle"
}

export function filterSessions<T extends Session>(sessions: T[], query: string, state: string, host = ""): T[] {
  const text = query.trim().toLowerCase()
  return sessions.filter((session) =>
    (!host || sessionHost(session) === host) &&
    (!text || `${session.id || "unattributed"} ${session.upstream} ${sessionHost(session)} ${(session as { hosts?: string[] }).hosts?.join(" ") ?? ""}`.toLowerCase().includes(text)) &&
    (state === "all" || sessionState(session) === state),
  )
}

export function emptyTotals(): Totals {
  return { requests: 0, active: 0, failed: 0, cancelled: 0, body_bytes: 0, uploaded_chunk_bytes: 0, encoded_upload_bytes: 0, reused_body_bytes: 0, response_bytes: 0, duration_ms: 0 }
}

export function addTotals(target: Totals, value: Totals): void {
  target.requests += value.requests
  target.active += value.active
  target.failed += value.failed
  target.cancelled += value.cancelled
  target.body_bytes += value.body_bytes
  target.uploaded_chunk_bytes += value.uploaded_chunk_bytes
  target.encoded_upload_bytes += value.encoded_upload_bytes
  target.reused_body_bytes += value.reused_body_bytes
  target.response_bytes += value.response_bytes
  target.duration_ms += value.duration_ms
}

export function sessionHost(session: Session): string {
  return session.host || "local"
}

export interface SessionView extends Session {
  hosts: string[]
}

// The gateway keeps one session row per host. The unfiltered view merges rows
// with the same opaque session ID, while a host filter keeps that host's
// independent totals.
export function mergeSessions(sessions: Session[]): SessionView[] {
  const merged = new Map<string, SessionView>()
  for (const session of sessions) {
    const current = merged.get(session.id)
    const host = sessionHost(session)
    if (!current) {
      merged.set(session.id, { ...session, clients: [...(session.clients ?? [])], hosts: [host] })
      continue
    }
    addTotals(current, session)
    if (!current.hosts.includes(host)) current.hosts.push(host)
    for (const client of session.clients ?? []) {
      if (!current.clients?.includes(client)) current.clients = [...(current.clients ?? []), client]
    }
    if (Date.parse(session.started_at) < Date.parse(current.started_at)) current.started_at = session.started_at
    if (Date.parse(session.updated_at) >= Date.parse(current.updated_at)) {
      current.updated_at = session.updated_at
      current.upstream = session.upstream
      current.last_status = session.last_status
      current.last_error = session.last_error
      current.last_request_id = session.last_request_id
    }
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
}

export function displaySessions(snapshot: Snapshot | null, host = ""): SessionView[] {
  if (!snapshot) return []
  const sessions = snapshot.history.sessions.filter((session) => !host || sessionHost(session) === host)
  return mergeSessions(sessions)
}

export function historyHosts(snapshot: Snapshot | null): string[] {
  if (!snapshot) return []
  const hosts = new Set<string>(Object.keys(snapshot.history.host_totals ?? {}))
  for (const session of snapshot.history.sessions) hosts.add(sessionHost(session))
  for (const request of snapshot.history.recent_requests) hosts.add(request.host || "local")
  for (const bucket of snapshot.history.traffic.hourly.buckets) hosts.add(bucket.host || "local")
  for (const bucket of snapshot.history.traffic.daily.buckets) hosts.add(bucket.host || "local")
  return [...hosts].filter(Boolean).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }))
}

export function historyTotals(snapshot: Snapshot | null, host = ""): Totals {
  if (!snapshot) return emptyTotals()
  if (!host) return snapshot.history.totals
  const known = snapshot.history.host_totals?.[host]
  if (known) return known
  const totals = emptyTotals()
  for (const session of snapshot.history.sessions) {
    if (sessionHost(session) === host) addTotals(totals, session)
  }
  return totals
}

export function trackedSessionCount(snapshot: Snapshot | null, host = ""): number {
  return displaySessions(snapshot, host).length
}

export function sessionRequests(snapshot: Snapshot, sessionId: string, host = ""): RelayRequest[] {
  return snapshot.history.recent_requests
    .filter((request) => request.session_id === sessionId && (!host || (request.host || "local") === host))
    .sort((left, right) => right.sequence - left.sequence)
}
