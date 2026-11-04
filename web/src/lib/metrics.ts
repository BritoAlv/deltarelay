import type { Session, Totals } from "./types.js"

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

export function filterSessions(sessions: Session[], query: string, state: string): Session[] {
  const text = query.trim().toLowerCase()
  return sessions.filter((session) =>
    (!text || `${session.id || "unattributed"} ${session.upstream}`.toLowerCase().includes(text)) &&
    (state === "all" || sessionState(session) === state),
  )
}

export function emptyTotals(): Totals {
  return { requests: 0, active: 0, failed: 0, cancelled: 0, body_bytes: 0, uploaded_chunk_bytes: 0, encoded_upload_bytes: 0, reused_body_bytes: 0, response_bytes: 0, duration_ms: 0 }
}
