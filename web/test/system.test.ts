import test from "node:test"
import assert from "node:assert/strict"
import { connectionState, countdown, desktopLaunchState, isSystemStatus, fetchSystem, recoveryStatus, sendControl, supportsRemote, type SystemStatus } from "../src/lib/system.js"

const status: SystemStatus = {
  version: 2, managed: true, collected_at: "2026-10-28T12:00:00Z", csrf_token: "a".repeat(64),
  settings: { auto_reconnect: true, auto_wake: false }, relay_state: "unreachable", internet_state: "connected", internet_checked_at: null,
  remote: { id: "example", label: "Example host", host_state: "stopped", capabilities: ["host.wake", "host.stop"] },
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
  for (const change of [{ version: 3 }, { csrf_token: "" }, { internet_state: 1 }, { internet_checked_at: "bad" }, { auth: { state: "valid", stale: false, expires_at: "bad" } }, { settings: { auto_reconnect: "true", auto_wake: false } }, { components: [{ ...status.components[0], id: "arbitrary-command" }] }, { recovery: { ...status.recovery, attempts: NaN } }]) {
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

test("recovery status shows the actual failure instead of masking it as VPS unreachable", () => {
  const failed = { ...status, recovery: { ...status.recovery, last_error: "relay_ssh_timeout" } }
  assert.match(recoveryStatus(failed), /SSH.*timed out/)
  assert.match(recoveryStatus({ ...failed, recovery: { ...failed.recovery, last_error: "relay_recovery_failed" } }), /SSH\/relay recovery failed/)
  assert.match(recoveryStatus({ ...failed, recovery: { ...failed.recovery, last_error: "host_stopped" } }), /Wake it manually/)
  assert.match(recoveryStatus({ ...failed, recovery: { ...failed.recovery, last_error: "command_failed" } }), /service command failed/)
  assert.match(recoveryStatus({ ...failed, recovery: { ...failed.recovery, busy: true, phase: "recovering_remote_relay" } }), /In progress: recovering remote relay/)
  assert.match(recoveryStatus({ ...failed, error: "supervisor_unavailable" }), /local supervisor is unavailable/)
  assert.match(recoveryStatus({ ...failed, internet_state: "unreachable" }), /no internet connection/)
  assert.match(recoveryStatus({ ...status, recovery: { ...status.recovery, last_error: "unreachable" } }), /Internet works, but/)
  assert.match(recoveryStatus({ ...status, relay_state: "connected" }), /Authenticated relay is reachable/)
  assert.doesNotMatch(recoveryStatus({ ...failed, recovery: { ...failed.recovery, last_error: "untrusted diagnostic" } }), /untrusted diagnostic/)
})

test("intentional remote shutdown is shown as stopped, not a VPS fault", () => {
  const stopped = { ...status, settings: { auto_reconnect: false, auto_wake: false } }
  assert.equal(connectionState(stopped), "remote_stopped")
  assert.equal(connectionState({ ...stopped, relay_state: "connected" }), "connected")
  assert.equal(connectionState({ ...stopped, relay_state: "identity_mismatch" }), "unknown")
  assert.match(recoveryStatus(stopped), /remote host is stopped.*reconnect and wake are off/)
  assert.match(recoveryStatus({ ...stopped, relay_state: "connected" }), /Authenticated relay is reachable/)
  assert.match(recoveryStatus({ ...stopped, internet_state: "unreachable" }), /remote host is stopped/)
  assert.match(recoveryStatus({ ...stopped, recovery: { ...stopped.recovery, busy: true, phase: "stop_remote" } }), /In progress: stop remote/)
  assert.match(recoveryStatus({ ...status, remote: { ...status.remote, host_state: "stopping" }, recovery: { ...status.recovery, last_error: "host_stop_timeout" } }), /shutdown was not confirmed.*reconnect and wake remain off/)
})

test("wake progress distinguishes a running host from a verified relay connection", () => {
  for (const [phase, detail] of [
    ["waking_remote_host", /connecting and verifying the relay comes next/],
    ["waiting_for_remote_host", /Relay connectivity is not confirmed/],
    ["connecting_tunnel", /running host alone is not a working connection/],
    ["verifying_connection", /even if remote SSH recovery timed out/],
  ] as const) {
    const progress = recoveryStatus({ ...status, recovery: { ...status.recovery, busy: true, phase } })
    assert.match(progress, /^In progress:/)
    assert.match(progress, detail)
    assert.doesNotMatch(progress, /Automatic recovery is off/)
  }
})

test("paused recovery is explicit even after the host resumes or a provider check fails", () => {
  const paused = { ...status, settings: { auto_reconnect: false, auto_wake: false }, remote: { ...status.remote, host_state: "running" as const } }
  assert.equal(connectionState(paused), "vps_unreachable")
  assert.match(recoveryStatus(paused), /Internet works.*Automatic recovery is off.*Start system/)
  assert.match(recoveryStatus({ ...paused, recovery: { ...paused.recovery, last_error: "provider_timeout" } }), /plugin timed out.*Automatic recovery is off/)
  assert.match(recoveryStatus({ ...paused, relay_state: "protocol_mismatch", recovery: { ...paused.recovery, last_error: "protocol_mismatch" } }), /Deploy matching relay, gateway, OpenCode plugin, and dashboard/)
  assert.match(recoveryStatus({ ...paused, relay_state: "connected" }), /reachable.*Automatic recovery is off/)
  assert.doesNotMatch(recoveryStatus({ ...paused, relay_state: "connected" }), /monitored in the background/)
  assert.doesNotMatch(recoveryStatus(status), /Automatic recovery is off/)
})

test("remote stop sends an explicitly confirmed action through the protected control API", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(input, "/api/system/action")
    assert.equal(options?.method, "POST")
    assert.equal(options?.credentials, "same-origin")
    assert.deepEqual(options?.headers, { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
    assert.deepEqual(JSON.parse(String(options?.body)), { component: "remote", action: "stop", confirmed: true })
    return Response.json({ accepted: true }, { status: 202 })
  })
  await sendControl("action", { component: "remote", action: "stop", confirmed: true }, status.csrf_token)
  assert.equal(mock.mock.callCount(), 1)
})

test("Desktop launch requires fresh managed status and a configured launcher, not a reachable VPS", () => {
  const configured = { ...status, components: [{ id: "desktop", label: "Isolated Desktop", state: "stopped", can_start: true, can_restart: true }] }
  assert.equal(desktopLaunchState(configured).disabled, false)
  assert.equal(desktopLaunchState({ ...configured, internet_state: "unreachable" }).disabled, false)
  for (const unavailable of [null, status, { ...configured, managed: false }, { ...configured, components: [{ ...configured.components[0]!, can_start: false }] }]) {
    assert.equal(desktopLaunchState(unavailable).disabled, true)
  }
  assert.equal(desktopLaunchState(configured, true).disabled, true)
  assert.equal(desktopLaunchState(configured, false, true).disabled, true)
  assert.equal(desktopLaunchState({ ...configured, recovery: { ...status.recovery, busy: true } }).disabled, true)
  assert.match(desktopLaunchState(status).detail, /private supervisor configuration/)
  assert.match(desktopLaunchState({ ...configured, managed: false, error: "supervisor_unavailable" }).detail, /supervisor is unavailable/)
})

test("Desktop launch prevents duplicate instances while starting or running", () => {
  for (const state of ["starting", "started", "running"]) {
    const configured = { ...status, components: [{ id: "desktop", label: "Isolated Desktop", state, can_start: true, can_restart: true }] }
    const launch = desktopLaunchState(configured)
    assert.equal(launch.disabled, true)
    assert.match(launch.detail, /already running|is starting/)
  }
})

test("Desktop launch uses the existing protected start action, never restart or remote recovery", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(input, "/api/system/action")
    assert.equal(options?.method, "POST")
    assert.equal(options?.credentials, "same-origin")
    assert.equal(options?.redirect, "error")
    assert.deepEqual(options?.headers, { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
    assert.deepEqual(JSON.parse(String(options?.body)), { component: "desktop", action: "start" })
    return Response.json({ accepted: true }, { status: 202 })
  })
  await sendControl("action", { component: "desktop", action: "start" }, status.csrf_token)
  assert.equal(mock.mock.callCount(), 1)
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
  assert.equal((await fetchSystem(new AbortController().signal)).remote.host_state, "stopped")
  await sendControl("action", { component: "tunnel", action: "start" }, status.csrf_token)
  mock.mock.mockImplementation(async () => Response.json({ error: "host_stopped" }, { status: 409 }))
  await assert.rejects(sendControl("action", {}, status.csrf_token), /Wake it manually/)
  mock.mock.mockImplementation(async () => Response.json({ version: 999 }))
  await assert.rejects(fetchSystem(new AbortController().signal), /incompatible/)
})

test("remote capabilities are vendor-independent and only current snapshots are accepted", () => {
  assert.equal(supportsRemote(status, "host.wake"), true)
  assert.equal(supportsRemote(status, "relay.restart"), false)
  assert.equal(supportsRemote(null, "host.stop"), false)
  assert.equal(supportsRemote({ ...status, remote: { ...status.remote, capabilities: [] } }, "host.wake"), false)
  assert.equal(isSystemStatus({ ...status, version: 1 }), false)
  for (const remote of [null, { ...status.remote, id: "bad id" }, { ...status.remote, host_state: "Available" },
    { ...status.remote, label: "secret\nline" }, { ...status.remote, capabilities: ["execute"] },
    { ...status.remote, capabilities: ["host.wake", "host.wake"] }]) {
    assert.equal(isSystemStatus({ ...status, remote }), false)
  }
  assert.match(recoveryStatus({ ...status, settings: { auto_reconnect: false, auto_wake: false }, remote: { ...status.remote, capabilities: [] } }), /hosting provider/)
})
