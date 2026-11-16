import test from "node:test"
import assert from "node:assert/strict"
import { fetchRequestPage, fetchSnapshot, isSnapshot } from "../src/lib/api.js"
import { createRequestPages } from "../src/scripts/features/request-pages.js"
import { makeSnapshot } from "./fixture.js"
import { lastRange } from "../src/lib/traffic.js"

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("compact diagnostics sends only range parameters and request pages are bounded", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const snapshot = makeSnapshot()
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return Response.json(snapshot)
  }) as typeof fetch
  const now = Date.now()
  const range = lastRange(6, "hours", now).range!
  await fetchSnapshot(AbortSignal.timeout(1000), { compact: true, range, host: "alpha", now })
  const url = new URL(calls[0]!, "http://localhost")
  assert.equal(url.pathname, "/api/dashboard")
  assert.equal(url.searchParams.get("compact"), "1")
  assert.equal(url.searchParams.get("start"), String(range.start))
  assert.equal(url.searchParams.get("end"), String(range.end))
  assert.equal(url.searchParams.get("exact"), "1")
  assert.equal(url.searchParams.get("host"), "alpha")

  globalThis.fetch = (async () => Response.json({ requests: snapshot.history.recent_requests.slice(0, 9), total: 73, next_before: 1 })) as typeof fetch
  await assert.rejects(fetchRequestPage("", "", 0, 8, AbortSignal.timeout(1000)), /incompatible/)
  assert.equal(isSnapshot({ ...snapshot, requests_paged: "yes" }), false)
  assert.equal(isSnapshot({ ...snapshot, overview: { points: [] } }), false)
})

test("request pager replaces rows, traverses cursors, refreshes current page and retries", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const snapshot = makeSnapshot()
  snapshot.requests_paged = true
  const retained = snapshot.history.recent_requests.slice(0, 20).map((request, index) => ({ ...request, sequence: index + 1 })).reverse()
  snapshot.history.recent_requests = []
  let fail = false
  const cursors: number[] = []
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), "http://localhost")
    assert.equal(url.pathname, "/api/dashboard/requests")
    assert.equal(url.searchParams.get("session"), "")
    assert.equal(url.searchParams.get("host"), "alpha")
    const before = Number(url.searchParams.get("before"))
    cursors.push(before)
    if (fail) return Response.json({}, { status: 503 })
    const remaining = retained.filter((request) => !before || request.sequence < before)
    const requests = remaining.slice(0, 8)
    return Response.json({ requests, total: retained.length, next_before: remaining.length > 8 ? requests.at(-1)!.sequence : 0 })
  }) as typeof fetch
  let changes = 0
  const pager = createRequestPages(() => changes++)
  t.after(() => pager.destroy())
  assert.equal(pager.sync(snapshot, "", "alpha").loading, true)
  await settle()
  let current = pager.sync(snapshot, "", "alpha")
  assert.equal(current.requests.length, 8)
  assert.equal(current.requests[0]!.sequence, 20)
  assert.equal(current.total, 20)
  assert.equal(cursors.length, 1, "local re-renders must not refetch")
  pager.navigate("older")
  await settle()
  current = pager.sync(snapshot, "", "alpha")
  assert.equal(current.requests.length, 8)
  assert.equal(current.requests[0]!.sequence, 12)
  assert.equal(current.requests.some((request) => request.sequence === 20), false, "old page rows must be released")
  const refreshed = { ...snapshot }
  pager.sync(refreshed, "", "alpha")
  await settle()
  assert.deepEqual(cursors, [0, 13, 13], "refresh stays on the current page")
  pager.navigate("older")
  await settle()
  assert.equal(pager.sync(refreshed, "", "alpha").requests.length, 4)
  assert.match(pager.controls(), /data-request-page="older" disabled/)
  pager.navigate("newer")
  await settle()
  assert.equal(pager.sync(refreshed, "", "alpha").requests[0]!.sequence, 12)
  fail = true
  pager.navigate("newer")
  await settle()
  assert.match(pager.sync(refreshed, "", "alpha").error, /unavailable/)
  assert.match(pager.controls(), /Retry/)
  fail = false
  pager.navigate("retry")
  await settle()
  assert.equal(pager.sync(refreshed, "", "alpha").requests[0]!.sequence, 20)
  assert.ok(changes > 0)
})

test("request pager ignores late responses after session changes and destruction", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const snapshot = makeSnapshot()
  snapshot.requests_paged = true
  const requests = snapshot.history.recent_requests.slice(0, 1)
  const pending: Array<(response: Response) => void> = []
  globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch
  let changes = 0
  const pager = createRequestPages(() => changes++)
  pager.sync(snapshot, "first", "")
  pager.sync(snapshot, "second", "")
  pending[1]!(Response.json({ requests: [], total: 0, next_before: 0 }))
  await settle()
  pending[0]!(Response.json({ requests, total: 1, next_before: 0 }))
  await settle()
  assert.equal(pager.sync(snapshot, "second", "").requests.length, 0)
  assert.equal(changes, 1)
  pager.sync(snapshot, "third", "")
  pager.destroy()
  pending[2]!(Response.json({ requests, total: 1, next_before: 0 }))
  await settle()
  assert.equal(changes, 1)
})
