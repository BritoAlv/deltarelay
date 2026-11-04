import test from "node:test"
import assert from "node:assert/strict"
import {
  chooseBucketMs,
  compositionSegments,
  customRange,
  dateInputValue,
  DAY_MS,
  formatBucketWindow,
  HOUR_MS,
  MAX_RANGE_MS,
  niceScale,
  presetRange,
  trafficData,
  trafficTotals,
  type TrafficPoint,
} from "../src/lib/traffic.js"
import { makeSnapshot } from "./fixture.js"

const now = Date.parse("2026-10-28T12:15:00Z")

function floorHour(value: number): number {
  const date = new Date(value)
  date.setMinutes(0, 0, 0)
  return date.getTime()
}

function floorDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function point(overrides: Partial<TrafficPoint> = {}): TrafficPoint {
  return { at: now, end: now + HOUR_MS, requests: 1, failed: 0, cancelled: 0, body: 0, encoded: 0, reused: 0, uploadedChunkBytes: 0, response: 0, duration: 0, ...overrides }
}

test("preset ranges align to local boundaries and choose readable bucket sizes", () => {
  const day = presetRange("24h", now)
  assert.equal(day.start, floorHour(now - DAY_MS))
  assert.equal(day.end, now)
  assert.equal(day.bucketMs, HOUR_MS)
  assert.equal(day.label, "Last 24 hours")

  const week = presetRange("7d", now)
  assert.equal(week.start, floorHour(now - 7 * DAY_MS))
  assert.equal(week.bucketMs, 6 * HOUR_MS)

  const month = presetRange("30d", now)
  assert.equal(month.start, floorDay(now - 30 * DAY_MS))
  assert.equal(month.bucketMs, DAY_MS)

  const quarter = presetRange("90d", now)
  assert.equal(quarter.start, floorDay(now - 90 * DAY_MS))
  assert.equal(quarter.bucketMs, 3 * DAY_MS)
  assert.equal(chooseBucketMs(MAX_RANGE_MS), 3 * DAY_MS)
})

test("custom ranges validate dates and stay within ninety days", () => {
  const start = dateInputValue(now - 7 * DAY_MS)
  const end = dateInputValue(now)
  const result = customRange(start, end, now)
  assert.ok(result.range)
  assert.equal(result.range.end, now)
  assert.equal(result.range.bucketMs, 6 * HOUR_MS)
  assert.match(result.range.label, /–/)

  assert.match(customRange(end, start, now).error ?? "", /start date/)
  assert.match(customRange(dateInputValue(now - 100 * DAY_MS), dateInputValue(now - 95 * DAY_MS), now).error ?? "", /90 days/)
  assert.match(customRange("not-a-date", end, now).error ?? "", /valid/)
})

test("traffic data aggregates hourly and daily buckets across ranges", () => {
  const snapshot = makeSnapshot(now)
  const day = trafficData(snapshot, presetRange("24h", now))
  assert.equal(day.source, "hourly")
  assert.equal(day.totals.requests, 72)
  assert.equal(day.totals.failed, 1)
  assert.equal(day.totals.cancelled, 1)
  assert.equal(day.totals.body, snapshot.history.totals.body_bytes)
  assert.equal(day.totals.encoded, snapshot.history.totals.encoded_upload_bytes)
  assert.equal(day.totals.reused, snapshot.history.totals.reused_body_bytes)
  assert.equal(day.truncated, false)
  assert.ok(day.points.length >= 24 && day.points.length <= 26)
  assert.equal(day.points.reduce((sum, entry) => sum + entry.requests, 0), 72)

  const week = trafficData(snapshot, presetRange("7d", now))
  assert.equal(week.source, "hourly")
  assert.equal(week.totals.requests, 78)
  assert.ok(week.points.length >= 28 && week.points.length <= 30)

  const month = trafficData(snapshot, presetRange("30d", now))
  assert.equal(month.source, "hourly")
  assert.equal(month.totals.requests, 101)

  const quarter = trafficData(snapshot, presetRange("90d", now))
  assert.equal(quarter.source, "daily")
  assert.equal(quarter.totals.requests, 161)
  assert.equal(quarter.truncated, false)
})

test("traffic data falls back to retained requests for older gateways", () => {
  const snapshot = makeSnapshot(now)
  const legacy = structuredClone(snapshot)
  delete legacy.history.traffic
  const day = trafficData(legacy, presetRange("24h", now))
  assert.equal(day.source, "requests")
  assert.equal(day.totals.requests, 72)
  assert.equal(day.totals.body, snapshot.history.totals.body_bytes)
  assert.equal(day.truncated, true)

  const week = trafficData(legacy, presetRange("7d", now))
  assert.equal(week.totals.requests, 72)
  assert.equal(week.truncated, true)
})

test("totals and composition preserve savings and negative overshoot", () => {
  const totals = trafficTotals([point({ body: 1_000, encoded: 100, reused: 800, requests: 2, failed: 1, cancelled: 1 })])
  assert.equal(totals.failed, 1)
  assert.equal(totals.cancelled, 1)
  assert.equal(totals.saved, 900)
  assert.equal(totals.reduction, 90)
  assert.equal(totals.reuse, 80)

  const saved = compositionSegments(point({ body: 1_000, encoded: 100, reused: 800 }))
  assert.deepEqual(saved, { uploaded: 100, reused: 800, other: 100, overshoot: 0 })

  const capped = compositionSegments(point({ body: 1_000, encoded: 100, reused: 950 }))
  assert.deepEqual(capped, { uploaded: 100, reused: 900, other: 0, overshoot: 0 })

  const negative = compositionSegments(point({ body: 100, encoded: 150, reused: 20 }))
  assert.deepEqual(negative, { uploaded: 150, reused: 0, other: 0, overshoot: 50 })

  const empty = trafficTotals([])
  assert.equal(empty.reduction, null)
  assert.equal(empty.reuse, null)
})

test("nice scales include zero and cover the data range", () => {
  const scale = niceScale(0, 1_000, 4)
  assert.equal(scale.min, 0)
  assert.ok(scale.max >= 1_000)
  assert.ok(scale.ticks.length >= 3)
  assert.ok(scale.ticks.every((value) => Number.isFinite(value)))

  const negative = niceScale(-100, 900, 4)
  assert.ok(negative.min <= -100)
  assert.ok(negative.max >= 900)

  const flat = niceScale(0, 0, 4)
  assert.ok(flat.max > 0)
  assert.ok(flat.ticks.length >= 2)
})

test("bucket windows describe hours and days without hardcoded locale text", () => {
  const hour = formatBucketWindow(now, now + HOUR_MS, HOUR_MS)
  assert.ok(hour.length > 0)
  assert.match(hour, /–/)
  const day = formatBucketWindow(now, now + DAY_MS, DAY_MS)
  assert.match(day, /–/)
})
