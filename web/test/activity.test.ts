import test from "node:test"
import assert from "node:assert/strict"
import { activityLine, fetchActivity, isActivityPage, type ActivityEntry } from "../src/lib/activity.js"

const entry: ActivityEntry = { seq: 1, time: "2026-11-04T12:00:00.123Z", component: "relay", trigger: "automatic", operation: "a".repeat(16), execution: "b".repeat(8), stream: "stderr", text: "actual error\nsecond line" }
const page = { version: 1, entries: [entry], oldest: 1, newest: 1, reset: false, storage_error: false }

test("activity boundary validates ordering, bounds, timestamps and diagnostic fields", () => {
  assert.equal(isActivityPage(page), true)
  for (const change of [{ version: 2 }, { oldest: -1 }, { newest: 0 }, { newest: 2 ** 53 }, { reset: "false" }, { entries: [entry, entry] }, { entries: [{ ...entry, time: "bad" }] }, { entries: [{ ...entry, text: "x".repeat(4097) }] }, { entries: [{ ...entry, stream: "shell" }] }, { entries: [{ ...entry, operation: "command" }] }, { entries: [{ ...entry, trigger: "unknown" }] }]) {
    assert.equal(isActivityPage({ ...page, ...change }), false)
  }
  assert.match(activityLine(entry), /\[relay\] \[automatic:aaaaaaaaaaaaaaaa\/bbbbbbbb\] \[stderr\] actual error\nsecond line/)
})

test("journal reads use only cursor parameters and explicitly report old supervisors", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "/api/system/journal?before=42")
      assert.equal(init?.credentials, "same-origin")
      assert.equal(init?.cache, "no-store")
      assert.equal(init?.redirect, "error")
      return Response.json(page)
    }) as typeof fetch
    assert.deepEqual(await fetchActivity(new AbortController().signal, { before: 42 }), page)
    globalThis.fetch = (async () => Response.json({ error: "supervisor_upgrade_required" }, { status: 503 })) as typeof fetch
    await assert.rejects(fetchActivity(new AbortController().signal), /updated dashboard and supervisor/)
    globalThis.fetch = (async () => new Response("<html>not found</html>", { status: 404, headers: { "Content-Type": "text/html" } })) as typeof fetch
    await assert.rejects(fetchActivity(new AbortController().signal), /updated dashboard and supervisor/)
  } finally {
    globalThis.fetch = original
  }
})
