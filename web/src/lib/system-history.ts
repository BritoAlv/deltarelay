import { nonnegativeInteger, object, timestamp } from "./validation.js"

export const historyStates = [
  "connected",
  "recovering",
  "unreachable",
  "host_stopped",
  "no_internet",
  "stopped",
  "off",
  "unknown",
] as const

export type HistoryState = typeof historyStates[number]

export const historyStateLabels: Record<HistoryState, string> = {
  connected: "Connected",
  recovering: "Recovering",
  unreachable: "Unreachable",
  host_stopped: "System down",
  no_internet: "No internet",
  stopped: "System stopped",
  off: "Off",
  unknown: "Unknown",
}

export type HistorySeconds = Record<HistoryState, number>

export interface SystemHistoryBucket {
  start: string
  seconds: HistorySeconds
}

export interface SystemHistoryInterval {
  start: string
  end: string
  state: HistoryState
}

export interface SystemHistory {
  version: 1
  tracking_since: string
  generated_at: string
  start: string
  end: string
  bucket_seconds: number
  states: HistoryState[]
  buckets: SystemHistoryBucket[]
  intervals: SystemHistoryInterval[]
  intervals_complete: boolean
  totals: HistorySeconds
  current: { state: HistoryState; since: string }
  persistent: boolean
  storage_error: boolean
}

function isState(value: unknown): value is HistoryState {
  return typeof value === "string" && (historyStates as readonly string[]).includes(value)
}

function seconds(value: unknown, maximum: number): value is HistorySeconds {
  if (!object(value) || Object.keys(value).length !== historyStates.length) return false
  let total = 0
  for (const state of historyStates) {
    const valueSeconds = value[state]
    if (!nonnegativeInteger(valueSeconds) || valueSeconds > maximum) return false
    total += valueSeconds
  }
  return total <= maximum
}

function addSeconds(target: HistorySeconds, value: HistorySeconds): void {
  for (const state of historyStates) target[state] += value[state]
}

function zeroSeconds(): HistorySeconds {
  return { connected: 0, recovering: 0, unreachable: 0, host_stopped: 0, no_internet: 0, stopped: 0, off: 0, unknown: 0 }
}

// The Go dashboard validates the same response before it reaches the browser.
// Keep this strict so a partial supervisor response never becomes a false zero.
export function isSystemHistory(value: unknown): value is SystemHistory {
  if (!object(value) || value.version !== 1 || !timestamp(value.tracking_since) ||
      !timestamp(value.generated_at) || !timestamp(value.start) || !timestamp(value.end) ||
      typeof value.persistent !== "boolean" || typeof value.storage_error !== "boolean") return false
  if (!nonnegativeInteger(value.bucket_seconds) || value.bucket_seconds < 1 || value.bucket_seconds > 3660 * 86_400) return false
  const states = value.states
  if (!Array.isArray(states) || states.length !== historyStates.length ||
      !historyStates.every((state, index) => states[index] === state)) return false
  const start = Date.parse(value.start)
  const end = Date.parse(value.end)
  const generated = Date.parse(value.generated_at)
  const tracking = Date.parse(value.tracking_since)
  if (!(end > start) || tracking > generated) return false
  const buckets = value.buckets
  if (!Array.isArray(buckets) || buckets.length < 1 || buckets.length > 2000) return false
  const bucket = value.bucket_seconds
  const expected = Math.ceil((end - start) / 1000 / bucket)
  if (buckets.length !== expected) return false
  const sums: HistorySeconds = zeroSeconds()
  const spanSeconds = (end - start) / 1000
  for (const [index, item] of buckets.entries()) {
    const limit = Math.min(bucket, spanSeconds - index * bucket)
    if (!object(item) || !timestamp(item.start) || Date.parse(item.start) !== start + index * bucket * 1000 || !seconds(item.seconds, limit)) return false
    addSeconds(sums, item.seconds)
  }
  if (!seconds(value.totals, spanSeconds)) return false
  for (const state of historyStates) if (value.totals[state] !== sums[state]) return false
  if (typeof value.intervals_complete !== "boolean") return false
  const intervals = value.intervals
  if (!Array.isArray(intervals) || intervals.length > 6000) return false
  const intervalSums = zeroSeconds()
  let previousEnd = start
  for (const item of intervals) {
    if (!object(item) || !isState(item.state) || !timestamp(item.start) || !timestamp(item.end)) return false
    const intervalStart = Date.parse(item.start)
    const intervalEnd = Date.parse(item.end)
    if (!(intervalEnd > intervalStart) || intervalStart < start || intervalEnd > end || intervalStart < previousEnd) return false
    previousEnd = intervalEnd
    intervalSums[item.state] += (intervalEnd - intervalStart) / 1000
  }
  for (const state of historyStates) {
    if (value.intervals_complete ? intervalSums[state] !== value.totals[state] : intervalSums[state] > value.totals[state]) return false
  }
  if (!object(value.current) || !isState(value.current.state) || !timestamp(value.current.since) || Date.parse(value.current.since) > generated) return false
  return true
}

export function historyTrackedSeconds(history: SystemHistory): number {
  return historyStates.reduce((total, state) => total + history.totals[state], 0)
}

export function historyCoverage(history: SystemHistory): number | null {
  const length = (Date.parse(history.end) - Date.parse(history.start)) / 1000
  return length > 0 ? Math.min(100, historyTrackedSeconds(history) / length * 100) : null
}

function historyError(code: string): string {
  const messages: Record<string, string> = {
    controls_not_configured: "State history needs the local supervisor.",
    supervisor_unavailable: "The local supervisor is unavailable, so state history is paused.",
    supervisor_upgrade_required: "Restart the updated local supervisor to collect system-state history.",
    invalid_request: "The state-history request was rejected. Refresh the page and try again.",
    invalid_supervisor_response: "The local supervisor returned incompatible state history. Restart the updated supervisor and dashboard.",
  }
  return messages[code] ?? "State history is unavailable."
}

export async function fetchSystemHistory(
  range: { start: number; end: number; bucketMs: number },
  signal: AbortSignal,
): Promise<SystemHistory> {
  const start = Math.floor(range.start / 1000)
  const end = Math.max(start + 1, Math.floor(range.end / 1000))
  const bucket = Math.max(1, Math.ceil(range.bucketMs / 1000))
  const query = new URLSearchParams({ start: String(start), end: String(end), bucket: String(bucket) })
  const response = await fetch(`/api/system/history?${query}`, {
    signal, cache: "no-store", credentials: "same-origin", redirect: "error",
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(historyError(object(data) && typeof data.error === "string" ? data.error : ""))
  if (!isSystemHistory(data)) throw new Error(historyError("invalid_supervisor_response"))
  if (Date.parse(data.start) !== start * 1000 || Date.parse(data.end) !== end * 1000 || data.bucket_seconds !== bucket) {
    throw new Error(historyError("invalid_supervisor_response"))
  }
  return data
}
