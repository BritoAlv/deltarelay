import test from "node:test"
import assert from "node:assert/strict"
import { fetchSystemHistory, historyCoverage, historyStates, historyTrackedSeconds, isSystemHistory } from "../src/lib/system-history.js"
import { contractCases, contractPayload, readContract } from "./contracts.js"

for (const c of contractCases("state-history-cases.json")) {
  test(`state-history-cases.json: ${c.name}`, () => {
    assert.equal(isSystemHistory(contractPayload(c, "state-history-v1.json")), c.valid)
  })
}

test("state history totals and coverage are derived from retained intervals", () => {
  const history = readContract("state-history-v1.json")
  assert.ok(isSystemHistory(history))
  assert.equal(historyTrackedSeconds(history), 7200)
  assert.equal(historyCoverage(history), 100)
  assert.deepEqual(historyStates, history.states)
  assert.equal(history.intervals_complete, true)
  assert.equal(history.intervals.length, 3)
  assert.deepEqual(history.intervals.map((interval) => interval.state), ["connected", "recovering", "connected"])
})

test("state history validation rejects missing fields, bad values, and inconsistent totals", () => {
  const history = readContract("state-history-v1.json") as Record<string, unknown>
  assert.equal(isSystemHistory({ ...history, version: 2 }), false)
  assert.equal(isSystemHistory({ ...history, bucket_seconds: 0 }), false)
  assert.equal(isSystemHistory({ ...history, buckets: [] }), false)
  assert.equal(isSystemHistory({ ...history, intervals: undefined }), false)
  assert.equal(isSystemHistory({ ...history, intervals_complete: "yes" }), false)
  assert.equal(isSystemHistory({ ...history, current: { state: "connected", since: "2026-11-01T13:00:00Z" } }), false)
  assert.equal(isSystemHistory({ ...history, totals: { ...(history.totals as object), connected: 1 } }), false)
  assert.equal(isSystemHistory(null), false)
})

test("state history fetch only requests the bounded local endpoint", async (t) => {
  const history = readContract("state-history-v1.json")
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let requested = ""
  globalThis.fetch = ((input: string | URL | Request) => {
    requested = String(input)
    return Promise.resolve(Response.json(history))
  }) as typeof fetch
  const result = await fetchSystemHistory(
    { start: Date.parse("2026-11-01T10:00:00Z"), end: Date.parse("2026-11-01T12:00:00Z"), bucketMs: 3_600_000 },
    AbortSignal.timeout(1000),
  )
  assert.equal(result.version, 1)
  assert.match(requested, /^\/api\/system\/history\?/)
  assert.match(requested, /start=1793527200/)
  assert.match(requested, /end=1793534400/)
  assert.match(requested, /bucket=3600/)
})

test("state history fetch maps supervisor availability errors", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (() => Promise.resolve(Response.json({ error: "supervisor_upgrade_required" }, { status: 503 }))) as typeof fetch
  await assert.rejects(
    fetchSystemHistory({ start: 1_000, end: 2_000, bucketMs: 1_000 }, AbortSignal.timeout(1000)),
    /Restart the updated local supervisor/,
  )
})
