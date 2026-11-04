import test from "node:test"
import assert from "node:assert/strict"
import { json, openPage } from "./browser.js"
import { startDashboard } from "../src/scripts/dashboard.js"
import { startMeasurementPage } from "../src/scripts/measurement-page.js"
import { startSystemStatus } from "../src/scripts/system.js"
import { makeSnapshot } from "./fixture.js"
import { sessionCsv } from "../src/lib/csv.js"
import { dateInputValue } from "../src/lib/traffic.js"
import type { SystemStatus } from "../src/lib/system.js"

const now = Date.parse("2026-10-28T12:15:00Z")

async function waitForText(node: Element | null, pattern: RegExp, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (pattern.test(node?.textContent ?? "")) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`${label}: ${node?.textContent ?? ""}`)
}

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

test("every page marks exactly its own sidebar entry as current", async () => {
  for (const [page, href] of [["index", "/"], ["sessions", "/sessions"], ["measurement", "/measurement"], ["controls", "/controls"], ["system", "/system"]] as const) {
    const browser = openPage(page)
    const selected = browser.document.querySelectorAll<HTMLAnchorElement>("a.nav-link.selected")
    assert.equal(selected.length, 1, `${page} selected links`)
    assert.equal(selected[0]?.getAttribute("href"), href)
    assert.equal(selected[0]?.getAttribute("aria-current"), "page")
    await browser.close()
  }
})

test("initial overview state loads without presenting fabricated diagnostics", async () => {
  const page = openPage()
  const dashboard = startDashboard(page.document, { autoStart: false })
  assert.equal(page.document.querySelector("#connection-label")?.textContent, "Connecting")
  assert.equal(page.document.querySelector("#stat-sessions")?.textContent, "—")
  assert.match(page.document.querySelector("#traffic-chart")?.textContent ?? "", /No finished requests in this window/)
  assert.equal(page.document.querySelector("#session-rows"), null)
  assert.equal(page.document.querySelector("#system-cards"), null)
  dashboard.destroy()
  await page.close()
})

test("measurement page renders definitions and traces a selected session", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  page.setFetch((url) => {
    assert.equal(url, "/api/dashboard")
    return json(snapshot)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#measurement-connection-label")?.textContent, "Live")
  assert.match(doc.querySelector("#measurement")?.textContent ?? "", /Original body/)
  assert.match(doc.querySelector("#measurement")?.textContent ?? "", /Encoded upload/)
  const select = doc.querySelector<HTMLSelectElement>("#measurement-session")!
  assert.equal(select.options.length, 6)
  assert.equal(select.value, snapshot.history.sessions[0]!.id)
  const trace = doc.querySelector("#measurement-trace")!
  assert.match(trace.textContent ?? "", /From body to wire/)
  assert.match(trace.textContent ?? "", /Request ledger/)
  assert.match(trace.textContent ?? "", /Transfer totals pending/)
  assert.match(trace.textContent ?? "", /Show all .* retained requests/)
  assert.match(trace.textContent ?? "", /not captured/)
  assert.match(doc.querySelector("#request-inspector")?.textContent ?? "", /Payload capture is off or not reported/)
  assert.match(doc.querySelector("#request-inspector")?.textContent ?? "", /Not captured/)
  assert.match(doc.querySelector("#retention-note")?.textContent ?? "", /Keeps up to 256 sessions and 1,000 requests/)
  select.value = snapshot.history.sessions[1]!.id
  page.fire(select, "change")
  assert.match(trace.textContent ?? "", /api-refactor/)
  measurement.destroy()
  await page.close()
})

test("measurement inspector shows captured body, chunk availability, attempts and exact calculations", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const session = snapshot.history.sessions[0]!
  const request = snapshot.history.recent_requests.find((item) => item.session_id === session.id && item.state === "completed")!
  const captureID = "a".repeat(32)
  const bodyText = '{"z":1,"z":2,"big":9007199254740993,"message":"héllo"}'
  const body = new TextEncoder().encode(bodyText)
  const chunkHash = "c".repeat(64)
  const hash = "d".repeat(64)
  const chunksPrepared = body.length + 48
  const dispatchPrepared = 77
  const encoded = chunksPrepared + dispatchPrepared
  request.capture_id = captureID
  request.transfer = { ...request.transfer, hash, body_bytes: body.length, chunks: 1, unique_chunks: 1, uploaded_chunks: 1, uploaded_chunk_bytes: body.length, missing_chunk_bytes: body.length, reused_body_bytes: 0, request_body_bytes_sent: encoded, requests: 2 }
  snapshot.inspection = { enabled: true, max_bytes: 64 << 20, max_capture_bytes: 16 << 20, max_captures: 100, max_age_seconds: 86_400, captures: 1, used_bytes: 4096, storage_error: false }
  const artifact = (id: string, source: number, captured: number, contentType: string, representation: "captured" | "redacted" = "captured") => ({ id, representation, content_type: contentType, encoding: "identity" as const, source_bytes: source, captured_bytes: captured, sha256: hash, complete: true, truncated: false, write_error: false })
  const attempt0 = { index: 0, operation: "chunks", method: "POST", path: "/v2/chunks", started_at: new Date(now - 20_000).toISOString(), finished_at: new Date(now - 19_000).toISOString(), encoding: "identity" as const, content_type: "application/vnd.deltarelay.chunks.v1", decoded_bytes: chunksPrepared, prepared_bytes: chunksPrepared, consumed_bytes: chunksPrepared, counted: true, status: 0, outcome: "transport_error", acknowledgment_ok: false, payload: artifact("attempt-0", chunksPrepared, chunksPrepared, "application/vnd.deltarelay.chunks.v1"), chunk_count: 1 }
  const attempt1 = { index: 1, operation: "dispatch", method: "PUT", path: `/v2/requests/${request.id}`, started_at: new Date(now - 18_000).toISOString(), finished_at: new Date(now - 17_000).toISOString(), encoding: "identity" as const, content_type: "application/json", decoded_bytes: dispatchPrepared, prepared_bytes: dispatchPrepared, consumed_bytes: dispatchPrepared, counted: true, status: 200, outcome: "response_ok", acknowledgment_ok: false, payload: artifact("attempt-1", dispatchPrepared, dispatchPrepared, "application/json", "redacted"), chunk_count: 0 }
  const capture = {
    version: 1, id: captureID, request_id: request.id, sequence: request.sequence, started_at: new Date(now - 21_000).toISOString(), finished_at: new Date(now - 16_000).toISOString(), state: "completed",
    body: artifact("body", body.length, body.length, "application/json"), chunk_count: 1,
    inventories: [{ index: 0, kind: "initial", observed_at: new Date(now - 20_500).toISOString(), state_id: "b".repeat(64), scope_chunks: 1, missing_chunks: 1, missing_bytes: body.length, present_body_bytes: 0, missing_body_bytes: body.length, unknown_body_bytes: 0 }],
    attempts: [attempt0, attempt1], dropped_events: 0, storage_error: false, transfer: request.transfer,
  }
  const pageData = (id: string, offset: number, limit: number) => {
    const content = id === "body" ? body : new Uint8Array(id === "attempt-0" ? chunksPrepared : dispatchPrepared).fill(120)
    const wanted = content.subarray(offset, Math.min(content.length, offset + limit))
    return json({ offset, total: content.length, data: Buffer.from(wanted).toString("base64"), decoded: false, artifact: id === "body" ? capture.body : id === "attempt-0" ? attempt0.payload : attempt1.payload })
  }
  page.setFetch((url) => {
    if (url === "/api/dashboard") return json(snapshot)
    if (url === `/api/inspection/${captureID}`) return json(capture)
    if (url.startsWith(`/api/inspection/${captureID}/artifacts/`)) {
      const parsed = new URL(url, "http://127.0.0.1")
      const id = parsed.pathname.split("/").at(-1)!
      return pageData(id, Number(parsed.searchParams.get("offset") ?? 0), Number(parsed.searchParams.get("limit") ?? 4096))
    }
    if (url.startsWith(`/api/inspection/${captureID}/chunks`)) return json({ start: 0, total: 1, inventory: 0, chunks: [{ index: 0, offset: 0, size: body.length, hash: chunkHash, availability: "missing", occurrences: 1 }] })
    if (url === `/api/inspection/${captureID}/attempts/0`) return json({ ...attempt0, chunks: [{ hash: chunkHash, size: body.length }] })
    if (url === `/api/inspection/${captureID}/attempts/1`) return json(attempt1)
    throw new Error(`Unexpected inspection URL ${url}`)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  const picker = doc.querySelector<HTMLSelectElement>("[data-measurement-request]")!
  picker.value = String(request.sequence)
  page.fire(picker, "change")
  const inspector = doc.querySelector("#request-inspector")!
  await waitForText(inspector, /Captured bytes/, "body evidence did not load")
  assert.match(inspector.textContent ?? "", /Private disk capture enabled/)
  assert.match(inspector.textContent ?? "", /héllo/)
  assert.match(inspector.textContent ?? "", new RegExp(`${body.length.toLocaleString()} B`))
  doc.querySelector<HTMLButtonElement>('[data-inspect-mode="json"]')!.click()
  await waitForText(inspector, /9007199254740993/, "lossless JSON presentation did not load")
  assert.match(inspector.textContent ?? "", /"z": 1,\s*"z": 2/)
  assert.match(inspector.textContent ?? "", /Formatting is not the captured byte layout/)

  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="inventory"]')!.click()
  await waitForText(inspector, /This page: chunks 0–0/, "inventory did not load")
  assert.equal(inspector.querySelectorAll(".inspect-chunk.missing").length, 1)
  inspector.querySelector<HTMLButtonElement>(".inspect-chunk.missing")!.click()
  await waitForText(inspector, /Selected chunk #0/, "chunk selection did not render")
  await waitForText(inspector, /c3 a9/, "chunk bytes did not load")
  assert.match(inspector.textContent ?? "", /00000030/)
  assert.match(inspector.textContent ?? "", new RegExp(`byte range \\[0, ${body.length.toLocaleString()}\\)`))

  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="upload"]')!.click()
  await waitForText(inspector, /Prepared frame layout/, "upload attempt did not load")
  assert.match(inspector.textContent ?? "", /DRLY0001/)
  assert.match(inspector.textContent ?? "", /validated chunk ACK|Not validated/)

  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="savings"]')!.click()
  await waitForText(inspector, /Retained attempts reconcile to transfer counter/, "attempt accounting did not reconcile")
  assert.match(inspector.textContent ?? "", /Body SHA-256 vs transfer hashMatch/)
  assert.match(inspector.textContent ?? "", new RegExp(`${body.length.toLocaleString()} − ${encoded.toLocaleString()}`))
  assert.match(inspector.textContent ?? "", /Extra upload/)
  measurement.destroy()
  await page.close()
})

test("measurement inspector never substitutes content for a missing capture", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const session = snapshot.history.sessions[0]!
  const request = snapshot.history.recent_requests.find((item) => item.session_id === session.id && item.state === "completed")!
  request.capture_id = "e".repeat(32)
  snapshot.inspection = { enabled: true, max_bytes: 1024, max_capture_bytes: 512, max_captures: 2, max_age_seconds: 3600, captures: 0, used_bytes: 0, storage_error: false }
  page.setFetch((url) => {
    if (url === "/api/dashboard") return json(snapshot)
    return json({ error: "capture_not_retained" }, 404)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const picker = page.document.querySelector<HTMLSelectElement>("[data-measurement-request]")!
  picker.value = String(request.sequence)
  page.fire(picker, "change")
  const inspector = page.document.querySelector("#request-inspector")!
  await waitForText(inspector, /Capture not retained/, "missing capture not reported")
  assert.equal(inspector.querySelector(".inspect-code"), null)
  assert.match(inspector.textContent ?? "", /No payload has been substituted or reconstructed/)
  measurement.destroy()
  await page.close()
})

test("measurement page shows an empty state and never invents a trace", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  snapshot.history.sessions = []
  snapshot.history.recent_requests = []
  page.setFetch(() => json(snapshot))
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLSelectElement>("#measurement-session")?.disabled, true)
  assert.match(doc.querySelector("#measurement-trace")?.textContent ?? "", /No retained sessions/)
  assert.match(doc.querySelector("#retention-note")?.textContent ?? "", /global totals are preserved/)
  measurement.destroy()
  await page.close()
})

test("overview refresh renders stats and an accessible chart without session or health markup", async () => {
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
  assert.match(doc.querySelector("#stat-requests-foot")?.textContent ?? "", /1 failed · 1 cancelled/)
  assert.match(doc.querySelector("#traffic-chart")?.innerHTML ?? "", /<svg/)
  assert.equal(doc.querySelector("#traffic-chart svg")?.getAttribute("preserveAspectRatio"), "xMidYMid meet")
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 24 hours.*72 requests/)
  assert.match(doc.querySelector("#chart-legend")?.textContent ?? "", /Bandwidth saved/)
  assert.match(doc.querySelector("#chart-legend")?.textContent ?? "", /Relay cache reuse/)
  assert.match(doc.querySelector("#chart-count")?.textContent ?? "", /72 requests · 1 failed · 1 cancelled/)
  assert.ok(doc.querySelectorAll("#traffic-chart rect.chart-bar-upload").length > 1)
  assert.equal(doc.querySelector("#session-rows"), null)
  assert.equal(doc.querySelector("#system-summary"), null)
  assert.equal(doc.querySelector<HTMLButtonElement>("#refresh-button")?.disabled, false)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))], ["/api/dashboard"])
  dashboard.destroy()
  await page.close()
})

test("traffic ranges, views, and custom dates update the chart", async () => {
  const page = openPage()
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const chart = doc.querySelector("#traffic-chart")!
  const range = doc.querySelector<HTMLSelectElement>("#chart-range")!
  const trends = doc.querySelector<HTMLButtonElement>("#chart-view-trends")!
  const composition = doc.querySelector<HTMLButtonElement>("#chart-view-composition")!

  trends.click()
  assert.equal(chart.getAttribute("data-view"), "trends")
  assert.match(chart.innerHTML, /chart-saved-line/)
  assert.match(chart.innerHTML, /chart-reuse-line/)
  assert.match(chart.getAttribute("aria-label") ?? "", /Trends view/)
  assert.equal(trends.getAttribute("aria-pressed"), "true")
  assert.equal(composition.getAttribute("aria-pressed"), "false")

  composition.click()
  assert.equal(chart.getAttribute("data-view"), "composition")
  assert.match(chart.getAttribute("aria-label") ?? "", /Composition view/)

  range.value = "7d"
  page.fire(range, "change")
  assert.match(chart.getAttribute("aria-label") ?? "", /Last 7 days/)
  assert.match(doc.querySelector("#chart-count")?.textContent ?? "", /78 requests/)
  assert.ok(doc.querySelectorAll("#traffic-chart rect.chart-bar-upload").length > 5)

  range.value = "custom"
  page.fire(range, "change")
  assert.equal(doc.querySelector<HTMLElement>("#chart-custom")?.hidden, false)
  const start = doc.querySelector<HTMLInputElement>("#chart-start")!
  const end = doc.querySelector<HTMLInputElement>("#chart-end")!
  assert.ok(start.value)
  assert.ok(end.value)
  start.value = end.value
  doc.querySelector<HTMLButtonElement>("#chart-apply")!.click()
  assert.equal(doc.querySelector<HTMLElement>("#chart-notice")?.hidden, true)

  start.value = dateInputValue(now)
  end.value = dateInputValue(now - 86_400_000)
  doc.querySelector<HTMLButtonElement>("#chart-apply")!.click()
  assert.match(doc.querySelector("#chart-notice")?.textContent ?? "", /start date/)
  dashboard.destroy()
  await page.close()
})

test("older gateways fall back to retained request entries", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  delete snapshot.history.traffic
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.match(doc.querySelector("#traffic-chart")?.innerHTML ?? "", /<svg/)
  assert.match(doc.querySelector("#chart-notice")?.textContent ?? "", /does not expose traffic aggregates/)
  assert.match(doc.querySelector("#chart-notice")?.textContent ?? "", /retained request entries/)
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
  assert.equal(doc.querySelector<HTMLButtonElement>("#refresh-button")?.disabled, false)
  dashboard.destroy()
  await page.close()
})

test("sessions page renders only the session table and updates the sidebar count", async () => {
  const page = openPage("sessions")
  const snapshot = makeSnapshot(now)
  page.setFetch((url) => {
    assert.equal(url, "/api/dashboard")
    return json(snapshot)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#stat-sessions"), null)
  assert.equal(doc.querySelector("#traffic-chart"), null)
  assert.equal(doc.querySelector("#system-summary"), null)
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(doc.querySelector("#session-count")?.textContent, "6")
  assert.equal(doc.querySelector("#nav-session-count")?.textContent, "6")
  assert.match(doc.querySelector("#table-summary")?.textContent ?? "", /1–6 of 6 sessions/)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))], ["/api/dashboard"])
  dashboard.destroy()
  await page.close()
})

test("session filtering and pagination only render retained matches", async () => {
  const page = openPage("sessions")
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
  const page = openPage("sessions")
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
  const page = openPage("sessions")
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
    assert.match(csv, /^"session_id","upstream","requests","active","failed","cancelled"/)
    assert.match(csv, /"'=SUM\(A1\)","'@command"/)
    assert.match(download, /^deltarelay-sessions-\d{4}-\d{2}-\d{2}\.csv$/)
    assert.match(sessionCsv(snapshot.history.sessions), /"'=SUM\(A1\)"/)
    dashboard.destroy()
  } finally {
    page.window.HTMLAnchorElement.prototype.click = click
  }
  await page.close()
})

test("system health combines gateway diagnostics with supervisor network state", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  const status = systemStatus()
  page.setFetch((url) => {
    if (url === "/api/dashboard") return json(snapshot)
    if (url === "/api/system") return json(status)
    throw new Error(`Unexpected URL ${url}`)
  })
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  assert.match(doc.querySelector("#system-summary")?.textContent ?? "", /Relay checks passed/)
  assert.equal(doc.querySelector("#session-rows"), null)
  assert.equal(doc.querySelector("#stat-sessions"), null)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))].sort(), ["/api/dashboard", "/api/system"])
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("system health distinguishes no internet from an unreachable VPS", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  snapshot.relay.reachable = false
  const noInternet = systemStatus({ relay_state: "unreachable", internet_state: "unreachable" })
  page.setFetch((url) => url === "/api/dashboard" ? json(snapshot) : json(noInternet))
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  assert.match(page.document.querySelector("#system-summary")?.textContent ?? "", /No internet/)
  assert.match(page.document.querySelector("#system-cards")?.textContent ?? "", /Internet connectivity from this computer failed/)
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("pausing the health page freezes both the dashboard and supervisor schedules", async () => {
  const page = openPage("system")
  page.setFetch((url) => url === "/api/dashboard" ? json(makeSnapshot(now)) : json(systemStatus()))
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, {
    autoStart: false,
    onPauseChange: (paused) => paused ? system.pause() : system.resume(),
  })
  await Promise.all([dashboard.refresh(), system.refresh()])
  page.document.querySelector<HTMLButtonElement>("#pause-button")!.click()
  assert.equal(dashboard.paused, true)
  assert.equal(system.paused, true)
  assert.equal(page.document.querySelector("#connection-label")?.textContent, "Paused")
  page.document.querySelector<HTMLButtonElement>("#pause-button")!.click()
  assert.equal(dashboard.paused, false)
  assert.equal(system.paused, false)
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("controls page polls only the supervisor and keeps controls available", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  page.setFetch((url) => {
    assert.equal(url, "/api/system")
    return json(status)
  })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#recover-all")?.disabled, false)
  assert.equal(doc.querySelector<HTMLButtonElement>("#auto-reconnect")?.disabled, false)
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Connected")
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Live")
  assert.equal(doc.querySelector("#stat-sessions"), null)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))], ["/api/system"])
  system.destroy()
  await page.close()
})

test("pausing supervisor polling leaves manual refresh available", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  doc.querySelector<HTMLButtonElement>("#pause-button")!.click()
  assert.equal(system.paused, true)
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Paused")
  assert.equal(doc.querySelector("#refresh-note")?.textContent, "Automatic refresh paused")
  const calls = page.fetchCalls.length
  doc.querySelector<HTMLButtonElement>("#refresh-button")!.click()
  assert.equal(page.fetchCalls.length, calls + 1)
  doc.querySelector<HTMLButtonElement>("#pause-button")!.click()
  assert.equal(system.paused, false)
  system.destroy()
  await page.close()
})

test("Desktop launch sends one protected same-origin action and blocks duplicates", async () => {
  const page = openPage("controls")
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
  const system = startSystemStatus(page.document, { autoStart: false })
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

test("stale or unmanaged supervisor status keeps every service control disabled", async () => {
  const page = openPage("controls")
  let status = systemStatus({ managed: false })
  page.setFetch(() => json(status))
  const system = startSystemStatus(page.document, { autoStart: false })
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
  assert.match(doc.querySelector("#connection-label")?.textContent ?? "", /Disconnected/)
  system.destroy()
  await page.close()
})
