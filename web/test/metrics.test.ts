import test from "node:test"
import assert from "node:assert/strict"
import { bytes, duration, filterSessions, percentage, relativeTime, savings, sessionState } from "../src/lib/metrics.js"
import { makeOpenCodeSessions, makeSnapshot } from "./fixture.js"
import { fetchOpenCodeSessions, fetchSnapshot, isOpenCodeSessions, isSnapshot } from "../src/lib/api.js"

test("savings include encoded overhead and retain negative reductions", () => {
  assert.equal(savings(1000, 100), 90)
  assert.equal(savings(1000, 1500), -50)
  assert.equal(savings(0, 100), null)
  assert.equal(percentage(null), "—")
  assert.equal(bytes(1024), "1\u00A0KiB")
  assert.equal(bytes(-1024), "-1\u00A0KiB")
  assert.equal(bytes(Infinity), "—")
  assert.equal(duration(1200), "1.2\u00A0s")
  assert.equal(duration(119999), "2m\u00A00s")
  assert.equal(duration(-1000), "0\u00A0ms")
})

test("session filtering is case insensitive and active has priority", () => {
  const data = makeSnapshot()
  assert.equal(filterSessions(data.history.sessions, "API-REFACTOR", "all").length, 1)
  assert.equal(filterSessions(data.history.sessions, "openai", "active").length, 1)
  assert.equal(filterSessions(data.history.sessions, "", "attention").length, 1)
  assert.equal(filterSessions(data.history.sessions, "no match", "all").length, 0)
  const active = data.history.sessions[0]!
  assert.equal(sessionState({ ...active, last_status: 500 }), "active")
  assert.equal(sessionState({ ...active, active: 0, last_status: 500 }), "attention")
  assert.equal(sessionState({ ...active, active: 0, last_status: 499, last_error: "request_cancelled" }), "idle")
})

test("relative time is clamped for future timestamps", () => {
  const now = Date.parse("2026-10-28T12:15:00Z")
  assert.equal(relativeTime(new Date(now + 1000).toISOString(), now), "just now")
})

test("API validation refuses incomplete, invalid, and incompatible diagnostics", () => {
  const data = makeSnapshot()
  assert.equal(isSnapshot(data), true)
  assert.equal(isSnapshot({ ...data, version: 2 }), false)
  assert.equal(isSnapshot({ ...data, collected_at: "invalid" }), false)
  assert.equal(isSnapshot({ ...data, gateway: { active: 0 } }), false)
  assert.equal(isSnapshot({ ...data, history: { ...data.history, totals: { ...data.history.totals, encoded_upload_bytes: NaN } } }), false)
  assert.equal(isSnapshot({ ...data, history: { ...data.history, totals: { ...data.history.totals, cancelled: 72, failed: 1 } } }), false)
  assert.equal(isSnapshot(null), false)
  assert.equal(isSnapshot({}), false)
  const catalog = makeOpenCodeSessions()
  assert.equal(isOpenCodeSessions(catalog), true)
  assert.equal(isOpenCodeSessions({ ...catalog, version: 2 }), false)
  assert.equal(isOpenCodeSessions({ ...catalog, checked_at: "invalid" }), false)
  assert.equal(isOpenCodeSessions({ ...catalog, sessions: [{ ...catalog.sessions[0]!, id: "" }] }), false)
  assert.equal(isOpenCodeSessions({ ...catalog, sessions: [{ ...catalog.sessions[0]!, created_at: "invalid" }] }), false)
  assert.equal(isOpenCodeSessions({ ...catalog, stale: "no" }), false)
  assert.equal(isOpenCodeSessions(null), false)
})

test("fetch uses only the local read-only API and handles malformed errors", async (t) => {
  const data = makeSnapshot()
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(input, "/api/dashboard")
    assert.equal(options?.cache, "no-store")
    assert.equal(options?.redirect, "error")
    assert.equal(options?.headers, undefined)
    return Response.json(data)
  })
  const signal = new AbortController().signal
  assert.equal((await fetchSnapshot(signal)).history.totals.requests, 73)
  mock.mock.mockImplementation(async () => Response.json(null, { status: 502 }))
  await assert.rejects(fetchSnapshot(signal), /Cannot reach the local gateway/)
  mock.mock.mockImplementation(async () => Response.json({ error: "gateway_authentication" }, { status: 502 }))
  await assert.rejects(fetchSnapshot(signal), /authentication failed/)
  mock.mock.mockImplementation(async () => Response.json({ version: 99 }))
  await assert.rejects(fetchSnapshot(signal), /incompatible diagnostics/)
})

test("OpenCode session metadata uses only the local read-only endpoint", async (t) => {
  const catalog = makeOpenCodeSessions()
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(input, "/api/opencode/sessions")
    assert.equal(options?.cache, "no-store")
    assert.equal(options?.redirect, "error")
    assert.equal(options?.credentials, "same-origin")
    return Response.json(catalog)
  })
  const signal = new AbortController().signal
  assert.equal((await fetchOpenCodeSessions(signal)).sessions.length, 10)
  mock.mock.mockImplementation(async () => Response.json({ error: "opencode_not_configured" }, { status: 503 }))
  await assert.rejects(fetchOpenCodeSessions(signal), /unavailable/)
  mock.mock.mockImplementation(async () => Response.json({ version: 1 }))
  await assert.rejects(fetchOpenCodeSessions(signal), /incompatible session metadata/)
})
