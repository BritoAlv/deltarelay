import { counters, nonnegativeInteger, object, timestamp } from "./validation.js"
import { emptyTotals, type SessionView } from "./metrics.js"
import type { RelayRequest, Snapshot } from "./types.js"

export interface APIKey { id: string; name: string }
export interface UsageMeasurement {
  version: 1
  state: "complete" | "partial" | "unavailable"
  source?: string
  reason?: string
  model?: string
  response_model?: string
  finish_reason?: string
  messages?: number
  tools?: number
  max_output_tokens?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  input_audio_tokens?: number
  output_audio_tokens?: number
  first_response_ms?: number
}

export interface UsageAggregate {
  measured_requests: number
  complete_requests: number
  input_requests: number
  output_requests: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  latest_context: number | null
  peak_context: number | null
  latest_context_at?: string
}

export interface UsageSession extends SessionView {
  api_keys: APIKey[]
  unknown_key_requests: number
  metrics: UsageAggregate
}

export interface UsageReport {
  version: 1
  since: string
  keys: (APIKey & { requests: number })[]
  requests: number
  session_count: number
  unattributed_requests: number
  unknown_key_requests: number
  metrics: UsageAggregate
  sessions: UsageSession[]
  incomplete_history: boolean
  series?: UsageSeries
}

/** One model inside a bucket, or one range total in `UsageSeries.models`. */
export interface UsageSeriesModel {
  model: string
  requests: number
  input_tokens: number | null
  output_tokens: number | null
}

export interface UsageSeriesPoint {
  start: string
  requests: number
  measured_requests: number
  input_tokens: number | null
  output_tokens: number | null
  peak_context: number | null
  models: UsageSeriesModel[]
}

export interface UsageSeries {
  bucket_ms: number
  models: UsageSeriesModel[]
  points: UsageSeriesPoint[]
}

export type UsageMetric = "total" | "input" | "output"

export interface UsageFilter { start?: number; end?: number; bucket?: number; key?: string; host?: string; session?: string }
const numericFields = ["messages", "tools", "max_output_tokens", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "input_audio_tokens", "output_audio_tokens", "first_response_ms"] as const
const aggregateFields = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "latest_context", "peak_context"] as const
export const validKeyID = (v: unknown) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v)
export const isAPIKey = (v: unknown): v is APIKey => object(v) && validKeyID(v.id) && typeof v.name === "string" && v.name.length > 0 && v.name.length <= 320
export function isUsageMeasurement(v: unknown): v is UsageMeasurement {
  return object(v) && v.version === 1 && ["complete", "partial", "unavailable"].includes(String(v.state)) &&
    numericFields.every((key) => v[key] === undefined || nonnegativeInteger(v[key]) && Number.isSafeInteger(v[key])) &&
    ["source", "reason", "model", "response_model", "finish_reason"].every((key) => v[key] === undefined || typeof v[key] === "string" && (v[key] as string).length <= 160)
}
function isAggregate(v: unknown): v is UsageAggregate {
  return object(v) && counters(v, ["measured_requests", "complete_requests", "input_requests", "output_requests"]) &&
    aggregateFields.every((key) => v[key] === null || nonnegativeInteger(v[key]) && Number.isSafeInteger(v[key])) &&
    (v.latest_context_at === undefined || timestamp(v.latest_context_at))
}
function nullableCounter(v: unknown): v is number | null {
  return v === null || nonnegativeInteger(v) && Number.isSafeInteger(v)
}
function isSeriesModel(v: unknown): v is UsageSeriesModel {
  return object(v) && typeof v.model === "string" && v.model.length > 0 && v.model.length <= 160 &&
    counters(v, ["requests"]) && nullableCounter(v.input_tokens) && nullableCounter(v.output_tokens)
}
function isSeries(v: unknown): v is UsageSeries {
  return object(v) && nonnegativeInteger(v.bucket_ms) && Number.isSafeInteger(v.bucket_ms) && v.bucket_ms > 0 &&
    Array.isArray(v.models) && v.models.length <= 8 && v.models.every(isSeriesModel) &&
    Array.isArray(v.points) && v.points.length <= 200 && v.points.every((point) => object(point) &&
      timestamp(point.start) && counters(point, ["requests", "measured_requests"]) &&
      nullableCounter(point.input_tokens) && nullableCounter(point.output_tokens) && nullableCounter(point.peak_context) &&
      Array.isArray(point.models) && point.models.length <= 8 && point.models.every(isSeriesModel))
}
export function isUsageReport(v: unknown): v is UsageReport {
  return object(v) && v.version === 1 && timestamp(v.since) && typeof v.incomplete_history === "boolean" &&
    counters(v, ["requests", "session_count", "unattributed_requests", "unknown_key_requests"]) && isAggregate(v.metrics) &&
    (v.series === undefined || isSeries(v.series)) &&
    Array.isArray(v.keys) && v.keys.every((key) => object(key) && nonnegativeInteger(key.requests) && isAPIKey(key)) &&
    Array.isArray(v.sessions) && v.sessions.every((s) => object(s) && typeof s.id === "string" && typeof s.upstream === "string" &&
      timestamp(s.started_at) && timestamp(s.updated_at) && Array.isArray(s.hosts) && s.hosts.every((h) => typeof h === "string") &&
      counters(s, ["requests", "active", "failed", "cancelled", "body_bytes", "encoded_upload_bytes", "uploaded_chunk_bytes", "reused_body_bytes", "response_bytes", "duration_ms", "unknown_key_requests", "last_status"]) &&
      Array.isArray(s.api_keys) && s.api_keys.every(isAPIKey) && isAggregate(s.metrics))
}

export function usageParams(filter: UsageFilter): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") params.set(key, String(value))
  // An explicit empty session means unattributed requests, not all sessions.
  if (filter.session === "") params.set("session", "")
  return params
}

export async function fetchUsage(filter: UsageFilter, signal: AbortSignal): Promise<UsageReport> {
  const response = await fetch(`/api/dashboard/usage?${usageParams(filter)}`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  if (!response.ok) throw new Error("Local usage could not be loaded. Refresh to retry; no history was removed.")
  const value: unknown = await response.json()
  if (!isUsageReport(value)) throw new Error("The gateway returned incompatible usage metrics. Rebuild and restart the local gateway.")
  return value
}

export function matchesUsage(request: RelayRequest, filter: UsageFilter): boolean {
  const at = Date.parse(request.started_at)
  return (!filter.host || request.host === filter.host) &&
    (filter.start === undefined || at >= filter.start) && (filter.end === undefined || at < filter.end) &&
    (filter.session === undefined || request.session_id === filter.session) &&
    (!filter.key || (filter.key === "unknown" ? !request.api_key : request.api_key?.id === filter.key))
}

export const tokenNumber = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString()
export const compactTokens = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })
export const keyLabels = (s: UsageSession): string[] => [...s.api_keys.map((key) => key.name), ...(s.unknown_key_requests ? ["Unknown credential"] : [])]
export const keyNames = (s: UsageSession) => keyLabels(s).join(", ") || "Unknown credential"
export function keySummary(s: UsageSession): string {
  const names = [...s.api_keys.map((key) => key.name), ...(s.unknown_key_requests ? ["Unknown credential"] : [])]
  if (!names.length) return "Unknown credential"
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`
}
export function emptyUsage(): UsageAggregate {
  return { measured_requests: 0, complete_requests: 0, input_requests: 0, output_requests: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, latest_context: null, peak_context: null }
}

export function addUsage(a: UsageAggregate, m: UsageMeasurement | undefined, at: string) {
  if (!m) return
  if (m.input_tokens !== undefined || m.output_tokens !== undefined) a.measured_requests++
  if (m.state === "complete") a.complete_requests++
  if (m.input_tokens !== undefined) {
    a.input_requests++
    if (!a.latest_context_at || Date.parse(at) >= Date.parse(a.latest_context_at)) { a.latest_context = m.input_tokens; a.latest_context_at = at }
    a.peak_context = Math.max(a.peak_context ?? 0, m.input_tokens)
  }
  if (m.output_tokens !== undefined) a.output_requests++
  for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const) {
    if (m[key] !== undefined) a[key] = Math.min(Number.MAX_SAFE_INTEGER, (a[key] ?? 0) + m[key]!)
  }
}

// Compatibility for full snapshots (and offline fixtures). Compact production
// snapshots use the server projection, never load all request history in-browser.
interface SeriesToken {
  requests: number
  input: number | null
  output: number | null
}
interface SeriesBucket {
  start: number
  requests: number
  measured: number
  input: number | null
  output: number | null
  peak: number | null
  models: Map<string, SeriesToken>
}
interface MutableUsageSeries {
  start: number
  bucketMs: number
  buckets: SeriesBucket[]
  models: Map<string, SeriesToken>
}
function emptySeriesToken(): SeriesToken {
  return { requests: 0, input: null, output: null }
}
function addCounter(current: number | null, value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (current ?? 0) + value)
}
function addSeriesTokens(target: SeriesToken, m: UsageMeasurement): void {
  if (m.input_tokens !== undefined) target.input = addCounter(target.input, m.input_tokens)
  if (m.output_tokens !== undefined) target.output = addCounter(target.output, m.output_tokens)
}
function seriesModelName(m: UsageMeasurement): string {
  return m.model || m.response_model || "Unknown model"
}
function seriesTokenTotal(value: SeriesToken): number {
  return (value.input ?? 0) + (value.output ?? 0)
}
function mutableUsageSeries(filter: UsageFilter): MutableUsageSeries | null {
  const { start, end, bucket } = filter
  if (start === undefined || end === undefined || bucket === undefined || !Number.isSafeInteger(bucket) || bucket <= 0 || end <= start) return null
  const count = Math.min(200, Math.max(1, Math.ceil((end - start) / bucket)))
  return {
    start, bucketMs: bucket, models: new Map(),
    buckets: Array.from({ length: count }, (_, index) => ({
      start: start + index * bucket, requests: 0, measured: 0, input: null, output: null, peak: null, models: new Map(),
    })),
  }
}
function finalizeUsageSeries(series: MutableUsageSeries): UsageSeries {
  const ordered = [...series.models.entries()].sort((a, b) => seriesTokenTotal(b[1]) - seriesTokenTotal(a[1]) || a[0].localeCompare(b[0]))
  const top = ordered.slice(0, 5)
  const topNames = new Set(top.map(([name]) => name))
  const models: UsageSeriesModel[] = top.map(([name, value]) => ({ model: name, requests: value.requests, input_tokens: value.input, output_tokens: value.output }))
  const other = emptySeriesToken()
  for (const [, value] of ordered.slice(5)) {
    other.requests += value.requests
    if (value.input !== null) other.input = addCounter(other.input, value.input)
    if (value.output !== null) other.output = addCounter(other.output, value.output)
  }
  if (other.requests) models.push({ model: "Other models", requests: other.requests, input_tokens: other.input, output_tokens: other.output })
  return {
    bucket_ms: series.bucketMs,
    models,
    points: series.buckets.map((bucket) => {
      const pointModels: UsageSeriesModel[] = []
      for (const [name] of top) {
        const token = bucket.models.get(name)
        if (token) pointModels.push({ model: name, requests: token.requests, input_tokens: token.input, output_tokens: token.output })
      }
      if (other.requests) {
        const tail = emptySeriesToken()
        for (const [name, value] of bucket.models) {
          if (topNames.has(name)) continue
          tail.requests += value.requests
          if (value.input !== null) tail.input = addCounter(tail.input, value.input)
          if (value.output !== null) tail.output = addCounter(tail.output, value.output)
        }
        if (tail.requests) pointModels.push({ model: "Other models", requests: tail.requests, input_tokens: tail.input, output_tokens: tail.output })
      }
      return {
        start: new Date(bucket.start).toISOString(), requests: bucket.requests, measured_requests: bucket.measured,
        input_tokens: bucket.input, output_tokens: bucket.output, peak_context: bucket.peak, models: pointModels,
      }
    }),
  }
}

export function usageFromSnapshot(snapshot: Snapshot, filter: UsageFilter): UsageReport {
  const result: UsageReport = { version: 1, since: snapshot.history.since, keys: [], requests: 0, session_count: 0, unattributed_requests: 0, unknown_key_requests: 0, metrics: emptyUsage(), sessions: [], incomplete_history: snapshot.history.dropped_requests > 0 }
  const keys = new Map<string, APIKey & { requests: number }>()
  const sessions = new Map<string, UsageSession>()
  const series = mutableUsageSeries(filter)
  for (const r of snapshot.history.recent_requests) {
    if (r.api_key && (!filter.host || r.host === filter.host)) {
      const key = keys.get(r.api_key.id) ?? { ...r.api_key, requests: 0 }
      key.requests++
      keys.set(key.id, key)
    }
    if (!matchesUsage(r, filter)) continue
    result.requests++
    if (series) {
      const at = Date.parse(r.started_at)
      const index = Math.min(series.buckets.length - 1, Math.max(0, Math.floor((at - series.start) / series.bucketMs)))
      const bucket = series.buckets[index]!
      bucket.requests++
      if (r.usage) {
        if (r.usage.input_tokens !== undefined) {
          bucket.input = addCounter(bucket.input, r.usage.input_tokens)
          bucket.peak = Math.max(bucket.peak ?? 0, r.usage.input_tokens)
        }
        if (r.usage.output_tokens !== undefined) bucket.output = addCounter(bucket.output, r.usage.output_tokens)
        if (r.usage.input_tokens !== undefined || r.usage.output_tokens !== undefined) {
          bucket.measured++
          const name = seriesModelName(r.usage)
          const model = bucket.models.get(name) ?? emptySeriesToken()
          model.requests++
          addSeriesTokens(model, r.usage)
          bucket.models.set(name, model)
          const total = series.models.get(name) ?? emptySeriesToken()
          total.requests++
          addSeriesTokens(total, r.usage)
          series.models.set(name, total)
        }
      }
    }
    if (!r.session_id) result.unattributed_requests++
    if (!r.api_key) result.unknown_key_requests++
    addUsage(result.metrics, r.usage, r.started_at)
    const s = sessions.get(r.session_id) ?? { ...emptyTotals(), id: r.session_id, hosts: [], api_keys: [], unknown_key_requests: 0, clients: [], metrics: emptyUsage(), started_at: r.started_at, updated_at: r.started_at, upstream: r.upstream, last_status: 0, last_request_id: r.id }
    const host = r.host || "local"
    if (!s.hosts.includes(host)) s.hosts.push(host)
    if (r.api_key) { if (!s.api_keys.some((key) => key.id === r.api_key!.id)) s.api_keys.push(r.api_key) } else s.unknown_key_requests++
    s.requests++
    if (r.state === "running") s.active++
    if (r.state === "failed" || r.state === "interrupted") s.failed++
    if (r.state === "cancelled") s.cancelled++
    s.body_bytes += r.transfer.body_bytes
    s.encoded_upload_bytes += r.transfer.request_body_bytes_sent
    s.uploaded_chunk_bytes += r.transfer.uploaded_chunk_bytes
    s.reused_body_bytes += r.transfer.reused_body_bytes
    s.response_bytes += r.response_bytes
    s.duration_ms += r.duration_ms
    if (Date.parse(r.started_at) < Date.parse(s.started_at)) s.started_at = r.started_at
    if (Date.parse(r.finished_at ?? r.started_at) >= Date.parse(s.updated_at)) {
      s.updated_at = r.finished_at ?? r.started_at; s.upstream = r.upstream; s.last_status = r.status; s.last_error = r.error_code; s.last_request_id = r.id
    }
    addUsage(s.metrics, r.usage, r.started_at)
    sessions.set(s.id, s)
  }
  result.sessions = [...sessions.values()].sort((a,b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  result.session_count = result.sessions.filter((s) => s.id !== "").length
  result.keys = [...keys.values()].sort((a,b) => a.name.localeCompare(b.name))
  if (series) result.series = finalizeUsageSeries(series)
  return result
}
