import test from "node:test"
import assert from "node:assert/strict"
import {
  chooseBucketMs,
  compositionSegments,
  customRange,
  dateTimeRange,
  parseDateTime,
  dateInputValue,
  DAY_MS,
  formatBucketWindow,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  lastRange,
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
  assert.equal(chooseBucketMs(90 * DAY_MS), 3 * DAY_MS)
})

test("relative ranges keep exact boundaries for seconds, minutes, hours, and days", () => {
  const hours = lastRange(6, "hours", now)
  assert.ok(hours.range)
  assert.equal(hours.range.start, now - 6 * HOUR_MS)
  assert.equal(hours.range.end, now)
  assert.equal(hours.range.bucketMs, 15 * MINUTE_MS)
  assert.equal(hours.range.preset, "last")
  assert.equal(hours.range.label, "Last 6 hours")

  const day = lastRange(1, "days", now)
  assert.ok(day.range)
  assert.equal(day.range.start, now - DAY_MS)
  assert.equal(day.range.label, "Last 1 day")

  const days = lastRange(45, "days", now)
  assert.ok(days.range)
  assert.equal(days.range.bucketMs, chooseBucketMs(45 * DAY_MS))
  assert.equal(days.range.label, "Last 45 days")

  assert.match(lastRange(0, "hours", now).error ?? "", /greater than zero/)
  assert.match(lastRange(-2, "days", now).error ?? "", /greater than zero/)
  assert.match(lastRange(1.5, "hours", now).error ?? "", /whole number/)
  assert.match(lastRange(4000, "days", now).error ?? "", /3,650 days/)
  for (const [unit, span] of [["seconds", SECOND_MS], ["minutes", MINUTE_MS]] as const) {
    const result = lastRange(30, unit, now).range!
    assert.equal(result.start, now - 30 * span)
    assert.equal(result.end, now)
    assert.equal(result.label, `Last 30 ${unit}`)
    assert.ok(result.bucketMs <= span)
  }
  assert.match(lastRange(1, "seconds", now).range!.label, /Last 1 second$/)
  const long = lastRange(3650, "days", now).range!
  assert.ok((long.end - long.start) / long.bucketMs <= 42, "long ranges do not collapse later data into the final chart bucket")
})

test("pasted timestamps accept explicit formats and reject ambiguous or impossible dates", () => {
  assert.equal(parseDateTime("2026-10-28T12:15:00Z"), now)
  assert.equal(parseDateTime(" 2026-10-28T14:15:00+02:00 "), now)
  assert.equal(parseDateTime("2026-10-28 07:15:00-05:00"), now)
  assert.equal(parseDateTime("2026-10-28T12:15:00.123456789Z"), now + 123)
  assert.equal(parseDateTime(String(now / 1000)), now)
  assert.equal(parseDateTime(String(now)), now)
  assert.equal(parseDateTime("2026-10-28 12:15:00"), new Date(2026, 9, 28, 12, 15).getTime())
  assert.equal(parseDateTime("2026-10-28T12:15"), new Date(2026, 9, 28, 12, 15).getTime())
  assert.notEqual(parseDateTime("2024-02-29T12:00:00Z"), null)
  for (const invalid of ["2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-13-01T12:00:00Z", "2026-00-01T12:00:00Z", "2026-01-00T12:00:00Z", "2026-10-28T24:15:00Z", "2026-10-28T12:60:00Z", "2026-10-28T12:15:60Z", "2026-10-28T12:15:00+25:00", "10/11/2026 12:00", "2026-10-28", "not-a-date"]) {
    assert.equal(parseDateTime(invalid), null, invalid)
  }
  const start = new Date(now - 10_000).toISOString()
  const end = new Date(now).toISOString()
  const range = dateTimeRange(start, end, now).range!
  assert.equal(range.start, now - 10_000)
  assert.equal(range.end, now)
  assert.equal(range.bucketMs, SECOND_MS)
  assert.match(dateTimeRange(end, start, now).error!, /before/)
  assert.match(dateTimeRange(start, start, now).error!, /before/)
  assert.match(dateTimeRange("bad", end, now).error!, /valid/)
  assert.equal(dateTimeRange(start, new Date(now + DAY_MS).toISOString(), now).range!.end, now)
})

test("short and pasted ranges use finished request timestamps, never an entire aggregate hour", () => {
  const snapshot = makeSnapshot(now)
  const original = snapshot.history.recent_requests[0]!
  snapshot.history.recent_requests = [-60_001, -60_000, -30_000, -1, 0].map((offset, index) => ({
    ...original, id: `precise-${index}`, sequence: index + 1, host: index === 2 ? "beta" : "alpha",
    finished_at: new Date(now + offset).toISOString(), state: "completed",
    transfer: { ...original.transfer, body_bytes: 1000, request_body_bytes_sent: 100 },
  }))
  const range = lastRange(60, "seconds", now).range!
  const data = trafficData(snapshot, range)
  assert.equal(data.source, "requests")
  assert.equal(data.totals.requests, 3, "start is inclusive and end is exclusive")
  assert.equal(data.totals.body, 3000)
  assert.equal(data.totals.encoded, 300)
  assert.equal(data.totals.saved, 2700)
  assert.equal(data.points.reduce((sum, point) => sum + point.requests, 0), 3)
  assert.equal(trafficData(snapshot, range, "alpha").totals.requests, 2)
  const pasted = dateTimeRange(new Date(range.start).toISOString(), new Date(range.end).toISOString(), now).range!
  assert.deepEqual(trafficData(snapshot, pasted).totals, data.totals)
  snapshot.history.dropped_requests = 5
  assert.equal(trafficData(snapshot, range).incomplete, true)
})

test("local pasted dates validate daylight-saving transitions and explicit offsets disambiguate repeated times", () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = "America/New_York"
    assert.equal(parseDateTime("2026-03-08 02:30:00"), null, "nonexistent local wall-clock time")
    assert.equal(parseDateTime("2026-03-08 03:30:00"), Date.parse("2026-03-08T07:30:00Z"))
    const first = parseDateTime("2026-11-01T01:30:00-04:00")!
    const repeated = parseDateTime("2026-11-01T01:30:00-05:00")!
    assert.equal(repeated - first, HOUR_MS)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test("custom ranges validate dates without a retention window", () => {
  const start = dateInputValue(now - 7 * DAY_MS)
  const end = dateInputValue(now)
  const result = customRange(start, end, now)
  assert.ok(result.range)
  assert.equal(result.range.end, now)
  assert.equal(result.range.bucketMs, 6 * HOUR_MS)
  assert.match(result.range.label, /–/)

  assert.match(customRange(end, start, now).error ?? "", /start date/)
  const older = customRange(dateInputValue(now - 100 * DAY_MS), dateInputValue(now - 95 * DAY_MS), now)
  assert.ok(older.range)
  assert.equal(older.range.bucketMs, 6 * HOUR_MS)
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

test("empty traffic aggregates do not reconstruct data from retained requests", () => {
  const snapshot = makeSnapshot(now)
  snapshot.history.traffic.hourly.buckets = []
  snapshot.history.traffic.daily.buckets = []
  const day = trafficData(snapshot, presetRange("24h", now))
  assert.equal(day.source, "none")
  assert.equal(day.totals.requests, 0)
  assert.equal(day.coverageStart, null)
  assert.equal(day.truncated, false)
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
