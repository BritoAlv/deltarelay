import test from "node:test"
import assert from "node:assert/strict"
import { json, openPage } from "./browser.js"
import { startDashboard } from "../src/scripts/dashboard.js"
import { startMeasurementPage } from "../src/scripts/measurement-page.js"
import { startSystemStatus } from "../src/scripts/system.js"
import { makeOpenCodeSessions, makeSnapshot } from "./fixture.js"
import { sessionCsv } from "../src/lib/csv.js"
import { dateInputValue } from "../src/lib/traffic.js"
import { sessionDayKey } from "../src/lib/session-catalog.js"
import type { SystemStatus } from "../src/lib/system.js"
import type { SetupStatus } from "../src/lib/setup.js"
import { isTopology, type RecoveryRun } from "../src/lib/topology.js"
import { readContract } from "./contracts.js"

const now = Date.parse("2026-10-28T12:15:00Z")

async function waitForText(node: Element | null, pattern: RegExp, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (pattern.test(node?.textContent ?? "")) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`${label}: ${node?.textContent ?? ""}`)
}

function selectRequest(doc: Document, request: { id: string }): void {
  const more = doc.querySelector<HTMLButtonElement>("[data-trace-more]")
  if (more) more.click()
  const row = [...doc.querySelectorAll<HTMLDetailsElement>("details[data-request-id]")].find((item) => item.dataset.requestId === request.id)
  assert.ok(row, `missing request row ${request.id}`)
  row.querySelector<HTMLButtonElement>("[data-inspect-request]")!.click()
}

function systemStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  const topology = readContract("topology-v1.json")
  assert.ok(isTopology(topology))
  if (overrides.relay_state && overrides.relay_state !== "connected") {
    for (const node of topology.nodes.filter((node) => ["relay", "tunnel"].includes(node.id))) node.readiness = "unknown"
    topology.edges.find((edge) => edge.id === "tunnel_relay")!.state = "unknown"
  }
  if (overrides.remote) {
    const remote = topology.nodes.find((node) => node.id === "remote")!
    remote.label = overrides.remote.label
    remote.lifecycle = overrides.remote.host_state
    remote.actions = overrides.remote.capabilities.flatMap((capability) => capability === "host.wake" ? ["wake" as const] : capability === "host.stop" ? ["stop" as const] : [])
  }
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
    topology,
    ...overrides,
  }
}

function abortError(): Error {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}

function setupStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return { version: 1, available: false, required: false, busy: false, last_error: "", target: null, ...overrides }
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
  assert.equal(page.document.querySelector("#connection-label")?.textContent, "Connecting…")
  assert.equal(page.document.querySelector("#stat-sessions")?.textContent, "—")
  assert.match(page.document.querySelector("#traffic-chart")?.textContent ?? "", /Waiting for local data/)
  assert.equal(page.document.querySelector("#session-rows"), null)
  assert.equal(page.document.querySelector("#system-cards"), null)
  dashboard.destroy()
  await page.close()
})

test("measurement page renders definitions, browses stored sessions, and traces a selected session", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const catalog = makeOpenCodeSessions(now)
  page.setFetch((url) => {
    if (url === "/api/dashboard") return json(snapshot)
    if (url === "/api/opencode/sessions") return json(catalog)
    throw new Error(`Unexpected measurement URL ${url}`)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#measurement-connection-label")?.textContent, "Live")
  assert.match(doc.querySelector("#measurement")?.textContent ?? "", /Original body/)
  assert.match(doc.querySelector("#measurement")?.textContent ?? "", /Encoded upload/)
  await waitForText(doc.querySelector("#measurement-session-trigger-title"), /Relay dashboard measurement/, "catalog title did not load")
  const trigger = doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!
  assert.equal(trigger.disabled, false)
  const trace = doc.querySelector("#measurement-trace")!
  assert.match(trace.textContent ?? "", /Relay dashboard measurement/)
  assert.match(trace.textContent ?? "", /From body to wire/)
  assert.match(trace.textContent ?? "", /Requests in this session/)
  assert.match(trace.textContent ?? "", /Transfer totals pending/)
  assert.match(trace.textContent ?? "", /Show all .* retained requests/i)
  assert.match(trace.textContent ?? "", /not captured/)
  assert.match(trace.textContent ?? "", /Selected request/)
  assert.equal(trace.querySelector("[data-measurement-request]"), null)
  assert.equal(trace.querySelector("[data-pipeline-stage]"), null)
  const ledgerRow = [...trace.querySelectorAll<HTMLDetailsElement>("details[data-request-id]")][1]!
  ledgerRow.open = true
  page.fire(ledgerRow, "toggle")
  assert.equal(trace.querySelector(".trace-selected-request code")?.textContent, ledgerRow.dataset.requestId)
  assert.match(trace.textContent ?? "", /Requests in this session/)
  assert.match(doc.querySelector("#request-inspector")?.textContent ?? "", /Payload capture is off or not reported/)
  assert.match(doc.querySelector("#request-inspector")?.textContent ?? "", /Not captured/)
  assert.match(doc.querySelector("#retention-note")?.textContent ?? "", /Keeps up to 256 gateway sessions and 1,000 requests/)

  trigger.click()
  const dialog = doc.querySelector<HTMLDialogElement>("#measurement-session-dialog")!
  assert.equal(dialog.open, true)
  assert.match(dialog.textContent ?? "", /All sessions stored by OpenCode/)
  assert.match(dialog.textContent ?? "", /Only sessions with gateway measurements can be traced/)
  const choices = [...dialog.querySelectorAll<HTMLButtonElement>("[data-session-choice]")]
  assert.equal(choices.length, 8)
  assert.equal(dialog.querySelector("#measurement-session-page")?.textContent, "Page 1 of 2")
  assert.equal(dialog.querySelector<HTMLButtonElement>("#measurement-session-next")?.disabled, false)
  const unmeasured = choices.find((choice) => choice.dataset.sessionChoice === "ses_unmeasured_recent")!
  assert.equal(unmeasured.getAttribute("aria-disabled"), "true")
  unmeasured.click()
  assert.equal(dialog.open, true)
  assert.match(dialog.querySelector("#measurement-session-notice")?.textContent ?? "", /no retained gateway measurements/)
  assert.match(trace.textContent ?? "", /Relay dashboard measurement/)

  const second = [...dialog.querySelectorAll<HTMLButtonElement>("[data-session-choice]")].find((choice) => choice.dataset.sessionChoice === snapshot.history.sessions[1]!.id)!
  second.click()
  assert.equal(dialog.open, false)
  assert.match(trace.textContent ?? "", /API refactor/)
  assert.equal(new URL(page.window.location.href).searchParams.get("session"), snapshot.history.sessions[1]!.id)

  trigger.click()
  dialog.querySelector<HTMLButtonElement>("#measurement-session-next")!.click()
  assert.equal(dialog.querySelector("#measurement-session-page")?.textContent, "Page 2 of 2")
  assert.equal(dialog.querySelectorAll("[data-session-choice]").length, 2)
  dialog.querySelector<HTMLButtonElement>("#measurement-session-previous")!.click()
  const day = sessionDayKey(new Date(now - 72 * 3_600_000).toISOString())
  const daySelect = dialog.querySelector<HTMLSelectElement>("#measurement-session-day")!
  daySelect.value = day
  page.fire(daySelect, "change")
  assert.equal(dialog.querySelectorAll("[data-session-choice]").length, 1)
  assert.match(dialog.querySelector("#measurement-session-summary")?.textContent ?? "", /1–1 of 1/)
  daySelect.value = ""
  page.fire(daySelect, "change")
  const search = dialog.querySelector<HTMLInputElement>("#measurement-session-search")!
  search.value = "Old migration"
  page.fire(search, "input")
  assert.equal(dialog.querySelectorAll("[data-session-choice]").length, 1)
  assert.match(dialog.textContent ?? "", /Old migration notes/)
  search.value = ""
  page.fire(search, "input")
  dialog.querySelector<HTMLButtonElement>("#close-measurement-session")!.click()
  assert.equal(dialog.open, false)
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
  const attempt0 = { index: 0, operation: "chunks", method: "POST", path: "/chunks", started_at: new Date(now - 20_000).toISOString(), finished_at: new Date(now - 19_000).toISOString(), encoding: "identity" as const, content_type: "application/vnd.deltarelay.chunks.v1", decoded_bytes: chunksPrepared, prepared_bytes: chunksPrepared, consumed_bytes: chunksPrepared, counted: true, status: 0, outcome: "transport_error", acknowledgment_ok: false, payload: artifact("attempt-0", chunksPrepared, chunksPrepared, "application/vnd.deltarelay.chunks.v1"), chunk_count: 1 }
  const attempt1 = { index: 1, operation: "dispatch", method: "PUT", path: `/requests/${request.id}`, started_at: new Date(now - 18_000).toISOString(), finished_at: new Date(now - 17_000).toISOString(), encoding: "identity" as const, content_type: "application/json", decoded_bytes: dispatchPrepared, prepared_bytes: dispatchPrepared, consumed_bytes: dispatchPrepared, counted: true, status: 200, outcome: "response_ok", acknowledgment_ok: false, payload: artifact("attempt-1", dispatchPrepared, dispatchPrepared, "application/json", "redacted"), chunk_count: 0 }
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
    if (url === "/api/opencode/sessions") return json(makeOpenCodeSessions(now))
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
  selectRequest(doc, request)
  const inspector = doc.querySelector("#request-inspector")!
  await waitForText(inspector, /Captured bytes/, "body evidence did not load")
  assert.match(inspector.textContent ?? "", /Private disk capture enabled/)
  assert.match(inspector.textContent ?? "", /héllo/)
  assert.match(inspector.textContent ?? "", new RegExp(`${body.length.toLocaleString()}\\u00A0B`))
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
    if (url === "/api/opencode/sessions") return json(makeOpenCodeSessions(now))
    return json({ error: "capture_not_retained" }, 404)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  selectRequest(page.document, request)
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
  const emptyCatalog = { version: 1 as const, checked_at: new Date(now).toISOString(), sessions: [], truncated: false, stale: false }
  page.setFetch((url) => url === "/api/dashboard" ? json(snapshot) : json(emptyCatalog))
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")?.disabled, true)
  assert.match(doc.querySelector("#measurement-trace")?.textContent ?? "", /No retained sessions/)
  assert.match(doc.querySelector("#retention-note")?.textContent ?? "", /global totals are preserved/)
  measurement.destroy()
  await page.close()
})

test("measurement browser lists OpenCode sessions without gateway measurements", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  snapshot.history.sessions = []
  snapshot.history.recent_requests = []
  const catalog = makeOpenCodeSessions(now)
  page.setFetch((url) => url === "/api/dashboard" ? json(snapshot) : json(catalog))
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  await waitForText(doc.querySelector("#measurement-session-trigger-title"), /Choose a session/, "catalog-only trigger did not load")
  assert.match(doc.querySelector("#measurement-trace")?.textContent ?? "", /No gateway measurements/)
  doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!.click()
  assert.equal(doc.querySelectorAll("#measurement-session-dialog [data-session-choice]").length, 8)
  assert.match(doc.querySelector("#measurement-session-dialog")?.textContent ?? "", /No gateway data/)
  measurement.destroy()
  await page.close()
})

test("measurement browser falls back to gateway sessions when OpenCode metadata is unavailable", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  page.setFetch((url) => {
    if (url === "/api/dashboard") return json(snapshot)
    return json({ error: "opencode_not_configured" }, 503)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  await waitForText(doc.querySelector("#measurement-session-trigger-title"), /ses_7fd82a_relay-dashboard/, "gateway fallback did not load")
  doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!.click()
  const dialog = doc.querySelector<HTMLDialogElement>("#measurement-session-dialog")!
  assert.match(dialog.textContent ?? "", /OpenCode session metadata is unavailable/)
  assert.equal(dialog.querySelectorAll("[data-session-choice]").length, 6)
  assert.equal(dialog.querySelectorAll("[aria-disabled='true']").length, 0)
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

test("traffic range and view are deep-linked through the URL", async () => {
  const page = openPage()
  page.window.history.replaceState(null, "", "/?range=7d&view=trends")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const range = doc.querySelector<HTMLSelectElement>("#chart-range")!
  const trends = doc.querySelector<HTMLButtonElement>("#chart-view-trends")!
  const composition = doc.querySelector<HTMLButtonElement>("#chart-view-composition")!
  const chart = doc.querySelector("#traffic-chart")!
  assert.equal(range.value, "7d")
  assert.equal(trends.getAttribute("aria-pressed"), "true")
  assert.match(chart.getAttribute("aria-label") ?? "", /Last 7 days.*Trends view/)

  composition.click()
  assert.equal(new URL(page.window.location.href).searchParams.get("view"), null)
  range.value = "30d"
  page.fire(range, "change")
  assert.equal(new URL(page.window.location.href).searchParams.get("range"), "30d")
  dashboard.destroy()
  await page.close()
})

test("session search, state, and pagination are deep-linked through the URL", async () => {
  const page = openPage("sessions")
  page.window.history.replaceState(null, "", "/sessions?q=api&state=idle&page=2")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const search = doc.querySelector<HTMLInputElement>("#session-search")!
  const filter = doc.querySelector<HTMLSelectElement>("#session-filter")!
  assert.equal(search.value, "api")
  assert.equal(filter.value, "idle")
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 1 of 1")
  assert.equal(new URL(page.window.location.href).searchParams.get("page"), null)

  search.value = "openai"
  page.fire(search, "input")
  filter.value = "all"
  page.fire(filter, "change")
  const params = new URL(page.window.location.href).searchParams
  assert.equal(params.get("q"), "openai")
  assert.equal(params.get("state"), null)
  dashboard.destroy()
  await page.close()
})

test("measurement session selection is deep-linked through the URL", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const catalog = makeOpenCodeSessions(now)
  const target = snapshot.history.sessions[2]!
  page.window.history.replaceState(null, "", `/measurement?session=${encodeURIComponent(target.id)}&q=Test&day=${sessionDayKey(target.started_at)}&show=measured&page=2`)
  page.setFetch((url) => url === "/api/dashboard" ? json(snapshot) : json(catalog))
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  await waitForText(doc.querySelector("#measurement-session-trigger-title"), /Test suite/, "deep-linked catalog title did not load")
  doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!.click()
  const dialog = doc.querySelector<HTMLDialogElement>("#measurement-session-dialog")!
  assert.equal(dialog.querySelector<HTMLInputElement>("#measurement-session-search")?.value, "Test")
  assert.equal(dialog.querySelector<HTMLSelectElement>("#measurement-session-availability")?.value, "measured")
  assert.equal(dialog.querySelector<HTMLSelectElement>("#measurement-session-day")?.value, sessionDayKey(target.started_at))
  const search = dialog.querySelector<HTMLInputElement>("#measurement-session-search")!
  search.value = ""
  page.fire(search, "input")
  const daySelect = dialog.querySelector<HTMLSelectElement>("#measurement-session-day")!
  daySelect.value = ""
  page.fire(daySelect, "change")
  const next = snapshot.history.sessions[1]!
  const choice = [...dialog.querySelectorAll<HTMLButtonElement>("[data-session-choice]")].find((button) => button.dataset.sessionChoice === next.id)!
  choice.click()
  assert.equal(new URL(page.window.location.href).searchParams.get("session"), next.id)
  assert.equal(new URL(page.window.location.href).searchParams.get("q"), null)
  assert.equal(new URL(page.window.location.href).searchParams.get("show"), "measured")
  measurement.destroy()
  await page.close()
})

test("missing traffic aggregates are rejected instead of reconstructing old request entries", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now) as { history: { traffic?: unknown } }
  delete snapshot.history.traffic
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Disconnected")
  assert.match(doc.querySelector("#notice")?.textContent ?? "", /incompatible diagnostics/)
  assert.doesNotMatch(doc.querySelector("#traffic-chart")?.innerHTML ?? "", /<svg/)
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
  assert.equal(new URL(page.window.location.href).searchParams.get("session"), button.dataset.sessionId)
  assert.match(doc.querySelector("#session-detail")?.textContent ?? "", /Recent requests/)
  doc.querySelector<HTMLButtonElement>("#close-detail")!.click()
  assert.equal(dialog.open, false)
  assert.equal(new URL(page.window.location.href).searchParams.get("session"), null)
  dashboard.destroy()
  await page.close()
})

test("session detail deep links open after the first successful load", async () => {
  const page = openPage("sessions")
  const snapshot = makeSnapshot(now)
  const target = snapshot.history.sessions[3]!
  page.window.history.replaceState(null, "", `/sessions?session=${encodeURIComponent(target.id)}`)
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const dialog = doc.querySelector<HTMLDialogElement>("#session-dialog")!
  assert.equal(dialog.open, true)
  assert.equal(doc.querySelector("#detail-title")?.textContent, target.id)
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

test("controls show the full map, not service lists or logs, and poll only the supervisor", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  page.setFetch((url) => {
    if (url === "/api/system/setup") return json(setupStatus())
    assert.equal(url, "/api/system")
    return json(status)
  })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, false)
  assert.equal(doc.querySelector<HTMLButtonElement>("#auto-reconnect")?.disabled, false)
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Relay connected")
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Live")
  assert.equal(doc.querySelector("#stat-sessions"), null)
  assert.equal(doc.querySelectorAll("[data-node-id]").length, 14)
  assert.equal(doc.querySelector("#service-controls"), null)
  assert.equal(doc.querySelector("#activity-console"), null)
  assert.ok(doc.querySelector("#auth-countdown"))
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))], ["/api/system", "/api/system/setup"])
  system.destroy()
  await page.close()
})

test("map shows the active recovery step and system shutdown keeps control services explicit", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  const run: RecoveryRun = {
    version: 1, id: "a".repeat(16), request_id: "", target: "connection", action: "recover",
    trigger: "automatic", status: "running", current_component: "tunnel", current_action: "recover",
    started_at: new Date(now).toISOString(), finished_at: null, error: "",
    steps: [{ component: "tunnel", action: "recover", status: "running", started_at: new Date(now).toISOString(), finished_at: null, error: "" }],
  }
  status.topology!.run = run
  status.topology!.nodes.find((node) => node.id === "tunnel")!.activity = "recover"
  let action: Record<string, unknown> | undefined
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(status)
    if (url === "/api/system/setup") return json(setupStatus())
    assert.equal(url, "/api/system/action")
    action = JSON.parse(String(init.body))
    return json({ accepted: true, operation_id: run.id }, 202)
  })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  const tunnel = doc.querySelector<HTMLButtonElement>('[data-node-id="tunnel"]')!
  assert.equal(tunnel.classList.contains("is-working"), true)
  assert.match(tunnel.textContent ?? "", /recover…/)
  assert.match(doc.querySelector("#recovery-status")?.textContent ?? "", /Encrypted tunnel: recover/)
  assert.match(doc.querySelector("#recovery-steps")?.textContent ?? "", /tunnel: recover · running/)
  const shutdown = doc.querySelector<HTMLButtonElement>("#stop-system")!
  assert.equal(shutdown.disabled, true, "conflicting lifecycle actions stay disabled during a run")
  run.status = "completed"
  run.steps[0]!.status = "completed"
  status.topology!.nodes.find((node) => node.id === "tunnel")!.activity = "idle"
  await system.refresh()
  const readyShutdown = doc.querySelector<HTMLButtonElement>("#stop-system")!
  assert.equal(readyShutdown.disabled, false)
  page.setConfirm((message) => {
    assert.match(message ?? "", /dashboard and supervisor stay running.*PC stays on/i)
    return true
  })
  shutdown.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(String(action?.request_id), /^[a-f0-9]{32}$/)
  assert.deepEqual({ ...action, request_id: undefined }, { component: "all", action: "stop", confirmed: true, request_id: undefined })
  assert.equal(doc.querySelector("#service-controls"), null)
  assert.equal(doc.querySelector("#activity-console"), null)
  system.destroy()
  await page.close()
})

test("controls explain a stopped tunnel when internet works but automatic reconnect is off", async () => {
  const page = openPage("controls")
  const status = systemStatus({ relay_state: "unreachable", settings: { auto_reconnect: false, auto_wake: false } })
  page.setFetch(() => json(status))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  assert.equal(page.document.querySelector("#control-connection")?.textContent, "Connection unavailable")
  assert.match(page.document.querySelector("#recovery-status")?.textContent ?? "", /Automatic recovery is off.*Start system/)
  assert.equal(page.document.querySelector<HTMLInputElement>("#auto-reconnect")?.checked, false)
  assert.equal(page.document.querySelector<HTMLButtonElement>("#start-system")?.disabled, false)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false, "displaying a paused link must not change recovery settings")
  system.destroy()
  await page.close()
})

test("Wake follows the entire connection operation with recovery settings off and never treats host availability as connected", async () => {
  const page = openPage("controls")
  let status = systemStatus({
    relay_state: "unreachable",
    settings: { auto_reconnect: false, auto_wake: false },
    remote: { id: "codespaces", label: "GitHub Codespaces", host_state: "stopped", capabilities: ["host.wake", "host.stop"] },
  })
  const actions: RequestInit[] = []
  let release: (response: Response) => void = () => undefined
  const held = new Promise<Response>((resolve) => { release = resolve })
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(status)
    if (url === "/api/system/setup") return json(setupStatus())
    assert.equal(url, "/api/system/action")
    actions.push(init)
    status = { ...status, recovery: { ...status.recovery, busy: true, phase: "waking_remote_host" } }
    return held
  })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  page.document.querySelector<HTMLButtonElement>('[data-node-id="remote"]')!.click()
  const button = page.document.querySelector<HTMLButtonElement>('[data-component-action="wake"]')!
  assert.equal(button.disabled, false)
  page.setConfirm(() => false)
  button.click()
  assert.equal(actions.length, 0)
  page.setConfirm((message) => { assert.match(message ?? "", /billing/); return true })
  button.click()
  button.click()
  assert.equal(actions.length, 1)
  const action = JSON.parse(String(actions[0]!.body))
  assert.match(action.request_id, /^[a-f0-9]{32}$/)
  delete action.request_id
  assert.deepEqual(action, { component: "remote", action: "wake", confirmed: true })
  assert.deepEqual(actions[0]!.headers, { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
  release(json({ accepted: true }, 202))
  await waitForText(page.document.querySelector("#recovery-status"), /connecting and verifying the relay comes next/, "wake progress")
  assert.equal(page.document.querySelector("#control-connection")?.textContent, "Recovering")
  assert.equal(page.document.querySelector<HTMLButtonElement>('[data-component-action="wake"]')!.disabled, true)

  status = { ...status, remote: { ...status.remote, host_state: "running" }, recovery: { ...status.recovery, phase: "connecting_tunnel" } }
  await system.refresh()
  assert.equal(page.document.querySelector("#control-connection")?.textContent, "Recovering")
  assert.match(page.document.querySelector("#recovery-status")?.textContent ?? "", /running host alone is not a working connection/)
  assert.equal(page.document.querySelector<HTMLButtonElement>("#start-system")?.disabled, true)

  status = { ...status, relay_state: "connected", recovery: { ...status.recovery, busy: false, phase: "monitoring", last_connected_at: new Date(now).toISOString() } }
  await system.refresh()
  assert.equal(page.document.querySelector("#control-connection")?.textContent, "Relay connected")
  assert.equal(page.document.querySelector<HTMLInputElement>("#auto-reconnect")?.checked, false)
  assert.equal(page.document.querySelector<HTMLInputElement>("#auto-wake")?.checked, false)
  assert.equal(actions.length, 1, "polling progress must not submit recovery again or change settings")
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
  assert.equal(page.fetchCalls.length, calls + 2)
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
  page.document.querySelector<HTMLButtonElement>('[data-node-id="desktop"]')!.click()
  const button = page.document.querySelector<HTMLButtonElement>('[data-component-action="start"]')!
  assert.equal(button.disabled, false)
  button.click()
  button.click()
  assert.equal(actions.length, 1)
  const action = actions[0] as Record<string, unknown>
  assert.match(String(action.request_id), /^[a-f0-9]{32}$/)
  delete action.request_id
  assert.deepEqual(action, { component: "desktop", action: "start", confirmed: false })
  assert.deepEqual(actionHeaders[0], { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
  assert.equal(page.document.querySelector<HTMLButtonElement>('[data-component-action="start"]')!.disabled, true)
  release(json({ accepted: true }, 202))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(page.document.querySelector("#activity-console"), null)
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
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, true)
  assert.ok([...doc.querySelectorAll<HTMLButtonElement>("#node-actions button")].every((button) => button.disabled))
  status = systemStatus()
  page.setFetch(() => json(status))
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, false)
  page.setFetch(() => { throw new Error("offline") })
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, true)
  assert.ok([...doc.querySelectorAll<HTMLButtonElement>("#node-actions button")].every((button) => button.disabled))
  assert.match(doc.querySelector("#connection-label")?.textContent ?? "", /Disconnected/)
  system.destroy()
  await page.close()
})

test("first-run setup requires confirmation, sends a single protected install, and follows server progress", async () => {
  const page = openPage("controls")
  let status = setupStatus({ available: true, required: true })
  let systemState = systemStatus({ relay_state: "unknown" })
  const installs: RequestInit[] = []
  let release: (response: Response) => void = () => undefined
  const held = new Promise<Response>((resolve) => { release = resolve })
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(systemState)
    if (url === "/api/system/setup" && init.method === "POST") { installs.push(init); return held }
    if (url === "/api/system/setup") return json(status)
    throw new Error(`Unexpected URL ${url}`)
  })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const root = page.document.querySelector<HTMLElement>("#remote-setup")!
  const form = page.document.querySelector<HTMLFormElement>("#remote-setup-form")!
  const button = page.document.querySelector<HTMLButtonElement>("#setup-submit")!
  page.document.querySelector<HTMLInputElement>("#setup-target")!.value = "user@my-host"
  assert.equal(root.hidden, false)
  assert.equal(button.disabled, false)
  assert.equal(installs.length, 0, "loading first run must never install automatically")
  page.setConfirm(() => false)
  page.fire(form, "submit")
  assert.equal(installs.length, 0)
  page.setConfirm((message) => { assert.match(message ?? "", /compute charges/); return true })
  page.fire(form, "submit")
  page.fire(form, "submit")
  assert.equal(installs.length, 1)
  assert.equal(button.disabled, true)
  assert.deepEqual(JSON.parse(String(installs[0]!.body)), { provider: "ssh", target: "user@my-host", remote_directory: "~/.local/share/deltarelay", ssh_port: 22, remote_port: 8787, confirmed: true })
  assert.deepEqual(installs[0]!.headers, { "Content-Type": "application/json", "X-DeltaRelay-Control": systemState.csrf_token })
  status = { ...status, busy: true }
  systemState = { ...systemState, recovery: { ...systemState.recovery, busy: true, phase: "setting_up_remote_host" } }
  release(json({ accepted: true }, 202))
  await waitForText(page.document.querySelector("#setup-detail"), /running independently/, "setup progress")
  assert.equal(button.disabled, true)
  status = setupStatus()
  systemState = systemStatus()
  await system.refresh()
  assert.equal(root.hidden, true)
  assert.equal(page.document.querySelector("#control-connection")?.textContent, "Relay connected")
  system.destroy()
  await page.close()
})

test("interrupted remote setup restores the locked destination and stale setup disables only installation", async () => {
  const page = openPage("controls")
  const status = setupStatus({ available: true, required: true, last_error: "command_timeout", target: { provider: "codespaces", target: "existing-codespace", remote_directory: "~/private-relay", ssh_port: 22, remote_port: 18787 } })
  let setupFails = false
  page.setFetch((url) => {
    if (url === "/api/system") return json(systemStatus())
    if (setupFails) throw new Error("setup status unavailable")
    return json(status)
  })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLInputElement>("#setup-target")?.value, "existing-codespace")
  assert.equal(doc.querySelector<HTMLInputElement>("#setup-target")?.disabled, true)
  assert.equal(doc.querySelector<HTMLElement>("#setup-ssh-port-label")?.hidden, true)
  assert.match(doc.querySelector("#setup-submit")?.textContent ?? "", /Resume/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#setup-submit")?.disabled, false)
  setupFails = true
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#setup-submit")?.disabled, true)
  assert.match(doc.querySelector("#setup-detail")?.textContent ?? "", /stale/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, false)
  system.destroy()
  await page.close()
})
