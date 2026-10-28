import test from "node:test"
import assert from "node:assert/strict"
import { connectionState, countdown, isSystemStatus, fetchSystem, sendControl, type SystemStatus } from "../src/lib/system.js"

const status: SystemStatus = {
  version: 1, managed: true, collected_at: "2026-10-28T12:00:00Z", csrf_token: "a".repeat(64),
  settings: { auto_reconnect: true, auto_wake: false }, relay_state: "unreachable", internet_state: "connected", internet_checked_at: null, codespace_state: "Shutdown",
  recovery: { busy: false, attempts: 0, phase: "monitoring", last_error: "", next_retry_at: null, last_connected_at: null },
  components: [{ id: "gateway", label: "Gateway", state: "stopped", can_start: true, can_restart: true }],
  auth: { state: "valid", stale: false, expires_at: "2026-10-28T13:00:00Z" },
}

test("countdown is absolute, clamps expired tokens, and handles long lifetimes", () => {
  const now = Date.parse("2026-10-28T12:00:00Z")
  assert.equal(countdown("2026-10-28T13:01:00Z", now), "1h 1m")
  assert.equal(countdown("2026-10-30T13:01:00Z", now), "2d 1h 1m")
  assert.equal(countdown("2026-10-28T12:01:02Z", now), "1m 2s")
  assert.equal(countdown("2026-10-28T12:00:00Z", now), "Expired · awaiting refresh")
  assert.equal(countdown("2026-10-27T12:00:00Z", now), "Expired · awaiting refresh")
  assert.equal(countdown("invalid", now), "Unknown")
})

test("control snapshots validate schemas, components, timestamps, and ephemeral nonces", () => {
  assert.equal(isSystemStatus(status), true)
  assert.equal(isSystemStatus({ ...status, managed: false, components: [] }), true)
  for (const change of [{ version: 2 }, { csrf_token: "" }, { internet_state: 1 }, { internet_checked_at: "bad" }, { auth: { state: "valid", stale: false, expires_at: "bad" } }, { settings: { auto_reconnect: "true", auto_wake: false } }, { components: [{ ...status.components[0], id: "arbitrary-command" }] }, { recovery: { ...status.recovery, attempts: NaN } }]) {
    assert.equal(isSystemStatus({ ...status, ...change }), false)
  }
})

test("connection state only blames the internet when the separate check also failed", () => {
  assert.equal(connectionState({ ...status, relay_state: "connected", internet_state: "unreachable" }), "connected")
  assert.equal(connectionState({ ...status, relay_state: "unreachable", internet_state: "connected" }), "vps_unreachable")
  assert.equal(connectionState({ ...status, relay_state: "unreachable", internet_state: "unreachable" }), "no_internet")
  assert.equal(connectionState({ ...status, relay_state: "unreachable", internet_state: "unknown" }), "unknown")
  assert.equal(connectionState({ ...status, relay_state: "authentication_failed", internet_state: "connected" }), "unknown")
})

test("control API uses same-origin POST with nonce, never credentials in URLs", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    if (input === "/api/system") return Response.json(status)
    assert.equal(input, "/api/system/action")
    assert.equal(options?.method, "POST")
    assert.equal(options?.credentials, "same-origin")
    assert.equal(options?.redirect, "error")
    assert.deepEqual(options?.headers, { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
    assert.deepEqual(JSON.parse(String(options?.body)), { component: "tunnel", action: "start" })
    return Response.json({ accepted: true }, { status: 202 })
  })
  assert.equal((await fetchSystem(new AbortController().signal)).codespace_state, "Shutdown")
  await sendControl("action", { component: "tunnel", action: "start" }, status.csrf_token)
  mock.mock.mockImplementation(async () => Response.json({ error: "codespace_stopped" }, { status: 409 }))
  await assert.rejects(sendControl("action", {}, status.csrf_token), /Wake Codespace/)
  mock.mock.mockImplementation(async () => Response.json({ version: 999 }))
  await assert.rejects(fetchSystem(new AbortController().signal), /incompatible/)
})
