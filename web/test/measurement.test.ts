import test from "node:test"
import assert from "node:assert/strict"
import { barComparison, requestMeasurement, sessionMeasurement } from "../src/lib/measurement.js"
import { savings } from "../src/lib/metrics.js"
import { makeSnapshot } from "./fixture.js"

const now = Date.parse("2026-10-28T12:15:00Z")

test("session measurement uses retained request coverage without inventing totals", () => {
  const snapshot = makeSnapshot(now)
  const session = snapshot.history.sessions[0]!
  const requests = snapshot.history.recent_requests.filter((request) => request.session_id === session.id)
  const measured = sessionMeasurement(session, requests)
  assert.equal(measured.original, session.body_bytes)
  assert.equal(measured.encoded, session.encoded_upload_bytes)
  assert.equal(measured.saved, session.body_bytes - session.encoded_upload_bytes)
  assert.equal(measured.reduction, savings(session.body_bytes, session.encoded_upload_bytes))
  assert.equal(measured.totalRequests, session.requests)
  assert.equal(measured.retainedRequests, requests.length)
  assert.equal(measured.missingRequests, Math.max(0, session.requests - requests.length))
  assert.ok(measured.reusedPercent !== null)
})

test("session measurement retains negative savings and unavailable percentages", () => {
  const snapshot = makeSnapshot(now)
  const session = snapshot.history.sessions[0]!
  const negative = sessionMeasurement({ ...session, body_bytes: 1000, encoded_upload_bytes: 1500, reused_body_bytes: 0 }, [])
  assert.equal(negative.saved, -500)
  assert.equal(negative.reduction, -50)
  assert.equal(negative.missingRequests, session.requests)
  const empty = sessionMeasurement({ ...session, body_bytes: 0, encoded_upload_bytes: 100, reused_body_bytes: 0 }, [])
  assert.equal(empty.reduction, null)
  assert.equal(empty.reusedPercent, null)
})

test("request measurement marks running work as pending and uses snapshot elapsed time", () => {
  const snapshot = makeSnapshot(now)
  const completed = snapshot.history.recent_requests[0]!
  const done = requestMeasurement(completed, snapshot.collected_at)
  assert.equal(done.pending, false)
  assert.equal(done.original, completed.transfer.body_bytes)
  assert.equal(done.encoded, completed.transfer.request_body_bytes_sent)
  assert.equal(done.saved, completed.transfer.body_bytes - completed.transfer.request_body_bytes_sent)
  assert.equal(done.httpRequests, completed.transfer.requests)

  const running = snapshot.history.recent_requests.find((request) => request.state === "running")!
  const pending = requestMeasurement(running, snapshot.collected_at)
  assert.equal(pending.pending, true)
  assert.equal(pending.original, 0)
  assert.equal(pending.encoded, 0)
  assert.equal(pending.reduction, null)
  assert.equal(pending.elapsedMs, 12_000)
  assert.equal(pending.httpRequests, 0)
})

test("bar comparison shares a scale and flags encoded uploads above the original", () => {
  assert.deepEqual(barComparison(100, 40), { originalPercent: 100, encodedPercent: 40, savedPercent: 60, negative: false })
  const negative = barComparison(100, 150)
  assert.equal(negative.originalPercent, 100 / 150 * 100)
  assert.equal(negative.encodedPercent, 100)
  assert.equal(negative.savedPercent, 50 / 150 * 100)
  assert.equal(negative.negative, true)
  assert.deepEqual(barComparison(0, 0), { originalPercent: 0, encodedPercent: 0, savedPercent: 0, negative: false })
  assert.equal(barComparison(0, 100).negative, true)
})
