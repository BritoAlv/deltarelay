import test from "node:test"
import assert from "node:assert/strict"
import { json, openPage } from "./browser.js"
import { startDashboard } from "../src/scripts/dashboard.js"
import { startSystemControls } from "../src/scripts/system.js"
import { makeSnapshot } from "./fixture.js"
import { sessionCsv } from "../src/lib/csv.js"
import type { SystemStatus } from "../src/lib/system.js"

const now = Date.parse("2026-10-28T12:15:00Z")

function systemStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    version: 2, managed: true, collected_at: new Date(now).toISOString(), csrf_token: "a".repeat(64),
    settings: { auto_reconnect: true, auto_wake: false }, relay_state: "connected", internet_state: "connected", internet_checked_at: null,
    remote: { id: "example", label: "Example host", host_state: "running", capabilities: ["host.wake", "host.stop"] },
    recovery: { busy: false, attempts: 0, phase: "monitoring", last_error: "", next_retry_at: null, last_connected_at: null },
    components: [
      { id: "gateway", label: "Gateway", state: "running", can_start: true, can_restart: true },
      { id: "desktop", label: "Isolated Desktop", state: "stopped", can_start: true, can_restart: true },
    ],
    auth: { state: "valid", stale: false, expires_at: new Date(now + 3_600_000).toISOString(), checked_at: new Date(now).toISOString() },
    ...overrides,
  }
}

function abortError(): Error {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}

test("initial page state loads without presenting fabricated diagnostics", async () => {
  const page = openPage()
  page.setFetch(() => { throw new Error("No request expected during initial render") })
  const dashboard = startDashboard(page.document, { autoStart: false })
  assert.equal(page.document.querySelector("#connection-label")?.textContent, "Connecting")
  assert.equal(page.document.querySelector("#stat-sessions")?.textContent, "—")
  assert.match(page.document.querySelector("#traffic-chart")?.textContent ?? "", /No finished requests in this window/)
  assert.equal(page.document.querySelector("#session-rows")?.children.length, 0)
  assert.equal(page.document.querySelector("#sessions-empty")?.hasAttribute("hidden"), false)
  dashboard.destroy()
  await page.close()
})

test("successful refresh renders stats, accessible chart, sessions, and relay health", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  page.setFetch((url) => {
    assert.equal(url, "/api/dashboard")
    return json(snapshot)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Live")
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "6")
  assert.equal(doc.querySelector("#nav-session-count")?.textContent, "6")
  assert.match(doc.querySelector("#traffic-chart")?.innerHTML ?? "", /<svg/)
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 24 hours.*72 requests/)
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.match(doc.querySelector("#table-summary")?.textContent ?? "", /1–6 of 6 sessions/)
  assert.match(doc.querySelector("#system-summary")?.textContent ?? "", /Relay checks passed/)
  assert.match(doc.querySelector("#retention-note")?.textContent ?? "", /Keeps up to 256 sessions and 1,000 requests/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#refresh-button")?.disabled, false)
  dashboard.destroy()
  await page.close()
})

test("failed refresh marks diagnostics stale without discarding the last snapshot", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  let fail = false
  page.setFetch(() => {
    if (fail) throw abortError()
    return json(snapshot)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  fail = true
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Disconnected")
  assert.match(doc.querySelector("#notice")?.textContent ?? "", /timed out.*last successful snapshot/)
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "6")
  assert.match(doc.querySelector("#system-summary")?.textContent ?? "", /Stale/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#refresh-button")?.disabled, false)
  dashboard.destroy()
  await page.close()
})

test("session filtering and pagination only render retained matches", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  const extra = snapshot.history.sessions.slice(0, 4).map((session, index) => ({
    ...session,
    id: `ses_extra_${index}`,
    upstream: "extra-upstream",
    active: 0,
    last_status: 200,
    last_error: undefined,
  }))
  snapshot.history.sessions.push(...extra)
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const next = doc.querySelector<HTMLButtonElement>("#next-page")!
  assert.equal(next.disabled, false)
  next.click()
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 2 of 2")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 2)
  const search = doc.querySelector<HTMLInputElement>("#session-search")!
  search.value = "api-refactor"
  page.fire(search, "input")
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 1 of 1")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 1)
  search.value = ""
  page.fire(search, "input")
  const filter = doc.querySelector<HTMLSelectElement>("#session-filter")!
  filter.value = "attention"
  page.fire(filter, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 1)
  assert.match(doc.querySelector("#session-rows")?.textContent ?? "", /Attention/)
  dashboard.destroy()
  await page.close()
})

test("session details open from a row and close again", async () => {
  const page = openPage()
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const button = doc.querySelector<HTMLButtonElement>("#session-rows button[data-session-id]")!
  button.click()
  const dialog = doc.querySelector<HTMLDialogElement>("#session-dialog")!
  assert.equal(dialog.open, true)
  assert.equal(doc.querySelector("#detail-title")?.textContent, button.dataset.sessionId)
  assert.match(doc.querySelector("#session-detail")?.textContent ?? "", /Recent requests/)
  doc.querySelector<HTMLButtonElement>("#close-detail")!.click()
  assert.equal(dialog.open, false)
  dashboard.destroy()
  await page.close()
})

test("CSV export protects formulas and uses the filtered sessions", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  snapshot.history.sessions[0]!.id = "=SUM(A1)"
  snapshot.history.sessions[0]!.upstream = "@command"
  page.setFetch(() => json(snapshot))
  let captured: Blob | undefined
  let download = ""
  Object.defineProperty(page.window.URL, "createObjectURL", { value: (value: Blob) => { captured = value; return "blob:test" }, configurable: true })
  Object.defineProperty(page.window.URL, "revokeObjectURL", { value: () => undefined, configurable: true })
  const click = page.window.HTMLAnchorElement.prototype.click
  page.window.HTMLAnchorElement.prototype.click = function () { download = this.download }
  try {
    const dashboard = startDashboard(page.document, { autoStart: false })
    await dashboard.refresh()
    page.document.querySelector<HTMLButtonElement>("#export-button")!.click()
    assert.ok(captured)
    const csv = await captured.text()
    assert.match(csv, /^"session_id","upstream"/)
    assert.match(csv, /"'=SUM\(A1\)","'@command"/)
    assert.match(download, /^deltarelay-sessions-\d{4}-\d{2}-\d{2}\.csv$/)
    assert.match(sessionCsv(snapshot.history.sessions), /"'=SUM\(A1\)"/)
    dashboard.destroy()
  } finally {
    page.window.HTMLAnchorElement.prototype.click = click
  }
  await page.close()
})

test("gateway failure never disables independent supervisor controls", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  const status = systemStatus()
  let dashboardFails = false
  let systemFails = false
  page.setFetch((url) => {
    if (url === "/api/dashboard") {
      if (dashboardFails) throw abortError()
      return json(snapshot)
    }
    if (url === "/api/system") {
      if (systemFails) throw new Error("supervisor down")
      return json(status)
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  const system = startSystemControls(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, false)
  assert.equal(doc.querySelector<HTMLButtonElement>("#auto-reconnect")?.disabled, false)
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Connected")
  dashboardFails = true
  await dashboard.refresh()
  await system.refresh()
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Disconnected")
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, false)
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Connected")
  systemFails = true
  await system.refresh()
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Stale")
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, true)
  assert.match(doc.querySelector("#control-notice")?.textContent ?? "", /stale.*disabled/i)
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("Desktop launch sends one protected same-origin action and blocks duplicates", async () => {
  const page = openPage()
  const status = systemStatus()
  const actions: unknown[] = []
  const actionHeaders: HeadersInit[] = []
  let release: (response: Response) => void = () => undefined
  const held = new Promise<Response>((resolve) => { release = resolve })
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(status)
    if (url === "/api/system/action") {
      actions.push(JSON.parse(String(init.body)))
      actionHeaders.push(init.headers ?? {})
      return held
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  const system = startSystemControls(page.document, { autoStart: false })
  await system.refresh()
  page.setConfirm(() => true)
  const button = page.document.querySelector<HTMLButtonElement>("#open-desktop")!
  assert.equal(button.disabled, false)
  button.click()
  button.click()
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0], { component: "desktop", action: "start", confirmed: false })
  assert.deepEqual(actionHeaders[0], { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
  assert.equal(button.disabled, true)
  release(json({ accepted: true }, 202))
  await new Promise((resolve) => setTimeout(resolve, 0))
  system.destroy()
  await page.close()
})

test("stale or unmanaged snapshots keep every service control disabled", async () => {
  const page = openPage()
  let status = systemStatus({ managed: false })
  page.setFetch(() => json(status))
  const system = startSystemControls(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, true)
  assert.equal(doc.querySelector<HTMLButtonElement>("#open-desktop")?.disabled, true)
  assert.match(doc.querySelector("#desktop-status")?.textContent ?? "", /not configured/i)
  status = systemStatus()
  page.setFetch(() => json(status))
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, false)
  page.setFetch(() => { throw new Error("offline") })
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, true)
  assert.equal(doc.querySelector<HTMLButtonElement>("#open-desktop")?.disabled, true)
  system.destroy()
  await page.close()
})

test("pausing diagnostics leaves supervisor refresh and controls live", async () => {
  const page = openPage()
  let status = systemStatus()
  page.setFetch((url) => {
    if (url === "/api/dashboard") return json(makeSnapshot(now))
    if (url === "/api/system") return json(status)
    throw new Error(`Unexpected URL ${url}`)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  const system = startSystemControls(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  doc.querySelector<HTMLButtonElement>("#pause-button")!.click()
  assert.equal(dashboard.paused, true)
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Paused")
  status = systemStatus({ recovery: { busy: false, attempts: 2, phase: "monitoring", last_error: "", next_retry_at: null, last_connected_at: null } })
  await system.refresh()
  assert.match(doc.querySelector("#recovery-detail")?.textContent ?? "", /2 automatic recovery attempts/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, false)
  doc.querySelector<HTMLButtonElement>("#pause-button")!.click()
  assert.equal(dashboard.paused, false)
  dashboard.destroy()
  system.destroy()
  await page.close()
})
