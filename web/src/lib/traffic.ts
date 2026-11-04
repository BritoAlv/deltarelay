import { savings } from "./metrics.js"
import type { RelayRequest, Snapshot, Traffic, TrafficBucket, TrafficSeries } from "./types.js"

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const MAX_RANGE_MS = 90 * DAY_MS

export type TrafficPreset = "24h" | "7d" | "30d" | "90d" | "custom"
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
}

export interface AxisScale {
  min: number
  max: number
  ticks: number[]
}

const presetConfig: Record<Exclude<TrafficPreset, "custom">, { span: number; bucketMs: number; label: string }> = {
  "24h": { span: DAY_MS, bucketMs: HOUR_MS, label: "Last 24 hours" },
  "7d": { span: 7 * DAY_MS, bucketMs: 6 * HOUR_MS, label: "Last 7 days" },
  "30d": { span: 30 * DAY_MS, bucketMs: DAY_MS, label: "Last 30 days" },
  "90d": { span: 90 * DAY_MS, bucketMs: 3 * DAY_MS, label: "Last 90 days" },
}

const bucketCandidates = [HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS]

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
  return bucketCandidates.find((candidate) => spanMs / candidate <= 42) ?? 7 * DAY_MS
}

export function presetRange(preset: Exclude<TrafficPreset, "custom">, now: number): TrafficRange {
  const config = presetConfig[preset]
  const start = alignStart(now - config.span, config.bucketMs)
  return { start, end: now, bucketMs: config.bucketMs, preset, label: config.label }
}

export interface CustomRangeResult {
  range?: TrafficRange
  error?: string
}

export function customRange(startDate: string, endDate: string, now: number): CustomRangeResult {
  const start = parseDateInput(startDate, false)
  const end = parseDateInput(endDate, true)
  if (start === null || end === null) return { error: "Choose a valid start and end date." }
  if (start > end) return { error: "The start date must be on or before the end date." }
  if (end < now - MAX_RANGE_MS || start < now - MAX_RANGE_MS - DAY_MS) return { error: "Custom ranges are limited to the last 90 days." }
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

function addRequest(point: TrafficPoint, request: RelayRequest): void {
  point.requests++
  if (request.state === "cancelled") point.cancelled++
  else if (request.state !== "completed") point.failed++
  point.body += request.transfer.body_bytes
  point.encoded += request.transfer.request_body_bytes_sent
  point.reused += request.transfer.reused_body_bytes
  point.uploadedChunkBytes += request.transfer.uploaded_chunk_bytes
  point.response += request.response_bytes
  point.duration += request.duration_ms
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

function aggregateSeries(series: TrafficSeries, range: TrafficRange): TrafficPoint[] {
  const points = emptyPoints(range)
  const sourceMs = series.bucket_seconds * 1000
  for (const bucket of series.buckets) {
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

function fallbackSeries(requests: RelayRequest[], range: TrafficRange): TrafficPoint[] {
  const points = emptyPoints(range)
  for (const request of requests) {
    if (!request.finished_at || request.state === "running") continue
    const at = Date.parse(request.finished_at)
    if (!Number.isFinite(at) || at < range.start || at > range.end) continue
    const index = Math.max(0, Math.min(points.length - 1, Math.floor((at - range.start) / range.bucketMs)))
    const point = points[index]
    if (point) addRequest(point, request)
  }
  return points
}

function selectSeries(traffic: Traffic, range: TrafficRange): { series: TrafficSeries; source: "hourly" | "daily" } | null {
  const span = range.end - range.start
  const preferDaily = span > 30 * DAY_MS + DAY_MS
  const hourly = traffic.hourly
  const daily = traffic.daily
  if (!preferDaily && hourly.buckets.length > 0) return { series: hourly, source: "hourly" }
  if (daily.buckets.length > 0) return { series: daily, source: "daily" }
  if (hourly.buckets.length > 0) return { series: hourly, source: "hourly" }
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

export function trafficData(snapshot: Snapshot, range: TrafficRange): TrafficData {
  const history = snapshot.history
  const now = Date.parse(snapshot.collected_at)
  if (history.traffic) {
    const selected = selectSeries(history.traffic, range)
    if (selected) {
      const points = aggregateSeries(selected.series, range)
      const retentionMs = selected.series.retention_seconds * 1000
      const nowMs = Number.isFinite(now) ? now : range.end
      const seriesSince = Date.parse(selected.series.since)
      const seriesStart = Math.max(Number.isFinite(seriesSince) ? seriesSince : nowMs - retentionMs, nowMs - retentionMs)
      const coverageStart = Math.max(range.start, seriesStart)
      return {
        points,
        totals: trafficTotals(points),
        coverageStart,
        source: selected.source,
        truncated: range.start < coverageStart - Math.min(range.bucketMs, DAY_MS),
      }
    }
  }
  const points = fallbackSeries(history.recent_requests, range)
  let coverageStart: number | null = null
  for (const request of history.recent_requests) {
    if (!request.finished_at || request.state === "running") continue
    const at = Date.parse(request.finished_at)
    if (!Number.isFinite(at)) continue
    if (coverageStart === null || at < coverageStart) coverageStart = at
  }
  return {
    points,
    totals: trafficTotals(points),
    coverageStart,
    source: "requests",
    truncated: coverageStart !== null && range.start < coverageStart - Math.min(range.bucketMs, DAY_MS),
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

export function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
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
  if (sameDay) return `${formatDate(at)}, ${formatTime(at)} – ${formatTime(end)}`
  return `${formatDate(at)} ${formatTime(at)} – ${formatDate(end)} ${formatTime(end)}`
}

export function formatAxisLabel(at: number, spanMs: number): string {
  if (spanMs > 2 * DAY_MS) return formatDate(at)
  return formatTime(at)
}

export function compositionSegments(point: TrafficPoint): { uploaded: number; reused: number; other: number; overshoot: number } {
  const uploaded = Math.max(0, point.encoded)
  const saved = point.body - point.encoded
  const reused = Math.max(0, Math.min(point.reused, Math.max(0, saved)))
  const other = Math.max(0, saved - reused)
  const overshoot = Math.max(0, point.encoded - point.body)
  return { uploaded, reused, other, overshoot }
}
