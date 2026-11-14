import { savings } from "./metrics.js"
import type { RelayRequest, Snapshot, Traffic, TrafficBucket, TrafficSeries } from "./types.js"

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const SECOND_MS = 1_000
export const MINUTE_MS = 60_000

export type TrafficPreset = "24h" | "7d" | "30d" | "90d" | "last" | "custom" | "datetime"
export type TrafficFixedPreset = Exclude<TrafficPreset, "last" | "custom" | "datetime">
export type TrafficLastUnit = "seconds" | "minutes" | "hours" | "days"
export const trafficLastUnits: readonly TrafficLastUnit[] = ["seconds", "minutes", "hours", "days"]
export type TrafficView = "composition" | "trends"

export interface TrafficRange {
  start: number
  end: number
  bucketMs: number
  preset: TrafficPreset
  label: string
}

export interface TrafficPoint {
  at: number
  end: number
  requests: number
  failed: number
  cancelled: number
  body: number
  encoded: number
  reused: number
  uploadedChunkBytes: number
  response: number
  duration: number
}

export interface TrafficTotals {
  requests: number
  failed: number
  cancelled: number
  body: number
  encoded: number
  reused: number
  uploadedChunkBytes: number
  response: number
  duration: number
  saved: number
  reduction: number | null
  reuse: number | null
}

export interface TrafficData {
  points: TrafficPoint[]
  totals: TrafficTotals
  coverageStart: number | null
  source: "hourly" | "daily" | "requests" | "none"
  truncated: boolean
  /** Exact windows cannot recover request timestamps lost by older bounded histories. */
  incomplete?: boolean
}

export interface AxisScale {
  min: number
  max: number
  ticks: number[]
}

const presetConfig: Record<TrafficFixedPreset, { span: number; bucketMs: number; label: string }> = {
  "24h": { span: DAY_MS, bucketMs: HOUR_MS, label: "Last 24 hours" },
  "7d": { span: 7 * DAY_MS, bucketMs: 6 * HOUR_MS, label: "Last 7 days" },
  "30d": { span: 30 * DAY_MS, bucketMs: DAY_MS, label: "Last 30 days" },
  "90d": { span: 90 * DAY_MS, bucketMs: 3 * DAY_MS, label: "Last 90 days" },
}

const bucketCandidates = [SECOND_MS, 5 * SECOND_MS, 15 * SECOND_MS, MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS]

function startOfLocalHour(value: number): number {
  const date = new Date(value)
  date.setMinutes(0, 0, 0)
  return date.getTime()
}

function startOfLocalDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function alignStart(value: number, bucketMs: number): number {
  if (bucketMs >= DAY_MS) return startOfLocalDay(value)
  return startOfLocalHour(value)
}

export function chooseBucketMs(spanMs: number): number {
  return bucketCandidates.find((candidate) => spanMs / candidate <= 42) ?? Math.ceil(spanMs / (42 * DAY_MS)) * DAY_MS
}

export function presetRange(preset: TrafficFixedPreset, now: number): TrafficRange {
  const config = presetConfig[preset]
  const start = alignStart(now - config.span, config.bucketMs)
  return { start, end: now, bucketMs: config.bucketMs, preset, label: config.label }
}

const lastRangeLimit = 3650 * DAY_MS

export interface CustomRangeResult {
  range?: TrafficRange
  error?: string
}

export function lastRange(amount: number, unit: TrafficLastUnit, now: number): CustomRangeResult {
  if (!Number.isSafeInteger(amount) || amount < 1) return { error: "Choose a whole number of seconds, minutes, hours, or days greater than zero." }
  const span = amount * ({ seconds: SECOND_MS, minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS }[unit])
  if (span > lastRangeLimit) return { error: "Choose a lookback of 3,650 days or less." }
  const bucketMs = chooseBucketMs(span)
  const start = now - span
  const singular = amount === 1 ? unit.slice(0, -1) : unit
  return { range: { start, end: now, bucketMs, preset: "last", label: `Last ${amount} ${singular}` } }
}

export function customRange(startDate: string, endDate: string, now: number): CustomRangeResult {
  const start = parseDateInput(startDate, false)
  const end = parseDateInput(endDate, true)
  if (start === null || end === null) return { error: "Choose a valid start and end date." }
  if (start > end) return { error: "The start date must be on or before the end date." }
  const boundedEnd = Math.min(end, now)
  if (boundedEnd < start) return { error: "The selected range has not started yet." }
  const bucketMs = chooseBucketMs(boundedEnd - start)
  const startLabel = formatDate(start)
  const endLabel = formatDate(boundedEnd)
  return {
    range: {
      start,
      end: boundedEnd,
      bucketMs,
      preset: "custom",
      label: startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`,
    },
  }
}

/** Explicit formats only: never guess whether 01/02 means January or February. */
export function parseDateTime(input: string): number | null {
  const value = input.trim()
  if (/^\d{10}$|^\d{13}$/.test(value)) {
    const at = Number(value) * (value.length === 10 ? SECOND_MS : 1)
    return Number.isFinite(new Date(at).getTime()) ? at : null
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) return null
  const [, y, mo, d, h, mi, s = "0", fraction = "", zone = ""] = match
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(year!, month! - 1, day!)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day || hour! > 23 || minute! > 59 || second! > 59) return null
  if (zone && zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, "0"))
  if (zone) {
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s.padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}${zone}`
    const at = Date.parse(iso)
    return Number.isFinite(at) ? at : null
  }
  const local = new Date(0)
  local.setFullYear(year!, month! - 1, day!)
  local.setHours(hour!, minute!, second!, milliseconds)
  // Reject nonexistent local times (including the spring DST clock jump).
  if (local.getFullYear() !== year || local.getMonth() !== month! - 1 || local.getDate() !== day || local.getHours() !== hour || local.getMinutes() !== minute) return null
  return local.getTime()
}

export function dateTimeRange(startValue: string, endValue: string, now: number): CustomRangeResult {
  const start = parseDateTime(startValue)
  const end = parseDateTime(endValue)
  if (start === null || end === null) return { error: "Enter valid start and end timestamps using one of the formats below." }
  if (start >= end) return { error: "The start timestamp must be before the end timestamp." }
  if (start >= now) return { error: "The selected range has not started yet." }
  const boundedEnd = Math.min(end, now)
  return { range: { start, end: boundedEnd, bucketMs: chooseBucketMs(boundedEnd - start), preset: "datetime", label: `${formatDateTime(start)} – ${formatDateTime(boundedEnd)}` } }
}

export function formatDateTime(value: number): string {
  return new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", ...(value % SECOND_MS ? { fractionalSecondDigits: 3 as const } : {}), hour12: false, timeZoneName: "short" })
}

export function requestInRange(request: RelayRequest, range: TrafficRange): boolean {
  const at = request.finished_at ? Date.parse(request.finished_at) : NaN
  return request.state !== "running" && at >= range.start && at < range.end
}

function preciseTrafficData(snapshot: Snapshot, range: TrafficRange, host: string): TrafficData {
  const points = emptyPoints(range)
  for (const request of snapshot.history.recent_requests) {
    if ((host && (request.host || "local") !== host) || !requestInRange(request, range)) continue
    const at = Date.parse(request.finished_at!)
    const index = Math.min(points.length - 1, Math.floor((at - range.start) / range.bucketMs))
    const point = points[index]!
    point.requests++
    point.failed += Number(request.state === "failed" || request.state === "interrupted")
    point.cancelled += Number(request.state === "cancelled")
    point.body += request.transfer.body_bytes
    point.encoded += request.transfer.request_body_bytes_sent
    point.reused += request.transfer.reused_body_bytes
    point.uploadedChunkBytes += request.transfer.uploaded_chunk_bytes
    point.response += request.response_bytes
    point.duration += request.duration_ms
  }
  const since = Date.parse(snapshot.history.since)
  const coverageStart = Number.isFinite(since) ? Math.max(since, range.start) : range.start
  return { points, totals: trafficTotals(points), source: "requests", coverageStart, truncated: coverageStart > range.start,
    incomplete: snapshot.history.dropped_requests > 0 }
}

export function dateInputValue(value: number): string {
  const date = new Date(value)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function parseDateInput(value: string, endOfDay: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

function emptyPoint(at: number, end: number): TrafficPoint {
  return { at, end, requests: 0, failed: 0, cancelled: 0, body: 0, encoded: 0, reused: 0, uploadedChunkBytes: 0, response: 0, duration: 0 }
}

function addBucket(point: TrafficPoint, bucket: TrafficBucket): void {
  point.requests += bucket.requests
  point.failed += bucket.failed
  point.cancelled += bucket.cancelled
  point.body += bucket.body_bytes
  point.encoded += bucket.encoded_upload_bytes
  point.reused += bucket.reused_body_bytes
  point.uploadedChunkBytes += bucket.uploaded_chunk_bytes
  point.response += bucket.response_bytes
  point.duration += bucket.duration_ms
}

function pointCount(range: TrafficRange): number {
  return Math.max(1, Math.min(200, Math.ceil((range.end - range.start) / range.bucketMs)))
}

function emptyPoints(range: TrafficRange): TrafficPoint[] {
  const count = pointCount(range)
  return Array.from({ length: count }, (_, index) => {
    const at = range.start + index * range.bucketMs
    return emptyPoint(at, Math.min(at + range.bucketMs, range.end))
  })
}

function aggregateSeries(series: TrafficSeries, range: TrafficRange, host: string): TrafficPoint[] {
  const points = emptyPoints(range)
  const sourceMs = series.bucket_seconds * 1000
  for (const bucket of series.buckets) {
    if (host && (bucket.host || "local") !== host) continue
    const at = Date.parse(bucket.start)
    if (!Number.isFinite(at)) continue
    if (at >= range.end) continue
    if (at + sourceMs <= range.start) continue
    const index = Math.max(0, Math.min(points.length - 1, Math.floor((Math.max(at, range.start) - range.start) / range.bucketMs)))
    const point = points[index]
    if (point) addBucket(point, bucket)
  }
  return points
}

function selectSeries(traffic: Traffic, range: TrafficRange, host: string): { series: TrafficSeries; source: "hourly" | "daily" } | null {
  const span = range.end - range.start
  const preferDaily = span > 30 * DAY_MS + DAY_MS
  const has = (series: TrafficSeries) => series.buckets.some((bucket) => !host || (bucket.host || "local") === host)
  const hourly = has(traffic.hourly) ? traffic.hourly : null
  const daily = has(traffic.daily) ? traffic.daily : null
  if (!preferDaily && hourly) return { series: hourly, source: "hourly" }
  if (daily) return { series: daily, source: "daily" }
  if (hourly) return { series: hourly, source: "hourly" }
  return null
}

export function trafficTotals(points: TrafficPoint[]): TrafficTotals {
  const totals = points.reduce((sum, point) => {
    sum.requests += point.requests
    sum.failed += point.failed
    sum.cancelled += point.cancelled
    sum.body += point.body
    sum.encoded += point.encoded
    sum.reused += point.reused
    sum.uploadedChunkBytes += point.uploadedChunkBytes
    sum.response += point.response
    sum.duration += point.duration
    return sum
  }, { requests: 0, failed: 0, cancelled: 0, body: 0, encoded: 0, reused: 0, uploadedChunkBytes: 0, response: 0, duration: 0 })
  return {
    ...totals,
    saved: totals.body - totals.encoded,
    reduction: savings(totals.body, totals.encoded),
    reuse: totals.body > 0 ? totals.reused / totals.body * 100 : null,
  }
}

export function trafficData(snapshot: Snapshot, range: TrafficRange, host = ""): TrafficData {
  // Relative and pasted ranges keep exact boundaries; hourly/daily aggregates
  // cannot answer sub-hour questions without including unrelated requests.
  if (range.preset === "last" || range.preset === "datetime") return preciseTrafficData(snapshot, range, host)
  const history = snapshot.history
  const now = Date.parse(snapshot.collected_at)
  const selected = selectSeries(history.traffic, range, host)
  if (selected) {
    const points = aggregateSeries(selected.series, range, host)
    const retentionMs = selected.series.retention_seconds * 1000
    const nowMs = Number.isFinite(now) ? now : range.end
    const seriesSince = Date.parse(selected.series.since)
    const seriesStart = retentionMs > 0
      ? Math.max(Number.isFinite(seriesSince) ? seriesSince : nowMs - retentionMs, nowMs - retentionMs)
      : Number.isFinite(seriesSince) ? seriesSince : nowMs
    const hostStart = host
      ? Math.min(...selected.series.buckets.filter((bucket) => (bucket.host || "local") === host).map((bucket) => Date.parse(bucket.start)).filter(Number.isFinite))
      : seriesStart
    const coverageStart = Math.max(range.start, Number.isFinite(hostStart) ? hostStart : seriesStart)
    return {
      points,
      totals: trafficTotals(points),
      coverageStart,
      source: selected.source,
      truncated: range.start < coverageStart - Math.min(range.bucketMs, DAY_MS),
    }
  }
  const points = emptyPoints(range)
  return {
    points,
    totals: trafficTotals(points),
    coverageStart: null,
    source: "none",
    truncated: false,
  }
}

export function niceNumber(value: number, round: boolean): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const fraction = value / 10 ** exponent
  let nice: number
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * 10 ** exponent
}

export function niceScale(minValue: number, maxValue: number, target = 4): AxisScale {
  let min = Math.min(0, minValue)
  let max = Math.max(0, maxValue)
  if (max - min < 1) max = min + 1
  const range = niceNumber(max - min, false)
  const step = niceNumber(range / Math.max(1, target - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = niceMin; value <= niceMax + step * 0.5; value += step) ticks.push(value)
  return { min: niceMin, max: niceMax, ticks }
}

export function formatDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function formatTime(value: number, seconds = false): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" as const } : {}), hour12: false })
}

export function formatBucketWindow(at: number, end: number, bucketMs: number): string {
  if (bucketMs >= DAY_MS) {
    const startDate = formatDate(at)
    const endDate = formatDate(end - 1)
    return startDate === endDate ? startDate : `${startDate} – ${endDate}`
  }
  const start = new Date(at)
  const finish = new Date(end)
  const sameDay = start.toDateString() === finish.toDateString()
  const seconds = bucketMs < MINUTE_MS
  if (sameDay) return `${formatDate(at)}, ${formatTime(at, seconds)} – ${formatTime(end, seconds)}`
  return `${formatDate(at)} ${formatTime(at, seconds)} – ${formatDate(end)} ${formatTime(end, seconds)}`
}

export function formatAxisLabel(at: number, spanMs: number): string {
  if (spanMs > 2 * DAY_MS) return formatDate(at)
  return formatTime(at, spanMs <= 10 * MINUTE_MS)
}

export function compositionSegments(point: TrafficPoint): { uploaded: number; reused: number; other: number; overshoot: number } {
  const uploaded = Math.max(0, point.encoded)
  const saved = point.body - point.encoded
  const reused = Math.max(0, Math.min(point.reused, Math.max(0, saved)))
  const other = Math.max(0, saved - reused)
  const overshoot = Math.max(0, point.encoded - point.body)
  return { uploaded, reused, other, overshoot }
}
