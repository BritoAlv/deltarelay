import test from "node:test"
import assert from "node:assert/strict"
import { overviewData } from "../src/lib/overview.js"
import { dateTimeRange, lastRange, presetRange } from "../src/lib/traffic.js"
import { makeSnapshot } from "./fixture.js"

const now = Date.parse("2026-10-28T12:15:00Z")

test("overview shares traffic totals and counts unique sessions with requests in the window", () => {
  const snapshot = makeSnapshot(now)
  const original = snapshot.history.recent_requests[0]!
  snapshot.history.recent_requests = [
    { ...original, id: "a", session_id: "shared", host: "alpha", finished_at: new Date(now - 30_000).toISOString() },
    { ...original, id: "b", session_id: "shared", host: "beta", finished_at: new Date(now - 20_000).toISOString() },
    { ...original, id: "c", session_id: "other", host: "alpha", finished_at: new Date(now - 10_000).toISOString() },
    { ...original, id: "old", session_id: "outside", host: "alpha", finished_at: new Date(now - 61_000).toISOString() },
    { ...original, id: "live", session_id: "active", host: "alpha", state: "running", finished_at: undefined, started_at: new Date(now - 1000).toISOString() },
  ]
  const range = lastRange(1, "minutes", now).range!
  const result = overviewData(snapshot, range)
  assert.equal(result.traffic.totals.requests, 3)
  assert.equal(result.sessions, 3, "a session carried by two hosts counts once")
  assert.equal(result.activeSessions, 1)
  assert.equal(result.running, 1)
  assert.equal(overviewData(snapshot, range, "beta").sessions, 1)
  assert.equal(overviewData(snapshot, range, "beta").running, 0)
  const historical = dateTimeRange(new Date(now - 60_000).toISOString(), new Date(now - 15_000).toISOString(), now).range!
  const past = overviewData(snapshot, historical)
  assert.equal(past.sessions, 1)
  assert.equal(past.running, 0, "current running requests are never represented as historical activity")
})

test("older or partial histories label session counts as retained records only", () => {
  const snapshot = makeSnapshot(now)
  assert.equal(overviewData(snapshot, presetRange("30d", now)).incompleteSessions, true)
  snapshot.history.dropped_requests = 1
  assert.equal(overviewData(snapshot, lastRange(10, "seconds", now).range!).incompleteSessions, true)
})
