import test from "node:test"
import assert from "node:assert/strict"
import { json, openPage } from "./browser.js"
import { startDashboard } from "../src/scripts/dashboard.js"
import { startMeasurementPage } from "../src/scripts/measurement-page.js"
import { startSystemStatus } from "../src/scripts/system.js"
import { renderBrandStatus } from "../src/scripts/features/brand-status.js"
import { makeOpenCodeSessions, makeSnapshot, makeSystemHistory } from "./fixture.js"
import { sessionCsv } from "../src/lib/csv.js"
import { dateInputValue, presetRange, trafficData } from "../src/lib/traffic.js"
import { sessionDayKey } from "../src/lib/session-catalog.js"
import type { SystemStatus } from "../src/lib/system.js"
import type { SetupStatus } from "../src/lib/setup.js"
import { edgeChannel, isTopology, type RecoveryRun } from "../src/lib/topology.js"
import { mapLayerSegments, mapNodes, nodeHeight, nodeWidth, responsePath } from "../src/lib/topology-layout.js"
import { readContract } from "./contracts.js"
import { readPreferences } from "../src/lib/preferences.js"

const now = Date.parse("2026-10-28T12:15:00Z")

test("brand and favicon update together on every dashboard page", async () => {
  for (const name of ["index", "sessions", "measurement", "controls", "system"] as const) {
    const page = openPage(name)
    try {
      const brand = page.document.querySelector<HTMLElement>(".brand")!
      const compactBrand = page.document.querySelector<HTMLElement>(".topbar-brand")!
      const favicon = page.document.querySelector('link[rel="icon"]')!
      const connected = systemStatus()
      for (const [system, stale, expected] of [
        [connected, false, "connected"],
        [{ ...connected, recovery: { ...connected.recovery, busy: true } }, false, "recovering"],
        [{ ...connected, relay_state: "unreachable", remote: { ...connected.remote, host_state: "stopped" } }, false, "stopped"],
        [connected, true, "unknown"],
      ] as const) {
        renderBrandStatus(page.document, system, stale)
        assert.equal(brand.dataset.status, expected)
        assert.equal(compactBrand.dataset.status, expected)
        assert.match(brand.getAttribute("aria-label")!, new RegExp(expected === "unknown" ? "Status unavailable" : expected, "i"))
        assert.equal(favicon.getAttribute("href"), expected === "unknown" ? "/favicon.svg" : `/_astro/favicon-${expected}.svg`)
      }
    } finally {
      await page.close()
    }
  }
})

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

function parseBytesLabel(text: string | undefined): number {
  const match = (text ?? "").replace(/\u00A0/g, " ").match(/([\d.,]+)\s*(B|KiB|MiB|GiB|TiB)/)
  assert.ok(match, `not a byte label: ${text}`)
  const value = Number(match[1]!.replaceAll(",", ""))
  const unit = ["B", "KiB", "MiB", "GiB", "TiB"].indexOf(match[2]!)
  return value * 1024 ** unit
}

function parsePercentLabel(text: string | undefined): number {
  const match = (text ?? "").replace(",", ".").match(/-?[\d.]+(?=%)/)
  assert.ok(match, `not a percentage: ${text}`)
  return Number(match[0])
}

function openColumnFilter(doc: Document, key: string): HTMLElement {
  const trigger = doc.querySelector<HTMLButtonElement>(`button[data-filter-key="${key}"]`)
  assert.ok(trigger, `missing ${key} filter trigger`)
  trigger.click()
  const popover = doc.querySelector<HTMLElement>("#session-filter-popover")
  assert.ok(popover, "missing session filter popover")
  return popover
}

function openComponentFilter(doc: Document, key: string): HTMLElement {
  doc.querySelector<HTMLButtonElement>(`#component-table-scroll button[data-filter-key="${key}"]`)!.click()
  const popover = doc.querySelector<HTMLElement>("#component-filter-popover")!
  assert.equal(popover.hidden, false)
  return popover
}

function ascending(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value)
}

function descending(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! >= value)
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
    assert.equal(browser.document.querySelector(".sidebar-version")?.textContent?.trim(), "DELTARELAY")
    await browser.close()
  }
})

test("initial overview state loads without presenting fabricated diagnostics", async () => {
  const page = openPage()
  const dashboard = startDashboard(page.document, { autoStart: false })
  const doc = page.document
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Connecting…")
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "—")
  assert.equal(doc.querySelector("#stats-grid")?.getAttribute("aria-busy"), "true")
  assert.match(doc.querySelector("#stat-saved-foot")?.textContent ?? "", /Loading/)
  assert.match(doc.querySelector("#stat-sessions-foot")?.textContent ?? "", /Loading/)
  assert.match(doc.querySelector("#stat-requests-foot")?.textContent ?? "", /Loading/)
  assert.doesNotMatch(doc.querySelector("#stats-grid")?.textContent ?? "", /No data/)
  assert.match(doc.querySelector("#traffic-chart")?.textContent ?? "", /Loading local traffic/)
  assert.equal(doc.querySelector("#traffic-chart")?.getAttribute("aria-busy"), "true")
  assert.match(doc.querySelector("#state-lanes")?.textContent ?? "", /Waiting for supervisor history/)
  assert.match(doc.querySelector("#state-ring")?.textContent ?? "", /Waiting/)
  assert.equal(doc.querySelector("#session-rows"), null)
  assert.equal(doc.querySelector("#system-cards"), null)
  dashboard.destroy()
  await page.close()
})

test("system states follow the selected range and render lanes and composition", async () => {
  const page = openPage()
  const doc = page.document
  page.setFetch((url) => {
    const parsed = new URL(url, "http://127.0.0.1:8790")
    if (parsed.pathname === "/api/dashboard") return json(makeSnapshot(now))
    if (parsed.pathname === "/api/system/history") {
      const start = Number(parsed.searchParams.get("start"))
      const end = Number(parsed.searchParams.get("end"))
      const bucket = Number(parsed.searchParams.get("bucket"))
      return json(makeSystemHistory(start, end, bucket))
    }
    return json({ error: "unexpected" }, 404)
  })
  const dashboard = startDashboard(doc, { autoStart: false })
  try {
    await dashboard.refresh()
    await waitForText(doc.querySelector("#state-lanes"), /Connected/, "system state history did not load")
    assert.equal(doc.querySelector("#state-lanes-range")?.textContent, "Last 30 days")
    assert.equal(doc.querySelector("#state-ring-range")?.textContent, "Last 30 days")
    assert.ok(doc.querySelectorAll("#state-lanes .state-lane-segment").length > 0)
    assert.ok(doc.querySelector("#state-lanes .state-lane-label.state-connected .state-dot"))
    assert.ok(doc.querySelector("#state-ring svg"))
    assert.match(doc.querySelector("#state-legend")?.textContent ?? "", /Connected/)
    assert.match(doc.querySelector("#state-legend")?.textContent ?? "", /100%/)
    assert.notEqual(doc.querySelector("#state-ring-total")?.textContent, "—")
    const histories = () => page.fetchCalls.filter((call) => call.url.startsWith("/api/system/history"))
    assert.equal(histories().length, 1)
    const select = doc.getElementById("chart-range") as HTMLSelectElement
    select.value = "24h"
    page.fire(select, "change")
    for (let attempt = 0; attempt < 200 && histories().length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(histories().length, 2)
    assert.notEqual(histories()[0]!.url, histories()[1]!.url)
    await waitForText(doc.querySelector("#state-lanes-range"), /Last 24 hours/, "state lanes range did not follow the period")
    assert.equal(doc.querySelector("#state-ring-range")?.textContent, "Last 24 hours")
  } finally {
    dashboard.destroy()
    await page.close()
  }
})

test("system states show an unavailable notice instead of pretending a stale value is live", async () => {
  const page = openPage()
  const doc = page.document
  page.setFetch((url) => {
    if (url.startsWith("/api/dashboard?")) return json(makeSnapshot(now))
    if (url.startsWith("/api/system/history?")) return json({ error: "supervisor_unavailable" }, 503)
    return json({ error: "unexpected" }, 404)
  })
  const dashboard = startDashboard(doc, { autoStart: false })
  try {
    await dashboard.refresh()
    await waitForText(doc.querySelector("#state-notice"), /local supervisor is unavailable/, "unavailable history notice")
    assert.match(doc.querySelector("#state-lanes")?.textContent ?? "", /local supervisor is unavailable/)
    assert.match(doc.querySelector("#state-ring")?.textContent ?? "", /Unavailable/)
    assert.equal(doc.querySelector("#state-legend")?.textContent, "")
  } finally {
    dashboard.destroy()
    await page.close()
  }
})

test("initial system health shows loading states instead of empty data", async () => {
  const page = openPage("system")
  const dashboard = startDashboard(page.document, { autoStart: false })
  const doc = page.document
  const cards = doc.querySelector("#system-cards")!
  assert.match(doc.querySelector("#system-summary")?.textContent ?? "", /Loading diagnostics/)
  assert.equal(cards.getAttribute("aria-busy"), "true")
  assert.match(cards.textContent ?? "", /Loading gateway diagnostics/)
  assert.match(cards.textContent ?? "", /Loading storage and mailbox usage/)
  assert.match(cards.textContent ?? "", /Loading provider observations/)
  assert.ok(cards.querySelector('.system-card:nth-child(4) > .provider-panels > .provider-panel > #provider-auth'), "provider auth stays inside the provider panel grid")
  assert.doesNotMatch(cards.textContent ?? "", /No data|No observations|Not checked|Not connected|Unobserved/)
  assert.doesNotMatch(cards.textContent ?? "", /Go usage is unavailable for this OpenCode profile/)
  dashboard.destroy()
  await page.close()
})

test("initial sessions page shows a loading state instead of an empty result", async () => {
  const page = openPage("sessions")
  const dashboard = startDashboard(page.document, { autoStart: false })
  const doc = page.document
  const empty = doc.querySelector<HTMLElement>("#sessions-empty")!
  assert.equal(empty.hidden, false)
  assert.match(empty.textContent ?? "", /Loading sessions/)
  assert.equal(doc.querySelector<HTMLElement>("#session-table-scroll")?.hidden, true)
  assert.match(doc.querySelector("#table-summary")?.textContent ?? "", /Loading sessions/)
  assert.equal(doc.querySelector("#sessions")?.getAttribute("aria-busy"), "true")
  dashboard.destroy()
  await page.close()
})

test("initial measurement page distinguishes loading from a missing gateway", async () => {
  const page = openPage("measurement")
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  const doc = page.document
  assert.match(doc.querySelector("#measurement-session-trigger-title")?.textContent ?? "", /Loading retained sessions/)
  assert.match(doc.querySelector("#measurement-trace")?.textContent ?? "", /Loading retained sessions/)
  assert.doesNotMatch(doc.querySelector("#measurement-trace")?.textContent ?? "", /Start the local gateway/)
  assert.match(doc.querySelector("#request-inspector")?.textContent ?? "", /Loading request evidence/)
  assert.doesNotMatch(doc.querySelector("#request-inspector")?.textContent ?? "", /Payload capture is off/)
  measurement.destroy()
  await page.close()
})

test("initial controls page waits for the supervisor without reporting stale", async () => {
  const page = openPage("controls")
  const app = startSystemStatus(page.document, { autoStart: false })
  const doc = page.document
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Connecting…")
  assert.match(doc.querySelector("#updated-at")?.textContent ?? "", /Loading local supervisor/)
  assert.equal(doc.querySelector<HTMLElement>("#notice")?.hidden, true)
  assert.equal(doc.querySelector<HTMLElement>("#control-notice")?.hidden, true)
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Checking…")
  app.destroy()
  await page.close()
})

test("failed first dashboard load reports unavailable instead of no data", async () => {
  const overview = openPage()
  overview.setFetch(() => { throw new Error("offline") })
  const overviewApp = startDashboard(overview.document, { autoStart: false })
  await overviewApp.refresh()
  assert.match(overview.document.querySelector("#notice")?.textContent ?? "", /offline/)
  assert.match(overview.document.querySelector("#stat-saved-foot")?.textContent ?? "", /Unavailable/)
  assert.match(overview.document.querySelector("#traffic-chart")?.textContent ?? "", /unavailable/)
  assert.doesNotMatch(overview.document.querySelector("#stats-grid")?.textContent ?? "", /No data/)
  assert.equal(overview.document.querySelector("#stats-grid")?.getAttribute("aria-busy"), "false")
  overviewApp.destroy()
  await overview.close()

  const systemPage = openPage("system")
  systemPage.setFetch(() => { throw new Error("offline") })
  const systemApp = startDashboard(systemPage.document, { autoStart: false })
  await systemApp.refresh()
  assert.match(systemPage.document.querySelector("#system-summary")?.textContent ?? "", /Diagnostics unavailable/)
  assert.match(systemPage.document.querySelector("#system-cards")?.textContent ?? "", /Unavailable/)
  assert.ok(systemPage.document.querySelector('#system-cards .system-card:nth-child(4) > .provider-panels > .provider-panel > #provider-auth'))
  assert.doesNotMatch(systemPage.document.querySelector("#system-cards")?.textContent ?? "", /No data|No observations/)
  systemApp.destroy()
  await systemPage.close()

  const sessionsPage = openPage("sessions")
  sessionsPage.setFetch(() => { throw new Error("offline") })
  const sessionsApp = startDashboard(sessionsPage.document, { autoStart: false })
  await sessionsApp.refresh()
  assert.match(sessionsPage.document.querySelector("#sessions-empty")?.textContent ?? "", /Sessions unavailable/)
  assert.doesNotMatch(sessionsPage.document.querySelector("#sessions-empty")?.textContent ?? "", /No sessions recorded/)
  sessionsApp.destroy()
  await sessionsPage.close()
})

test("provider details wait for supervisor data before declaring Go usage unavailable", async () => {
  const page = openPage("system")
  page.setFetch((url) => {
    if (url.startsWith("/api/dashboard?")) return json(makeSnapshot(now))
    throw new Error(`Unexpected URL ${url}`)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const text = page.document.querySelector("#system-cards")?.textContent ?? ""
  assert.match(text, /Reading local OpenCode Go usage/)
  assert.doesNotMatch(text, /Go usage is unavailable for this OpenCode profile/)
  dashboard.destroy()
  await page.close()
})

test("controls keep primary actions separate and architecture details always expanded", async () => {
  const page = openPage("controls")
  const doc = page.document
  const toolbar = doc.querySelector(".system-overview-actions")!
  assert.equal(toolbar.classList.contains("heading-actions"), false, "system summary does not inherit full-width header toolbar rules")
  assert.equal(doc.querySelector(".system-overview")?.classList.contains("system-toolbar"), false)
  assert.deepEqual([...toolbar.querySelectorAll("button")].map((button) => button.id), ["start-system", "stop-system"])
  assert.match(doc.querySelector("#start-system")?.textContent ?? "", /Start \/ recover system/)
  const diagnostics = doc.querySelector("#system-architecture-view .architecture-details")!
  assert.ok(diagnostics)
  assert.equal(diagnostics.querySelector("details, summary"), null)
  for (const id of ["network-detail", "recovery-detail", "shutdown-detail"]) {
    assert.ok(diagnostics.querySelector(`#${id}`))
    assert.equal(doc.querySelector(`#system-controls-view #${id}`), null)
  }
  assert.ok(doc.querySelector("#system-architecture-view .map-boundary-key"))
  assert.equal(doc.querySelectorAll("#map-help li").length, 4)
  assert.equal(doc.querySelector(".topology-viewport")?.getAttribute("tabindex"), "0")
  const status = startSystemStatus(doc, { autoStart: false })
  page.setFetch(() => json(systemStatus()))
  await status.refresh()
  assert.equal(doc.querySelector("#network-changes")?.textContent, systemStatus().topology!.network.generation.toLocaleString())
  assert.equal(doc.querySelector("#recovery-attempts")?.textContent, systemStatus().recovery.attempts.toLocaleString())
  assert.equal(doc.querySelector("#recovery-mode")?.textContent, "Enabled")
  assert.equal(doc.querySelector("#architecture-data-state")?.textContent, "Live supervisor data")
  assert.equal(diagnostics.querySelector("details"), null, "polling keeps architecture details expanded")
  assert.equal(diagnostics.querySelectorAll("dl").length, 3)
  assert.equal(diagnostics.querySelectorAll("time").length, 3)
  status.destroy()
  await page.close()
})

test("polling updates component details without opening the architecture or moving its camera", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const status = startSystemStatus(page.document, { autoStart: false })
  const inspector = page.document.querySelector<HTMLDialogElement>("#node-inspector")!
  const canvas = page.document.querySelector<HTMLElement>(".topology-canvas")!
  await status.refresh()
  assert.equal(inspector.open, false)
  page.document.querySelector<HTMLButtonElement>('[data-component-detail="relay"]')!.click()
  assert.equal(inspector.open, true)
  assert.match(inspector.querySelector("#node-inspector-title")!.textContent ?? "", /relay/i)
  const camera = canvas.style.transform
  await status.refresh()
  assert.equal(canvas.style.transform, camera)
  assert.equal(inspector.open, true)
  page.document.querySelector<HTMLButtonElement>("#node-inspector-close")!.click()
  await status.refresh()
  assert.equal(inspector.open, false)
  assert.equal(page.document.querySelector<HTMLElement>("#system-architecture-view")!.hidden, true)
  status.destroy()
  await page.close()
})

test("all operational components use single table rows with descriptions and inline actions", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  const rows = [...doc.querySelectorAll<HTMLElement>("[data-component-id]")]
  assert.equal(rows.length, 12)
  assert.equal(doc.querySelector(".resource-grid, .resource-card, .component-columns, [data-component-group], [data-component-more], .component-action-menu"), null)
  assert.deepEqual([...doc.querySelectorAll("#component-table-scroll th")].map((th) => th.textContent?.trim()), ["Component", "Type", "Description", "Status", "Lifecycle", "Location", "Actions"])
  for (const row of rows) {
    assert.equal(row.tagName, "TR")
    assert.equal(row.parentElement?.id, "component-rows")
    assert.equal(row.children.length, 7)
    assert.equal(row.hidden, false)
    const description = row.querySelector<HTMLElement>("[data-component-description]")!
    assert.ok(description.textContent)
    assert.equal(description.title, description.textContent)
    assert.equal(row.querySelector<HTMLButtonElement>("[data-component-detail]")?.tagName, "BUTTON", "the component name opens details")
  }
  const filter = doc.querySelector<HTMLInputElement>("#component-filter")!
  filter.value = "background"
  page.fire(filter, "input")
  assert.equal(rows.filter((row) => !row.hidden).length, 3)
  await app.refresh()
  assert.equal(rows.filter((row) => !row.hidden).length, 3, "polling preserves the filter")
  filter.value = "no such component"
  page.fire(filter, "input")
  assert.equal(doc.querySelector<HTMLElement>("#component-empty")!.hidden, false)
  assert.equal(doc.querySelector<HTMLElement>("#component-table-scroll")!.hidden, false, "column filters remain reachable with no matches")
  filter.value = ""
  page.fire(filter, "input")
  const gatewayActions = doc.querySelector<HTMLElement>('[data-component-id="gateway"] [data-component-actions]')!
  assert.deepEqual([...gatewayActions.querySelectorAll<HTMLButtonElement>("[data-component-action]")].map((button) => button.dataset.componentAction), ["recover", "start", "restart"])
  assert.equal(gatewayActions.querySelector('[data-component-action="restart"]')!.closest("[data-component-id]")?.getAttribute("data-component-id"), "gateway")
  const action = gatewayActions.querySelector<HTMLButtonElement>('[data-component-action="restart"]')!
  action.focus()
  await app.refresh()
  assert.equal(gatewayActions.querySelector('[data-component-action="restart"]'), action, "polling does not replace unchanged actions")
  assert.equal(doc.activeElement, action)
  assert.equal(doc.querySelector('[data-component-id="supervisor"] [data-component-actions]')?.textContent, "")
  assert.equal(doc.querySelector('[data-component-id="vscode"] [data-component-actions]')?.textContent, "Open not configured")
  assert.doesNotMatch(doc.body.textContent ?? "", /Managed by startup\.sh|Host actions in More actions/)
  doc.querySelector<HTMLButtonElement>('[data-component-detail="gateway"]')!.click()
  assert.equal(doc.querySelector<HTMLDialogElement>("#node-inspector")!.open, true)
  assert.match(doc.querySelector("#node-inspector-title")?.textContent ?? "", /gateway/i)
  assert.equal(doc.querySelector("#node-inspector [data-component-action]"), null, "diagnostic dialog is read-only")
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  assert.equal(doc.querySelector("body > #component-filter-popover"), null, "destroy removes portaled UI and listeners")
  await page.close()
})

test("component column filters combine with search and sort the entire table", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  const rows = [...doc.querySelectorAll<HTMLElement>("[data-component-id]")]
  const filter = doc.querySelector<HTMLInputElement>("#component-filter")!
  const sortSelect = doc.querySelector<HTMLSelectElement>("#component-sort")!
  const total = doc.querySelector("#component-count")!
  const summary = doc.querySelector("#component-summary")!
  const labels = () => [...doc.querySelectorAll("#component-rows [data-component-label]")].map((element) => element.textContent ?? "")
  const defaultLabels = labels()
  const popover = openComponentFilter(doc, "type")
  assert.deepEqual([...popover.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value), ["", "Applications", "Connections", "Background services"])
  const applications = popover.querySelector<HTMLInputElement>('input[value="Applications"]')!
  applications.checked = true
  page.fire(applications, "change")
  assert.equal(rows.filter((row) => !row.hidden).length, 4)
  assert.equal(doc.querySelector('button[data-filter-key="type"]')?.getAttribute("data-active"), "true")
  assert.equal(total.textContent, "4")
  assert.match(summary.textContent ?? "", /4 of 12 components · 1 filter active · default order/)
  assert.equal(new URL(page.window.location.href).searchParams.get("type"), "Applications")

  filter.value = "OpenCode"
  page.fire(filter, "input")
  assert.equal(rows.filter((row) => !row.hidden).length, 4, "type and search filters combine across names and descriptions")
  filter.value = "remote-host"
  page.fire(filter, "input")
  assert.equal(rows.filter((row) => !row.hidden).length, 0)
  assert.equal(doc.querySelector<HTMLElement>("#component-empty")!.hidden, false)
  doc.querySelector<HTMLButtonElement>("#clear-component-filters-empty")!.click()
  assert.equal(rows.filter((row) => !row.hidden).length, 12)
  assert.equal(filter.value, "")
  assert.equal(new URL(page.window.location.href).searchParams.has("type"), false)

  const componentHeader = doc.querySelector<HTMLElement>('th[data-sort-key="component"]')!
  const componentButton = componentHeader.querySelector<HTMLButtonElement>("button")!
  componentButton.click()
  assert.equal(componentHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(sortSelect.value, "component")
  assert.deepEqual(labels(), [...defaultLabels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })))

  componentButton.click()
  assert.equal(componentHeader.getAttribute("aria-sort"), "descending")
  assert.deepEqual(labels(), [...defaultLabels].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" })))

  const lifecycleHeader = doc.querySelector<HTMLElement>('th[data-sort-key="lifecycle"]')!
  lifecycleHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(lifecycleHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(componentHeader.getAttribute("aria-sort"), "none")
  assert.equal(sortSelect.value, "lifecycle")
  const values = [...doc.querySelectorAll("#component-rows [data-component-lifecycle]")].map((cell) => cell.textContent ?? "")
  assert.ok(values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) <= 0), "lifecycle sorting spans the whole table")
  sortSelect.value = "default"
  page.fire(sortSelect, "change")
  assert.deepEqual(labels(), defaultLabels)
  assert.equal(doc.querySelector<HTMLButtonElement>("#component-sort-direction")!.disabled, true)
  app.destroy()
  await page.close()
})

test("component filters restore from URLs, expose description text, and close with keyboard and scroll", async () => {
  const page = openPage("controls")
  page.window.history.replaceState(null, "", "/controls?type=Connections&location=Remote+host&sort=component&dir=desc")
  page.setFetch(() => json(systemStatus()))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  const visible = () => [...doc.querySelectorAll<HTMLElement>("#component-rows tr")].filter((row) => !row.hidden)
  assert.equal(visible().length, 2)
  assert.equal(doc.querySelector('th[data-sort-key="component"]')?.getAttribute("aria-sort"), "descending")
  const popover = openComponentFilter(doc, "description")
  const description = popover.querySelector<HTMLInputElement>("input")!
  description.value = "persistent cache"
  page.fire(description, "input")
  assert.equal(visible().length, 1)
  assert.equal(visible()[0]!.dataset.componentId, "relay")
  await app.refresh()
  assert.equal(doc.activeElement, description, "polling preserves text-filter focus")
  assert.equal(description.value, "persistent cache")
  description.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event)
  assert.equal(popover.hidden, true)
  assert.equal(doc.activeElement, doc.querySelector('button[data-filter-key="description"]'))
  openComponentFilter(doc, "description")
  page.fire(doc.querySelector("#component-table-scroll")!, "scroll")
  assert.equal(popover.hidden, true)
  doc.querySelector<HTMLButtonElement>("#clear-component-filters")!.click()
  assert.equal(visible().length, 12)
  openComponentFilter(doc, "lifecycle").querySelector<HTMLInputElement>('input[value="Running"]')!.click()
  assert.ok(visible().every((row) => row.querySelector("[data-component-lifecycle]")?.textContent === "Running"))
  doc.querySelector<HTMLButtonElement>("#clear-component-filter")!.click()
  assert.equal(visible().length, 12)
  openComponentFilter(doc, "status").querySelector<HTMLInputElement>('input[value="Ready"]')!.click()
  assert.ok(visible().every((row) => row.querySelector("[data-component-status]")?.textContent === "Ready"))
  doc.querySelector<HTMLButtonElement>("#clear-component-filters")!.click()
  const row = doc.querySelector('[data-component-id="vscode"]')!
  row.querySelector<HTMLButtonElement>("[data-component-detail]")!.click()
  assert.equal(doc.querySelector("#node-inspector-description")?.textContent, row.querySelector("[data-component-description]")?.textContent)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  await page.close()
})

test("architecture retains its complete legend and highlights management arrows without operational actions", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  page.setFetch(() => json(status))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  const tab = doc.querySelector<HTMLButtonElement>("#system-architecture-tab")!
  const view = doc.querySelector<HTMLElement>("#system-architecture-view")!
  tab.click()
  assert.equal(view.hidden, false)
  assert.equal(tab.getAttribute("aria-selected"), "true")
  const legend = view.querySelector(".topology-legend")!.textContent ?? ""
  for (const text of ["Model request flow", "Checks / recovery / management"]) assert.ok(legend.includes(text), text)
  for (const text of ["Frontend process", "Backend process", "Host / location / resource"]) assert.ok(view.querySelector(".map-boundary-key")!.textContent!.includes(text), text)
  assert.doesNotMatch(legend, /Verified|Working|Not ready|Unknown \/ stopped/)
  assert.equal(view.querySelector("#map-management"), null)
  assert.equal(view.querySelectorAll('.legend-toggle[aria-pressed="true"]').length, 3)
  assert.equal(view.querySelectorAll(".map-edge:not(.response)").length, status.topology!.edges.length, "all connections start visible")
  assert.equal(view.querySelectorAll(".map-edge.response").length, 9)
  assert.equal(view.querySelectorAll(".map-layer-separation line").length, mapLayerSegments.length)
  assert.equal(view.querySelector('[data-edge-id="relay_storage_response"]'), null, "storage is not a return hop")
  for (const edge of status.topology!.edges.filter((edge) => edgeChannel(edge) === "request")) {
    const response = view.querySelector(`[data-edge-id="${edge.id}_response"]`)!
    assert.equal(response.getAttribute("d"), responsePath(edge.source, edge.target), `${edge.id}: render the return route`)
    assert.equal(response.getAttribute("marker-end"), "url(#map-arrow)", `${edge.id}: arrowhead is at the return endpoint`)
    assert.ok(response.querySelector("title")!.textContent!.includes(`${edge.target} → ${edge.source}`))
  }
  assert.equal(view.querySelector("[data-node-status], [data-tone], .map-node-spinner"), null, "architecture is structural, not a second operational status view")
  const node = doc.querySelector<HTMLButtonElement>('[data-node-id="supervisor"]')!
  const camera = view.querySelector<HTMLElement>(".topology-canvas")!
  const before = camera.style.transform
  node.click()
  const related = status.topology!.edges.filter((edge) => edge.source === "supervisor" || edge.target === "supervisor")
  assert.equal(view.querySelectorAll(".map-edge.selected").length, related.length)
  assert.ok(view.querySelectorAll(".map-edge.manages.selected").length > 0)
  assert.equal(doc.querySelector<HTMLDialogElement>("#node-inspector")!.open, false)
  assert.equal(view.querySelector("[data-component-action]"), null)
  await app.refresh()
  assert.equal(node.getAttribute("aria-pressed"), "true")
  assert.equal(camera.style.transform, before, "selection and polling do not move the camera")
  node.click()
  assert.equal(view.querySelectorAll(".map-edge.selected").length, 0)
  node.click()
  view.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event)
  assert.equal(node.getAttribute("aria-pressed"), "false")
  tab.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event)
  assert.equal(view.hidden, true)
  assert.equal(doc.activeElement, doc.querySelector("#system-controls-tab"))
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  await page.close()
})

test("map background clicks clear selection without fading other components", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const doc = page.document
  const app = startSystemStatus(doc, { autoStart: false })
  await app.refresh()
  doc.querySelector<HTMLButtonElement>("#system-architecture-tab")!.click()
  const selected = doc.querySelector<HTMLButtonElement>('[data-node-id="gateway"]')!
  selected.querySelector("strong")!.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }) as unknown as Event)
  assert.equal(selected.getAttribute("aria-pressed"), "true", "clicks within a component keep it selected")
  assert.equal(doc.querySelector(".map-unrelated, .has-selection"), null)
  assert.ok(doc.querySelectorAll(".map-edge.selected").length > 0)
  for (const target of [".map-region", ".map-boundary-outline", ".topology-viewport"]) {
    if (selected.getAttribute("aria-pressed") !== "true") selected.click()
    doc.querySelector(target)!.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }) as unknown as Event)
    assert.equal(selected.getAttribute("aria-pressed"), "false", `${target} clears selection`)
    assert.equal(doc.querySelectorAll(".map-edge.selected").length, 0)
    assert.equal(doc.querySelector("#map-selection")?.textContent, "No component selected")
  }
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  await page.close()
})

test("legend arrow buttons independently hide connection groups and retain filters during polling and selection", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const doc = page.document
  const app = startSystemStatus(doc, { autoStart: false })
  await app.refresh()
  const request = doc.querySelector<HTMLButtonElement>('[data-map-channel="request"]')!
  const response = doc.querySelector<HTMLButtonElement>('[data-map-channel="response"]')!
  const control = doc.querySelector<HTMLButtonElement>('[data-map-channel="control"]')!
  const camera = doc.querySelector<HTMLElement>(".topology-canvas")!
  const before = camera.style.transform
  const all = doc.querySelectorAll(".map-edge").length
  control.click()
  assert.equal(control.getAttribute("aria-pressed"), "false")
  assert.equal(control.querySelector(".legend-toggle-state")?.textContent, "Hidden")
  assert.equal(doc.querySelectorAll(".map-edge.control").length, 0)
  assert.ok(doc.querySelectorAll(".map-edge.request").length > 0)
  doc.querySelector<HTMLButtonElement>('[data-node-id="supervisor"]')!.click()
  await app.refresh()
  assert.equal(doc.querySelectorAll(".map-edge.control").length, 0, "selection and polling never override hidden channels")
  assert.match(doc.querySelector("#map-selection")?.textContent ?? "", /0 visible arrows/)
  request.click()
  assert.ok(doc.querySelectorAll(".map-edge.response").length > 0, "request and response filters are independent")
  response.click()
  assert.equal(doc.querySelectorAll(".map-edge").length, 0)
  control.click()
  assert.ok(doc.querySelectorAll(".map-edge.manages").length > 0)
  assert.equal(doc.querySelectorAll(".map-edge.request").length, 0)
  request.click()
  response.click()
  assert.equal(doc.querySelectorAll(".map-edge").length, all)
  assert.equal(request.getAttribute("aria-pressed"), "true")
  assert.equal(camera.style.transform, before)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  await page.close()
})

test("three system tabs support keyboard navigation and preserve selection during refresh", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  const tabs = [...doc.querySelectorAll<HTMLButtonElement>('.system-tabs [role="tab"]')]
  assert.deepEqual(tabs.map((tab) => tab.id), ["system-controls-tab", "system-architecture-tab", "system-settings-tab"])
  function key(index: number, key: string, expected: number) {
    tabs[index]!.dispatchEvent(new page.window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event)
    assert.equal(doc.activeElement, tabs[expected])
    tabs.forEach((tab, position) => {
      assert.equal(tab.getAttribute("aria-selected"), String(position === expected))
      assert.equal(tab.tabIndex, position === expected ? 0 : -1)
      assert.equal(doc.getElementById(tab.getAttribute("aria-controls")!)!.hidden, position !== expected)
    })
  }
  key(0, "ArrowRight", 1)
  key(1, "ArrowRight", 2)
  await app.refresh()
  assert.equal(doc.querySelector<HTMLElement>("#system-settings-view")!.hidden, false)
  key(2, "ArrowRight", 0)
  key(0, "ArrowLeft", 2)
  key(2, "Home", 0)
  key(0, "End", 2)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  await page.close()
})

test("settings autosave safely and show errors without leaving the Settings tab", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  let fail = false
  const writes: RequestInit[] = []
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(status)
    if (url === "/api/system/setup") return json(setupStatus())
    assert.equal(url, "/api/system/settings")
    writes.push(init)
    if (fail) throw new Error("Settings write failed")
    status.settings.auto_reconnect = false
    return json({ accepted: true })
  })
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  doc.querySelector<HTMLButtonElement>("#system-settings-tab")!.click()
  const input = doc.querySelector<HTMLInputElement>("#auto-reconnect")!
  input.checked = false
  page.fire(input, "change")
  await waitForText(doc.querySelector("#control-notice"), /settings saved/i, "settings autosave")
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(String(writes[0]!.body)), { auto_reconnect: false, auto_wake: false })
  assert.deepEqual(writes[0]!.headers, { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
  assert.equal(doc.querySelector<HTMLElement>("#system-settings-view")!.hidden, false)
  assert.equal(doc.querySelector("#control-notice")!.closest('[role="tabpanel"]'), null, "save feedback is visible regardless of selected tab")
  await app.refresh()
  fail = true
  input.checked = true
  page.fire(input, "change")
  await waitForText(doc.querySelector("#control-notice"), /Settings write failed/, "settings error")
  assert.equal(doc.querySelector<HTMLElement>("#system-settings-view")!.hidden, false)
  assert.equal(doc.querySelector<HTMLElement>("#control-notice")!.hidden, false)
  assert.equal(input.checked, false, "failed changes return to the observed setting")
  app.destroy()
  await page.close()
})

test("Start / recover system uses the confirmed existing start operation, not a duplicate recovery command", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  const actions: Record<string, unknown>[] = []
  let release: (response: Response) => void = () => undefined
  const held = new Promise<Response>((resolve) => { release = resolve })
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(status)
    if (url === "/api/system/setup") return json(setupStatus())
    assert.equal(url, "/api/system/action")
    actions.push(JSON.parse(String(init.body)))
    return held
  })
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const button = page.document.querySelector<HTMLButtonElement>("#start-system")!
  page.setConfirm(() => false)
  button.click()
  assert.equal(actions.length, 0)
  page.setConfirm((message) => {
    assert.match(message ?? "", /recover the connection and enable automatic recovery/)
    assert.match(message ?? "", /billing/)
    return true
  })
  button.click()
  button.click()
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.component, "all")
  assert.equal(actions[0]?.action, "start")
  assert.equal(actions[0]?.confirmed, true)
  assert.match(String(actions[0]?.request_id), /^[a-f0-9]{32}$/)
  release(json({ accepted: true }, 202))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(page.document.querySelector("#recovery-progress"), null)
  assert.doesNotMatch(page.document.querySelector("#control-notice")?.textContent ?? "", /Recovery history/)
  app.destroy()
  await page.close()
})

test("measurement page renders definitions, browses stored sessions, and traces a selected session", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const catalog = makeOpenCodeSessions(now)
  page.setFetch((url) => {
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
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
  assert.match(trace.textContent ?? "", /Session ID/)
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
  const retention = doc.querySelector("#retention-note")!
  assert.match(retention.textContent ?? "", /Gateway session limit/)
  const retentionValues = [...retention.querySelectorAll(".data-facts dd")].map((item) => item.textContent)
  assert.equal(retentionValues.filter((value) => value === "Unlimited").length, 4)

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
  assert.match(doc.querySelector("#measurement-session-trigger-title")?.textContent ?? "", /Relay dashboard measurement/)

  const second = [...dialog.querySelectorAll<HTMLButtonElement>("[data-session-choice]")].find((choice) => choice.dataset.sessionChoice === snapshot.history.sessions[1]!.id)!
  second.click()
  assert.equal(dialog.open, false)
  assert.match(doc.querySelector("#measurement-session-trigger-title")?.textContent ?? "", /API refactor/)
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

test("measurement browser scopes measured sessions and traces by host", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const catalog = makeOpenCodeSessions(now)
  page.window.history.replaceState(null, "", "/measurement?host=alpha")
  page.setFetch((url) => {
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
    if (url === "/api/opencode/sessions") return json(catalog)
    throw new Error(`Unexpected measurement URL ${url}`)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  const filter = doc.querySelector<HTMLSelectElement>("#measurement-host-filter")!
  assert.equal(filter.value, "alpha")
  await waitForText(doc.querySelector("#measurement-session-trigger-title"), /Relay dashboard measurement/, "host-scoped catalog did not load")
  doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!.click()
  const dialog = doc.querySelector<HTMLDialogElement>("#measurement-session-dialog")!
  assert.equal(dialog.querySelectorAll("[data-session-choice]").length, 3)
  assert.match(dialog.textContent ?? "", /Host: alpha/)
  dialog.querySelector<HTMLButtonElement>("#close-measurement-session")!.click()

  filter.value = "beta"
  page.fire(filter, "change")
  assert.equal(new URL(page.window.location.href).searchParams.get("host"), "beta")
  assert.match(doc.querySelector("#measurement-session-trigger-title")?.textContent ?? "", /Cache worker|Release check|Docs update/)
  doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!.click()
  assert.equal(dialog.querySelectorAll("[data-session-choice]").length, 3)
  assert.match(dialog.textContent ?? "", /Host: beta/)
  measurement.destroy()
  await page.close()
})

test("measurement session browser sorts by columns, resets pages, and restores sort from the URL", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  const catalog = makeOpenCodeSessions(now)
  page.window.history.replaceState(null, "", "/measurement?sort=requests&dir=desc")
  page.setFetch((url) => {
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
    if (url === "/api/opencode/sessions") return json(catalog)
    throw new Error(`Unexpected measurement URL ${url}`)
  })
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  await waitForText(doc.querySelector("#measurement-session-trigger-title"), /Choose a session|Relay dashboard measurement/, "catalog did not load before sorting")
  doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")!.click()
  const dialog = doc.querySelector<HTMLDialogElement>("#measurement-session-dialog")!
  const rows = () => [...dialog.querySelectorAll<HTMLElement>("#measurement-session-rows tr")]
  const requestNumbers = () => rows().map((row) => row.children[3]?.textContent?.trim() ?? "")
  const numericRequests = () => requestNumbers().filter((value) => value !== "—").map(Number)
  const requestsHeader = dialog.querySelector<HTMLElement>('th[data-sort-key="requests"]')!
  const startedHeader = dialog.querySelector<HTMLElement>('th[data-sort-key="started"]')!
  const sessionHeader = dialog.querySelector<HTMLElement>('th[data-sort-key="session"]')!
  const reductionHeader = dialog.querySelector<HTMLElement>('th[data-sort-key="reduction"]')!
  const sortSelect = dialog.querySelector<HTMLSelectElement>("#measurement-session-sort")!

  assert.equal(requestsHeader.getAttribute("aria-sort"), "descending")
  assert.equal(sortSelect.value, "requests")
  assert.ok(descending(numericRequests()), "measured request counts sort numerically descending")
  assert.equal(requestNumbers().at(-1), "—", "unmeasured rows stay last")

  dialog.querySelector<HTMLButtonElement>("#measurement-session-next")!.click()
  assert.equal(dialog.querySelector("#measurement-session-page")?.textContent, "Page 2 of 2")
  requestsHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(dialog.querySelector("#measurement-session-page")?.textContent, "Page 1 of 2", "sorting resets pagination")
  assert.equal(requestsHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "requests")
  assert.equal(new URL(page.window.location.href).searchParams.get("dir"), "asc")
  assert.ok(ascending(numericRequests()), "measured request counts sort numerically ascending")
  assert.equal(requestNumbers().at(-1), "—", "unmeasured rows stay last when ascending")

  reductionHeader.querySelector<HTMLButtonElement>("button")!.click()
  const reductions = rows().map((row) => row.children[4]?.textContent?.trim() ?? "").filter((value) => value !== "—").map((value) => parsePercentLabel(value))
  assert.equal(reductionHeader.getAttribute("aria-sort"), "ascending")
  assert.ok(ascending(reductions), "reduction sorts numerically")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "reduction")

  startedHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(startedHeader.getAttribute("aria-sort"), "descending")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "started")
  assert.equal(new URL(page.window.location.href).searchParams.get("dir"), "desc")

  sessionHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(sessionHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "session")
  assert.equal(new URL(page.window.location.href).searchParams.get("dir"), "asc")

  sortSelect.value = "updated"
  page.fire(sortSelect, "change")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), null, "default recent order stays implicit")
  assert.equal(doc.querySelector('[data-sort-key="session"]')?.getAttribute("aria-sort"), "none")
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
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
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
  assert.equal(inspector.querySelector('[data-inspect-mode="json"]')?.getAttribute("aria-pressed"), "true")
  assert.ok(inspector.querySelector(".cm-gutters"))
  assert.equal(inspector.querySelector(".cm-content")?.getAttribute("contenteditable"), "false")
  assert.match(inspector.querySelector(".cm-content")?.textContent ?? "", /9007199254740993/)
  const fold = [...inspector.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Fold all")!
  fold.click()
  assert.ok(inspector.querySelector(".cm-foldPlaceholder"))
  ;[...inspector.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Unfold all")!.click()
  assert.equal(inspector.querySelector(".cm-foldPlaceholder"), null)
  ;[...inspector.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Find")!.click()
  assert.ok(inspector.querySelector(".cm-search"))
  assert.match(inspector.textContent ?? "", new RegExp(`${body.length.toLocaleString()}\\u00A0B`))
  doc.querySelector<HTMLButtonElement>('[data-inspect-mode="json"]')!.click()
  assert.equal(readPreferences(doc, "inspection").body, "json")
  await waitForText(inspector, /9007199254740993/, "lossless JSON presentation did not load")
  assert.match(inspector.textContent ?? "", /"z": 1,\s*"z": 2/)
  assert.match(inspector.textContent ?? "", /Formatting is not the captured byte layout/)
  assert.ok(inspector.querySelector(".cm-content span"), "CodeMirror applies parser-based syntax highlighting")

  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="inventory"]')!.click()
  await waitForText(inspector, /This page: chunks 0–0/, "inventory did not load")
  assert.equal(inspector.querySelectorAll(".inspect-chunk.missing").length, 1)
  inspector.querySelector<HTMLButtonElement>(".inspect-chunk.missing")!.click()
  await waitForText(inspector, /Selected chunk #0/, "chunk selection did not render")
  await waitForText(inspector, /c3 a9/, "chunk bytes did not load")
  assert.match(inspector.textContent ?? "", /00000030/)
  assert.match(inspector.textContent ?? "", /Addresses are absolute byte offsets/)

  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="upload"]')!.click()
  await waitForText(inspector, /Prepared frame layout/, "upload attempt did not load")
  assert.match(inspector.textContent ?? "", /DRLY0001/)
  assert.match(inspector.textContent ?? "", /validated chunk ACK|Not validated/)

  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="savings"]')!.click()
  await waitForText(inspector, /Retained attempts reconcile to transfer counter/, "attempt accounting did not reconcile")
  assert.match(inspector.textContent ?? "", /Body SHA-256 vs transfer hashMatch/)
  assert.match(inspector.textContent ?? "", new RegExp(`${body.length.toLocaleString()} − ${encoded.toLocaleString()}`))
  assert.match(inspector.textContent ?? "", /Extra upload/)
  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="body"]')!.click()
  await waitForText(inspector, /9007199254740993/, "body did not restore")
  doc.querySelector<HTMLButtonElement>('[data-inspect-mode="text"]')!.click()
  await waitForText(inspector, /UTF-8 byte window/, "text mode did not load")
  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="savings"]')!.click()
  doc.querySelector<HTMLButtonElement>('[data-inspect-stage="body"]')!.click()
  await waitForText(inspector, /UTF-8 byte window/, "saved text presentation was not restored")
  assert.equal(inspector.querySelector('[data-inspect-mode="text"]')!.getAttribute("aria-pressed"), "true")
  assert.equal(readPreferences(doc, "inspection").body, "text")
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
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
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
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(emptyCatalog))
  const measurement = startMeasurementPage(page.document, { autoStart: false })
  await measurement.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#measurement-session-trigger")?.disabled, true)
  assert.match(doc.querySelector("#measurement-trace")?.textContent ?? "", /No retained sessions/)
  assert.match(doc.querySelector("#retention-note")?.textContent ?? "", /retained indefinitely/)
  measurement.destroy()
  await page.close()
})

test("measurement browser lists OpenCode sessions without gateway measurements", async () => {
  const page = openPage("measurement")
  const snapshot = makeSnapshot(now)
  snapshot.history.sessions = []
  snapshot.history.recent_requests = []
  const catalog = makeOpenCodeSessions(now)
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(catalog))
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
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
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
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
    if (url.startsWith("/api/system/history?")) {
      const parsed = new URL(url, "http://127.0.0.1:8790")
      return json(makeSystemHistory(Number(parsed.searchParams.get("start")), Number(parsed.searchParams.get("end")), Number(parsed.searchParams.get("bucket"))))
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#connection-label")?.textContent, "Live")
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "6")
  assert.equal(doc.querySelector("#nav-session-count")?.textContent, "6")
  assert.match(doc.querySelector("#stat-requests-foot")?.textContent ?? "", /2 failed · 1 cancelled/)
  assert.match(doc.querySelector("#traffic-chart")?.innerHTML ?? "", /<svg/)
  assert.equal(doc.querySelector("#traffic-chart svg")?.getAttribute("preserveAspectRatio"), "xMidYMid meet")
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 30 days.*101 requests/)
  assert.match(doc.querySelector("#chart-saved")?.textContent ?? "", /GiB|MiB|KiB|B/)
  assert.match(doc.querySelector("#chart-reused")?.textContent ?? "", /GiB|MiB|KiB|B/)
  assert.match(doc.querySelector("#reuse-value")?.textContent ?? "", /%/)
  assert.match(doc.querySelector<HTMLElement>("#reuse-meter-reuse")?.style.width ?? "", /%/)
  assert.match(doc.querySelector("#chart-count")?.textContent ?? "", /101 requests · 2 failed · 1 cancelled/)
  assert.ok(doc.querySelectorAll("#traffic-chart rect.chart-bar-upload").length > 1)
  await waitForText(doc.querySelector("#state-lanes"), /Connected/, "system state history did not load")
  assert.ok(doc.querySelectorAll("#state-lanes .state-lane-segment").length > 0)
  assert.ok(doc.querySelector("#state-ring svg"))
  assert.equal(doc.querySelector("#session-rows"), null)
  assert.equal(doc.querySelector("#system-summary"), null)
  assert.equal(doc.querySelector<HTMLButtonElement>("#refresh-button")?.disabled, false)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url.split("?")[0]))].sort(), ["/api/dashboard", "/api/system/history"])
  dashboard.destroy()
  await page.close()
})

test("overview labels legacy lifetime outcomes separately instead of assigning them to a period", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  const legacySession = snapshot.history.sessions.find((session) => session.failed > 0)!
  const host = legacySession.host ?? "local"
  legacySession.failed = 0
  legacySession.legacy = 1
  const hostTotals = snapshot.history.host_totals![host]!
  hostTotals.failed -= 1
  hostTotals.legacy = 1
  snapshot.history.totals.failed -= 1
  snapshot.history.totals.legacy = 1
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#stat-saved")?.textContent, doc.querySelector("#chart-saved")?.textContent)
  assert.doesNotMatch(doc.querySelector("#stat-requests-foot")?.textContent ?? "", /legacy/)
  const note = doc.querySelector<HTMLElement>("#stats-note")!
  assert.equal(note.hidden, false)
  assert.match(note.textContent ?? "", /1 legacy requests with unknown outcomes/)
  assert.match(note.textContent ?? "", /lifetime counts cannot be assigned to the selected period/)
  dashboard.destroy()
  await page.close()
})

test("overview always shows all hosts and carries no host filter", async () => {
  const page = openPage()
  page.window.history.replaceState(null, "", "/?host=alpha")
  const snapshot = makeSnapshot(now)
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#host-filter"), null)
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "6")
  assert.equal(doc.querySelector("#stat-requests")?.textContent, "102")
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 30 days: 101 requests/)
  assert.equal(new URL(page.window.location.href).searchParams.get("host"), null)
  const sessionsLink = doc.querySelector<HTMLAnchorElement>('.sidebar-nav a[href^="/sessions"]')!
  assert.equal(new URL(sessionsLink.href, page.window.location.href).searchParams.get("host"), null)
  dashboard.destroy()
  await page.close()
})

test("sessions page filters rows by host and keeps the URL deep-linked", async () => {
  const page = openPage("sessions")
  page.window.history.replaceState(null, "", "/sessions?host=alpha")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const filter = doc.querySelector<HTMLSelectElement>("#host-filter")!
  assert.equal(filter.value, "alpha")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 3)
  assert.equal(doc.querySelector("#session-count")?.textContent, "3")
  assert.match(doc.querySelector("#session-rows")?.textContent ?? "", /alpha/)

  filter.value = "beta"
  page.fire(filter, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 3)
  assert.match(doc.querySelector("#session-rows")?.textContent ?? "", /beta/)
  assert.equal(new URL(page.window.location.href).searchParams.get("host"), "beta")
  dashboard.destroy()
  await page.close()
})

test("session column filters open from headers and the host filter stays in sync", async () => {
  const page = openPage("sessions")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const popover = openColumnFilter(doc, "host")
  assert.equal(popover.hidden, false)
  assert.match(popover.querySelector("#session-filter-popover-title")?.textContent ?? "", /remote host/i)

  const beta = popover.querySelector<HTMLInputElement>('input[data-filter-option="host"][value="beta"]')!
  beta.checked = true
  page.fire(beta, "change")
  assert.equal(doc.querySelector<HTMLSelectElement>("#host-filter")?.value, "beta")
  assert.equal(new URL(page.window.location.href).searchParams.get("host"), "beta")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 3)
  assert.equal(doc.querySelector('button[data-filter-key="host"]')?.getAttribute("data-active"), "true")
  assert.match(doc.querySelector("#table-summary")?.textContent ?? "", /3/)

  doc.querySelector<HTMLButtonElement>("#clear-session-filters")!.click()
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(new URL(page.window.location.href).searchParams.get("host"), null)
  assert.equal(doc.querySelector('button[data-filter-key="host"]')?.getAttribute("data-active"), "false")
  dashboard.destroy()
  await page.close()
})

test("state column filter filters rows and resets from its popover", async () => {
  const page = openPage("sessions")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const popover = openColumnFilter(doc, "state")
  assert.equal(popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="all"]')?.checked, true)
  assert.match(popover.textContent ?? "", /Needs attention/)

  const active = popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="active"]')!
  active.checked = true
  page.fire(active, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 1)
  assert.equal(new URL(page.window.location.href).searchParams.get("state"), "active")
  assert.equal(doc.querySelector('button[data-filter-key="state"]')?.getAttribute("data-active"), "true")

  const idle = popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="idle"]')!
  idle.checked = true
  page.fire(idle, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 4)
  assert.equal(new URL(page.window.location.href).searchParams.get("state"), "idle")

  popover.querySelector<HTMLButtonElement>("#clear-session-filter")!.click()
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(new URL(page.window.location.href).searchParams.get("state"), null)
  assert.equal(popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="all"]')?.checked, true)
  assert.equal(doc.querySelector('button[data-filter-key="state"]')?.getAttribute("data-active"), "false")
  dashboard.destroy()
  await page.close()
})

test("range filters apply immediately and explain invalid bounds", async () => {
  const page = openPage("sessions")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const popover = openColumnFilter(doc, "requests")
  const min = popover.querySelector<HTMLInputElement>('[data-filter-field="requestsMin"]')!
  min.value = "13"
  page.fire(min, "input")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 1)
  assert.equal(new URL(page.window.location.href).searchParams.get("req_min"), "13")
  assert.equal(doc.querySelector('button[data-filter-key="requests"]')?.getAttribute("data-active"), "true")

  const max = popover.querySelector<HTMLInputElement>('[data-filter-field="requestsMax"]')!
  max.value = "5"
  page.fire(max, "input")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 0)
  assert.equal(popover.querySelector<HTMLElement>("#session-filter-hint")?.hidden, false)
  assert.match(popover.querySelector("#session-filter-hint")?.textContent ?? "", /Minimum is greater/)
  assert.equal(min.getAttribute("aria-invalid"), "true")
  assert.equal(max.getAttribute("aria-invalid"), "true")

  popover.querySelector<HTMLButtonElement>("#clear-session-filter")!.click()
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(new URL(page.window.location.href).searchParams.get("req_min"), null)
  assert.equal(new URL(page.window.location.href).searchParams.get("req_max"), null)
  assert.equal(popover.querySelector<HTMLElement>("#session-filter-hint")?.hidden, true)
  dashboard.destroy()
  await page.close()
})

test("size and date filters restore from the URL and clear together", async () => {
  const page = openPage("sessions")
  const from = dateInputValue(now - 86_400_000)
  const to = dateInputValue(now + 86_400_000)
  page.window.history.replaceState(null, "", `/sessions?orig_min=${encodeURIComponent("1 MiB")}&act_from=${from}&act_to=${to}`)
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(doc.querySelector('button[data-filter-key="original"]')?.getAttribute("data-active"), "true")
  assert.equal(doc.querySelector('button[data-filter-key="activity"]')?.getAttribute("data-active"), "true")
  assert.equal(doc.querySelector<HTMLButtonElement>("#clear-session-filters")?.hidden, false)

  let popover = openColumnFilter(doc, "original")
  assert.equal(popover.querySelector<HTMLInputElement>('[data-filter-field="originalMin"]')?.value, "1 MiB")
  popover = openColumnFilter(doc, "activity")
  assert.equal(popover.querySelector<HTMLInputElement>('[data-filter-field="activityFrom"]')?.value, from)
  assert.equal(popover.querySelector<HTMLInputElement>('[data-filter-field="activityTo"]')?.value, to)

  doc.querySelector<HTMLButtonElement>("#clear-session-filters")!.click()
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(doc.querySelector<HTMLElement>("#session-filter-popover")?.hidden, true)
  assert.equal(new URL(page.window.location.href).searchParams.get("orig_min"), null)
  assert.equal(new URL(page.window.location.href).searchParams.get("act_from"), null)
  assert.equal(doc.querySelector('button[data-filter-key="original"]')?.getAttribute("data-active"), "false")
  assert.equal(doc.querySelector<HTMLButtonElement>("#clear-session-filters")?.hidden, true)
  dashboard.destroy()
  await page.close()
})

test("session text filter opens from its header and closes with Escape or an outside click", async () => {
  const page = openPage("sessions")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const trigger = doc.querySelector<HTMLButtonElement>('button[data-filter-key="session"]')!
  trigger.focus()
  trigger.click()
  const popover = doc.querySelector<HTMLElement>("#session-filter-popover")!
  const input = popover.querySelector<HTMLInputElement>('[data-filter-field="session"]')!
  assert.equal(doc.activeElement, input)

  input.value = "api-refactor"
  page.fire(input, "input")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 1)
  assert.equal(new URL(page.window.location.href).searchParams.get("sid"), "api-refactor")
  assert.equal(trigger.getAttribute("data-active"), "true")

  doc.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event)
  assert.equal(popover.hidden, true)
  assert.equal(doc.activeElement, trigger)
  assert.equal(trigger.getAttribute("aria-expanded"), "false")

  trigger.click()
  page.fire(doc.body, "pointerdown")
  assert.equal(popover.hidden, true)
  dashboard.destroy()
  await page.close()
})

test("empty filtered state offers a clear action", async () => {
  const page = openPage("sessions")
  page.window.history.replaceState(null, "", "/sessions?sid=no-such-session")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const empty = doc.querySelector<HTMLElement>("#sessions-empty")!
  const clear = doc.querySelector<HTMLButtonElement>("#clear-session-filters-empty")!
  assert.equal(empty.hidden, false)
  assert.match(empty.textContent ?? "", /No matching sessions/)
  assert.equal(clear.hidden, false)
  assert.equal(doc.querySelector<HTMLElement>("#session-table-scroll")?.hidden, false, "the filterable header stays reachable")

  clear.click()
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  assert.equal(empty.hidden, true)
  assert.equal(clear.hidden, true)
  assert.equal(new URL(page.window.location.href).searchParams.get("sid"), null)
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

  assert.equal(doc.querySelector<HTMLElement>("#chart-relative")?.hidden, true)
  range.value = "last"
  page.fire(range, "change")
  assert.equal(doc.querySelector<HTMLElement>("#chart-relative")?.hidden, false)
  assert.equal(doc.querySelector<HTMLElement>("#chart-custom")?.hidden, true)
  const amount = doc.querySelector<HTMLInputElement>("#chart-last-amount")!
  const unit = doc.querySelector<HTMLSelectElement>("#chart-last-unit")!
  amount.value = "6"
  unit.value = "hours"
  doc.querySelector<HTMLButtonElement>("#chart-last-apply")!.click()
  assert.match(chart.getAttribute("aria-label") ?? "", /Last 6 hours/)
  assert.equal(new URL(page.window.location.href).searchParams.get("last"), "6")
  assert.equal(new URL(page.window.location.href).searchParams.get("unit"), "hours")
  amount.value = "3"
  unit.value = "days"
  doc.querySelector<HTMLButtonElement>("#chart-last-apply")!.click()
  assert.match(chart.getAttribute("aria-label") ?? "", /Last 3 days/)
  amount.value = "0"
  doc.querySelector<HTMLButtonElement>("#chart-last-apply")!.click()
  assert.match(doc.querySelector("#overview-range-notice")?.textContent ?? "", /greater than zero/)
  assert.equal(amount.getAttribute("aria-invalid"), "true")
  amount.value = "3"
  unit.value = "days"
  doc.querySelector<HTMLButtonElement>("#chart-last-apply")!.click()
  assert.match(chart.getAttribute("aria-label") ?? "", /Last 3 days/)

  trends.click()
  assert.ok(doc.querySelectorAll("#traffic-chart path.chart-saved-line").length > 0)

  range.value = "custom"
  page.fire(range, "change")
  assert.equal(doc.querySelector<HTMLElement>("#chart-custom")?.hidden, false)
  assert.equal(doc.querySelector<HTMLElement>("#chart-relative")?.hidden, true)
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
  assert.match(doc.querySelector("#overview-range-notice")?.textContent ?? "", /start date/)
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
  assert.equal(new URL(page.window.location.href).searchParams.get("range"), null)
  dashboard.destroy()
  await page.close()
})

test("relative traffic lookback is deep-linked through the URL", async () => {
  const page = openPage()
  page.window.history.replaceState(null, "", "/?range=last&last=18&unit=hours")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLSelectElement>("#chart-range")?.value, "last")
  assert.equal(doc.querySelector<HTMLElement>("#chart-relative")?.hidden, false)
  assert.equal(doc.querySelector<HTMLInputElement>("#chart-last-amount")?.value, "18")
  assert.equal(doc.querySelector<HTMLSelectElement>("#chart-last-unit")?.value, "hours")
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 18 hours/)
  dashboard.destroy()
  await page.close()
})

test("overview range sits above the cards and all presets share the chart totals", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const range = doc.querySelector<HTMLSelectElement>("#chart-range")!
  assert.equal(doc.querySelector("#overview")?.firstElementChild?.id, "overview-range")
  assert.equal(doc.querySelector("#traffic-panel #chart-range"), null)
  assert.equal(range.value, "30d")
  for (const preset of ["24h", "7d", "30d", "90d"] as const) {
    range.value = preset
    page.fire(range, "change")
    const totals = trafficData(snapshot, presetRange(preset, now)).totals
    assert.equal(doc.querySelector("#stat-saved")?.textContent, doc.querySelector("#chart-saved")?.textContent)
    assert.equal(doc.querySelector("#stat-reduction")?.textContent, doc.querySelector("#chart-saved-rate")?.textContent)
    assert.equal(doc.querySelector("#stat-requests")?.textContent, String(totals.requests + 1))
    assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", new RegExp(`${totals.requests} requests`))
  }
  dashboard.destroy()
  await page.close()
})

test("seconds and minutes update the four cards and render real request-level chart points", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  const request = snapshot.history.recent_requests.at(-2)!
  request.started_at = new Date(now - 10_000).toISOString()
  request.finished_at = new Date(now - 5000).toISOString()
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const range = doc.querySelector<HTMLSelectElement>("#chart-range")!
  range.value = "last"
  page.fire(range, "change")
  const amount = doc.querySelector<HTMLInputElement>("#chart-last-amount")!
  const unit = doc.querySelector<HTMLSelectElement>("#chart-last-unit")!
  const apply = doc.querySelector<HTMLButtonElement>("#chart-last-apply")!
  amount.value = "30"
  unit.value = "seconds"
  apply.click()
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "2")
  assert.equal(doc.querySelector("#nav-session-count")?.textContent, "2")
  assert.equal(doc.querySelector("#stat-requests")?.textContent, "2")
  assert.match(doc.querySelector("#chart-count")?.textContent ?? "", /^1 requests/)
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 30 seconds: 1 requests/)
  assert.equal(doc.querySelectorAll("#traffic-chart rect.chart-bar-upload").length, 1)
  assert.equal(doc.querySelector("#stat-saved")?.textContent, doc.querySelector("#chart-saved")?.textContent)
  assert.equal(doc.querySelector("#stat-reduction")?.textContent, doc.querySelector("#chart-saved-rate")?.textContent)
  const appliedChart = doc.querySelector("#traffic-chart")!.getAttribute("aria-label")
  const appliedUrl = page.window.location.href
  amount.value = "0"
  apply.click()
  assert.equal(doc.querySelector("#traffic-chart")!.getAttribute("aria-label"), appliedChart)
  assert.equal(page.window.location.href, appliedUrl)
  assert.equal(doc.querySelector("#stat-requests")?.textContent, "2")
  assert.equal(doc.activeElement, amount)
  amount.value = "4"
  apply.click()
  assert.equal(doc.querySelector("#stat-sessions")?.textContent, "0")
  assert.equal(doc.querySelector("#nav-session-count")?.textContent, "0")
  assert.equal(doc.querySelector("#stat-requests")?.textContent, "0")
  assert.equal(doc.querySelector("#stat-reduction")?.textContent, "—")
  assert.equal(doc.querySelector("#stat-saved")?.textContent, doc.querySelector("#chart-saved")?.textContent)
  assert.match(doc.querySelector("#traffic-chart")?.textContent ?? "", /No finished requests/)
  amount.value = "1"
  unit.value = "minutes"
  apply.click()
  assert.match(doc.querySelector("#traffic-chart")?.getAttribute("aria-label") ?? "", /Last 1 minute: 1 requests/)
  assert.equal(new URL(page.window.location.href).searchParams.get("unit"), "minutes")
  snapshot.collected_at = new Date(now + 120_000).toISOString()
  await dashboard.refresh()
  assert.equal(doc.querySelector("#stat-requests")?.textContent, "0", "relative windows move with the latest snapshot")
  dashboard.destroy()
  // Destroy detaches the shared range handlers.
  amount.value = "10"
  apply.click()
  assert.equal(doc.querySelector("#stat-requests")?.textContent, "0")
  await page.close()
})

test("pasted timestamp ranges preview timezones, apply atomically, and restore with the chart view", async () => {
  const page = openPage()
  const snapshot = makeSnapshot(now)
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const range = doc.querySelector<HTMLSelectElement>("#chart-range")!
  range.value = "custom"
  page.fire(range, "change")
  doc.querySelector<HTMLButtonElement>("#range-mode-timestamps")!.click()
  assert.equal(doc.querySelector<HTMLElement>("#range-date-fields")!.hidden, true)
  const start = doc.querySelector<HTMLInputElement>("#range-timestamp-start")!
  const end = doc.querySelector<HTMLInputElement>("#range-timestamp-end")!
  start.value = "2026-10-28T13:15:00+02:00"
  end.value = String(now / 1000)
  page.fire(start, "input")
  assert.match(doc.querySelector("#range-timestamp-preview")?.textContent ?? "", /Will apply:/)
  doc.querySelector<HTMLButtonElement>("#range-timestamp-apply")!.click()
  const expected = snapshot.history.recent_requests.filter((request) => request.finished_at && Date.parse(request.finished_at) >= now - 3_600_000 && Date.parse(request.finished_at) < now)
  assert.equal(doc.querySelector("#stat-requests")?.textContent, String(expected.length + 1))
  assert.equal(doc.querySelector("#stat-saved")?.textContent, doc.querySelector("#chart-saved")?.textContent)
  doc.querySelector<HTMLButtonElement>("#chart-view-trends")!.click()
  assert.equal(doc.querySelector("#traffic-chart")?.getAttribute("data-view"), "trends")
  const url = page.window.location.href
  const chart = doc.querySelector("#traffic-chart")?.getAttribute("aria-label")
  end.value = "2026-02-30T12:00:00Z"
  doc.querySelector<HTMLButtonElement>("#range-timestamp-apply")!.click()
  assert.match(doc.querySelector("#overview-range-notice")?.textContent ?? "", /valid start and end/)
  assert.equal(doc.querySelector("#traffic-chart")?.getAttribute("aria-label"), chart)
  assert.equal(page.window.location.href, url)
  dashboard.destroy()
  await page.close()

  const restored = openPage()
  restored.window.history.replaceState(null, "", url)
  restored.setFetch(() => json(snapshot))
  const app = startDashboard(restored.document, { autoStart: false })
  await app.refresh()
  assert.equal(restored.document.querySelector<HTMLSelectElement>("#chart-range")?.value, "custom")
  assert.equal(restored.document.querySelector<HTMLButtonElement>("#range-mode-timestamps")?.getAttribute("aria-pressed"), "true")
  assert.equal(restored.document.querySelector<HTMLInputElement>("#range-timestamp-start")?.value, "2026-10-28T13:15:00+02:00")
  assert.equal(restored.document.querySelector("#traffic-chart")?.getAttribute("aria-label"), chart)
  app.destroy()
  await restored.close()
})

test("session page size can be changed and resets pagination", async () => {
  const page = openPage("sessions")
  const snapshot = makeSnapshot(now)
  const extra = Array.from({ length: 10 }, (_, index) => ({
    ...snapshot.history.sessions[index % 6]!,
    id: `ses_page_size_${index}`,
    active: 0,
    last_status: 200,
    last_error: undefined,
  }))
  snapshot.history.sessions.push(...extra)
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const size = doc.querySelector<HTMLSelectElement>("#session-page-size")!
  assert.equal(size.value, "8")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 8)
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 1 of 2")

  doc.querySelector<HTMLButtonElement>("#next-page")!.click()
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 2 of 2")

  size.value = "50"
  page.fire(size, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 16)
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 1 of 1", "changing page size resets pagination")
  assert.equal(new URL(page.window.location.href).searchParams.get("rows"), "50")

  size.value = "8"
  page.fire(size, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 8)
  assert.equal(new URL(page.window.location.href).searchParams.get("rows"), null, "the default page size stays implicit")
  dashboard.destroy()
  await page.close()
})

test("session search, state, and pagination are deep-linked through the URL", async () => {
  const page = openPage("sessions")
  page.window.history.replaceState(null, "", "/sessions?q=api&state=idle&page=2&rows=25")
  page.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const search = doc.querySelector<HTMLInputElement>("#session-search")!
  assert.equal(search.value, "api")
  assert.equal(doc.querySelector<HTMLSelectElement>("#session-page-size")?.value, "25")
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 1 of 1")
  assert.equal(new URL(page.window.location.href).searchParams.get("page"), null)
  const popover = openColumnFilter(doc, "state")
  assert.equal(popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="idle"]')?.checked, true)

  search.value = "openai"
  page.fire(search, "input")
  const all = popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="all"]')!
  all.checked = true
  page.fire(all, "change")
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
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(catalog))
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
    assert.equal(url, "/api/dashboard?compact=1")
    return json(snapshot)
  })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#stat-sessions"), null)
  assert.equal(doc.querySelector("#traffic-chart"), null)
  assert.equal(doc.querySelector("#system-summary"), null)
  assert.equal(doc.querySelector("#session-rows")?.children.length, 6)
  const firstRow = doc.querySelector<HTMLElement>("#session-rows tr")!
  assert.equal(firstRow.children[1]?.textContent, "alpha")
  assert.equal(doc.querySelector("#session-count")?.textContent, "6")
  assert.equal(doc.querySelector("#nav-session-count")?.textContent, "6")
  assert.match(doc.querySelector("#table-summary")?.textContent ?? "", /1–6 of 6 sessions/)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))], ["/api/dashboard?compact=1"])
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
  const popover = openColumnFilter(doc, "state")
  const attention = popover.querySelector<HTMLInputElement>('input[data-filter-option="state"][value="attention"]')!
  attention.checked = true
  page.fire(attention, "change")
  assert.equal(doc.querySelector("#session-rows")?.children.length, 1)
  assert.match(doc.querySelector("#session-rows")?.textContent ?? "", /Attention/)
  assert.equal(new URL(page.window.location.href).searchParams.get("state"), "attention")
  dashboard.destroy()
  await page.close()
})

test("session sorting toggles numeric columns, resets pagination, and restores from the URL", async () => {
  const page = openPage("sessions")
  const snapshot = makeSnapshot(now)
  const extra = snapshot.history.sessions.slice(0, 4).map((session, index) => ({
    ...session,
    id: `ses_sort_extra_${index}`,
    upstream: "sort-upstream",
    active: 0,
    last_status: 200,
    last_error: undefined,
  }))
  snapshot.history.sessions.push(...extra)
  page.window.history.replaceState(null, "", "/sessions?sort=requests&dir=desc")
  page.setFetch(() => json(snapshot))
  const dashboard = startDashboard(page.document, { autoStart: false })
  await dashboard.refresh()
  const doc = page.document
  const rows = () => [...doc.querySelectorAll<HTMLElement>("#session-rows tr")]
  const numbers = (column: number, parse: (text: string | undefined) => number) => rows().map((row) => parse(row.children[column]?.textContent ?? ""))
  const requestsHeader = doc.querySelector<HTMLElement>('th[data-sort-key="requests"]')!
  const requestsButton = requestsHeader.querySelector<HTMLButtonElement>("button")!
  const originalHeader = doc.querySelector<HTMLElement>('th[data-sort-key="original"]')!
  const reductionHeader = doc.querySelector<HTMLElement>('th[data-sort-key="reduction"]')!
  const activityHeader = doc.querySelector<HTMLElement>('th[data-sort-key="activity"]')!
  const sortSelect = doc.querySelector<HTMLSelectElement>("#session-sort")!
  const sortDirection = doc.querySelector<HTMLButtonElement>("#session-sort-direction")!

  assert.equal(requestsHeader.getAttribute("aria-sort"), "descending")
  assert.equal(sortSelect.value, "requests")
  assert.match(requestsButton.getAttribute("aria-label") ?? "", /sorted descending/)
  assert.ok(descending(numbers(3, Number)), "requests sort numerically descending")

  doc.querySelector<HTMLButtonElement>("#next-page")!.click()
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 2 of 2")
  requestsButton.click()
  assert.equal(doc.querySelector("#page-label")?.textContent, "Page 1 of 2", "sorting resets pagination")
  assert.equal(requestsHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "requests")
  assert.equal(new URL(page.window.location.href).searchParams.get("dir"), "asc")
  assert.ok(ascending(numbers(3, Number)), "requests sort numerically ascending")

  originalHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(originalHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(requestsHeader.getAttribute("aria-sort"), "none")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "original")
  assert.ok(ascending(numbers(4, parseBytesLabel)), "original bytes sort numerically")

  originalHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(originalHeader.getAttribute("aria-sort"), "descending")
  assert.ok(descending(numbers(4, parseBytesLabel)), "original bytes sort numerically descending")

  reductionHeader.querySelector<HTMLButtonElement>("button")!.click()
  assert.equal(reductionHeader.getAttribute("aria-sort"), "ascending")
  assert.ok(ascending(numbers(6, parsePercentLabel)), "reduction percentage sorts numerically")
  assert.match(reductionHeader.querySelector("button")!.getAttribute("aria-label") ?? "", /sorted ascending/)

  sortSelect.value = "activity"
  page.fire(sortSelect, "change")
  assert.equal(activityHeader.getAttribute("aria-sort"), "descending")
  assert.equal(sortDirection.dataset.direction, "desc")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), null, "default recent order stays implicit")
  sortDirection.click()
  assert.equal(activityHeader.getAttribute("aria-sort"), "ascending")
  assert.equal(new URL(page.window.location.href).searchParams.get("sort"), "activity")
  assert.equal(new URL(page.window.location.href).searchParams.get("dir"), "asc")
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
  const measure = doc.querySelector<HTMLAnchorElement>("#detail-measure")!
  assert.equal(measure.hidden, false)
  const measureUrl = new URL(measure.href, page.window.location.href)
  assert.equal(measureUrl.pathname, "/measurement")
  assert.equal(measureUrl.searchParams.get("session"), button.dataset.sessionId)
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
    assert.match(csv, /^"session_id","hosts","upstream","requests","active","failed","legacy","cancelled"/)
    assert.match(csv, /"'=SUM\(A1\)","alpha","'@command"/)
    assert.match(download, /^deltarelay-sessions-\d{4}-\d{2}-\d{2}\.csv$/)
    assert.match(sessionCsv(snapshot.history.sessions), /"'=SUM\(A1\)"/)
    dashboard.destroy()
  } finally {
    page.window.HTMLAnchorElement.prototype.click = click
  }
  await page.close()
})

test("CSV export respects column filters", async () => {
  const page = openPage("sessions")
  const snapshot = makeSnapshot(now)
  page.setFetch(() => json(snapshot))
  let captured: Blob | undefined
  Object.defineProperty(page.window.URL, "createObjectURL", { value: (value: Blob) => { captured = value; return "blob:test" }, configurable: true })
  Object.defineProperty(page.window.URL, "revokeObjectURL", { value: () => undefined, configurable: true })
  const click = page.window.HTMLAnchorElement.prototype.click
  page.window.HTMLAnchorElement.prototype.click = function () { /* keep the test inside happy-dom */ }
  try {
    const dashboard = startDashboard(page.document, { autoStart: false })
    await dashboard.refresh()
    const doc = page.document
    const trigger = doc.querySelector<HTMLButtonElement>('button[data-filter-key="session"]')!
    trigger.click()
    const input = doc.querySelector<HTMLInputElement>('[data-filter-field="session"]')!
    input.value = "api-refactor"
    page.fire(input, "input")
    doc.querySelector<HTMLButtonElement>("#export-button")!.click()
    assert.ok(captured)
    const csv = await captured.text()
    assert.match(csv, /ses_a93f10_api-refactor/)
    assert.doesNotMatch(csv, /ses_7fd82a_relay-dashboard/)
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
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
    if (url === "/api/system") return json(status)
    throw new Error(`Unexpected URL ${url}`)
  })
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  assert.match(doc.querySelector("#system-summary")?.textContent ?? "", /Relay checks passed/)
  assert.match(doc.querySelector("#system-cards")?.textContent ?? "", /Hostalpha/)
  assert.equal(doc.querySelector("#session-rows"), null)
  assert.equal(doc.querySelector("#stat-sessions"), null)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))].sort(), ["/api/dashboard?compact=1", "/api/system"])
  const auth = doc.querySelector("#provider-auth")!
  assert.equal(auth.closest("article")?.querySelector("h3")?.textContent, "Provider details")
  assert.equal(auth.querySelector("#auth-state")?.textContent, "Current token")
  assert.match(auth.querySelector("#auth-countdown")?.textContent ?? "", /59m|1h/)
  const disclosure = auth.querySelector<HTMLDetailsElement>("details")!
  disclosure.open = true
  await dashboard.refresh()
  assert.equal(doc.querySelector("#provider-auth"), auth)
  assert.equal(disclosure.open, true)
  status.auth.stale = true
  await system.refresh()
  assert.equal(auth.querySelector("#auth-state")?.textContent, "Stale metadata")
  assert.match(auth.querySelector("#auth-countdown")?.textContent ?? "", /^Last known:/)
  status.auth.stale = false
  status.auth.state = "needs_auth"
  status.auth.expires_at = undefined
  await system.refresh()
  assert.equal(auth.querySelector("#auth-countdown")?.textContent, "Sign-in required")
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("provider details shows the OpenCode Go allowance and switches provider tabs", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  snapshot.providers = [
    { name: "openai", origin: "https://api.openai.com", path_prefix: "/v1/", active: 1, last_status: 200, last_seen: new Date(now - 40_000).toISOString() },
    { name: "opencode", origin: "https://opencode.ai", path_prefix: "/inference/", active: 2, last_status: 200, last_seen: new Date(now - 20_000).toISOString() },
  ]
  const status = systemStatus({
    go: {
      rolling: { percent: 8, limited: false, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      weekly: { percent: 22, limited: false, resets_at: new Date(Date.now() + 2 * 86_400_000).toISOString() },
      monthly: { percent: 11, limited: false, resets_at: new Date(Date.now() + 29 * 86_400_000).toISOString() },
      checked_at: new Date(now).toISOString(),
      stale: false,
    },
  })
  page.setFetch((url) => {
    if (url.startsWith("/api/dashboard?")) return json(snapshot)
    if (url === "/api/system") return json(status)
    throw new Error(`Unexpected URL ${url}`)
  })
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  const tabs = () => [...doc.querySelectorAll<HTMLButtonElement>('#system-cards [role="tab"]')]
  const panel = (name: string) => doc.querySelector<HTMLElement>(`#system-cards [data-provider-panel="${name}"]`)

  assert.deepEqual(tabs().map((tab) => tab.textContent?.trim()), ["opencode-go", "openai"])
  assert.ok(tabs()[0]?.querySelector("svg.provider-mark-opencode"))
  assert.ok(tabs()[1]?.querySelector("svg.provider-mark-openai"))
  assert.ok(panel("opencode-go")?.querySelector(".provider-name svg.provider-mark-opencode"))
  assert.ok(panel("openai")?.querySelector(".provider-name svg.provider-mark-openai"))
  assert.equal(tabs()[0]?.getAttribute("aria-selected"), "true")
  assert.equal(panel("opencode-go")?.hidden, false)
  assert.equal(panel("openai")?.hidden, true)
  assert.match(panel("opencode-go")?.textContent ?? "", /opencode\.ai · \/inference\//)
  assert.match(panel("opencode-go")?.textContent ?? "", /Go allowance.*8%.*22%.*11%/s)
  assert.match(panel("opencode-go")?.querySelector(".provider-usage-reset")?.textContent ?? "", /resets in 2h/)

  const auth = doc.querySelector("#provider-auth")!
  assert.equal(auth.closest("[data-provider-panel]")?.getAttribute("data-provider-panel"), "openai")
  tabs()[1]!.click()
  assert.equal(panel("opencode-go")?.hidden, true)
  assert.equal(panel("openai")?.hidden, false)
  assert.equal(tabs()[1]?.getAttribute("aria-selected"), "true")

  // A dashboard refresh and a system refresh keep the selected tab and the
  // mounted auth element, including its disclosure state.
  const disclosure = auth.querySelector<HTMLDetailsElement>("details")!
  disclosure.open = true
  await dashboard.refresh()
  await system.refresh()
  assert.equal(tabs()[1]?.getAttribute("aria-selected"), "true")
  assert.equal(panel("openai")?.hidden, false)
  assert.equal(doc.querySelector("#provider-auth"), auth)
  assert.equal(disclosure.open, true)

  status.auth.state = "needs_auth"
  await system.refresh()
  assert.ok(tabs()[1]?.querySelector(".provider-tab-dot.warning"))

  status.go = undefined
  await system.refresh()
  assert.match(panel("openai")?.textContent ?? "", /ChatGPT sign-in/)
  tabs()[0]!.click()
  assert.match(panel("opencode-go")?.textContent ?? "", /Go usage is unavailable/)

  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("provider details marks a limited Go allowance as attention", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  snapshot.providers = [{ name: "opencode", active: 5, last_status: 200, last_seen: new Date(now).toISOString() }]
  const status = systemStatus({
    go: {
      rolling: { percent: 8, limited: false, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      weekly: { percent: 22, limited: false, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      monthly: { percent: 100, limited: true, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      checked_at: new Date(now).toISOString(),
      stale: false,
    },
  })
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(status))
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  assert.match(doc.querySelector("#system-cards")?.textContent ?? "", /Check results/)
  assert.match(doc.querySelector('[data-provider-panel="opencode-go"]')?.textContent ?? "", /Limit reached/)
  assert.equal(doc.querySelector('[data-provider-panel="opencode-go"] .provider-usage-row.warning .provider-usage-percent')?.textContent, "100%")
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("provider usage preserves decimal percentages and shows the last successful fetch time", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  const allowance = {
    rolling: { percent: 0.345, limited: false, resets_at: new Date(now + 3_600_000).toISOString() },
    weekly: { percent: 22.6789, limited: false, resets_at: new Date(now + 86_400_000).toISOString() },
    monthly: { percent: 99.9999, limited: false, resets_at: new Date(now + 86_400_000).toISOString() },
    checked_at: new Date(now - 60_000).toISOString(),
    stale: false,
  }
  const status = systemStatus({ go: allowance })
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(status))
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  const panel = () => page.document.querySelector('[data-provider-panel="opencode-go"]')!
  const fetchedAt = () => panel().querySelector(".provider-usage-fetched time")
  try {
    await Promise.all([dashboard.refresh(), system.refresh()])
    assert.deepEqual([...panel().querySelectorAll(".provider-usage-percent")].map((row) => row.textContent), ["0.345%", "22.6789%", "99.9999%"])
    assert.deepEqual([...panel().querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute("aria-valuenow")), ["0.345", "22.6789", "99.9999"])
    assert.deepEqual([...panel().querySelectorAll<HTMLElement>(".provider-usage-track > i")].map((bar) => bar.style.width), ["0.345%", "22.6789%", "99.9999%"])
    assert.equal(panel().querySelector(".provider-usage-row.warning"), null)
    assert.match(panel().querySelector(".provider-usage-fetched")?.textContent ?? "", /Last fetched/)
    assert.equal(fetchedAt()?.getAttribute("datetime"), allowance.checked_at)
    assert.equal(fetchedAt()?.textContent, new Date(allowance.checked_at).toLocaleString())

    await Promise.all([dashboard.refresh(), system.refresh()])
    assert.equal(fetchedAt()?.getAttribute("datetime"), allowance.checked_at, "polling cached usage must not change its fetch time")
    allowance.stale = true
    status.collected_at = new Date(now + 5_000).toISOString()
    await system.refresh()
    assert.match(panel().textContent ?? "", /Stale/)
    assert.equal(fetchedAt()?.getAttribute("datetime"), allowance.checked_at, "stale usage keeps its last successful fetch time")

    allowance.checked_at = new Date(now + 30_000).toISOString()
    allowance.stale = false
    await system.refresh()
    assert.equal(fetchedAt()?.getAttribute("datetime"), allowance.checked_at)
    assert.equal(fetchedAt()?.textContent, new Date(allowance.checked_at).toLocaleString())
  } finally {
    dashboard.destroy()
    system.destroy()
    await page.close()
  }
})

test("provider details shows one Go account with a chooser and an explicit active-key marker", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  snapshot.providers = [{ name: "openai", active: 0, last_status: 200, last_seen: new Date(now).toISOString() }]
  const allowance = {
    rolling: { percent: 8, limited: false, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    weekly: { percent: 64, limited: false, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    monthly: { percent: 63, limited: false, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    checked_at: new Date(now).toISOString(),
    stale: false,
  }
  const status = systemStatus({
    go_accounts: [
      { id: "a".repeat(32), label: 'Saved <img src=x onerror="alert(1)">', active: false, state: "ready", allowance },
      { id: "b".repeat(32), label: "Current account", active: true, state: "ready", allowance: { ...allowance, checked_at: new Date(now - 30_000).toISOString(), rolling: { ...allowance.rolling, percent: 0 }, weekly: { ...allowance.weekly, percent: 0 }, monthly: { ...allowance.monthly, percent: 0 } } },
    ],
  })
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(status))
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  const accounts = () => [...doc.querySelectorAll('[data-provider-panel="opencode-go"] .provider-usage-account')]
  const fetchedAt = () => accounts()[0]?.querySelector(".provider-usage-fetched time")?.getAttribute("datetime")
  const choose = (id: string) => {
    doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")!.open = true
    doc.querySelector<HTMLInputElement>(`input[data-go-account="${id}"]`)!.click()
  }
  assert.equal(accounts().length, 1)
  assert.equal(accounts()[0]?.querySelector(".provider-usage-account-label")?.textContent, "Current account")
  assert.equal(accounts()[0]?.querySelector(".provider-usage-account-head .provider-usage-key-status.active")?.textContent, "Active key")
  assert.equal(doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")?.open, false)
  assert.equal(doc.querySelector(".provider-account-trigger")?.textContent, "Choose account")
  assert.equal(doc.querySelector<HTMLInputElement>('input[data-go-account="' + "b".repeat(32) + '"]')?.checked, true)
  assert.equal(doc.querySelectorAll('[data-provider-panel="opencode-go"] [role="progressbar"]').length, 3)
  assert.deepEqual([...accounts()[0]!.querySelectorAll(".provider-usage-percent")].map((row) => row.textContent), ["0%", "0%", "0%"])
  assert.equal(fetchedAt(), status.go_accounts![1]!.allowance!.checked_at)

  choose("a".repeat(32))
  assert.equal(accounts().length, 1)
  assert.equal(accounts()[0]?.querySelector(".provider-usage-account-label")?.textContent, status.go_accounts![0]!.label)
  assert.equal(accounts()[0]?.querySelector("img"), null)
  assert.equal(accounts()[0]?.querySelector(".provider-usage-account-head .provider-usage-key-status")?.textContent, "Saved key")
  assert.match(doc.querySelector(".provider-account-active-context")?.textContent ?? "", /Active keyCurrent account/)
  assert.equal(doc.querySelector(".provider-account-active-context .provider-usage-key-status.active")?.textContent, "Active key")
  assert.deepEqual([...accounts()[0]!.querySelectorAll(".provider-usage-percent")].map((row) => row.textContent), ["8%", "64%", "63%"])
  assert.equal(fetchedAt(), allowance.checked_at)
  assert.equal(doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")?.open, false)
  assert.equal(doc.activeElement, doc.querySelector(".provider-account-trigger"))
  assert.deepEqual(status.go_accounts!.map((account) => account.active), [false, true], "choosing a view must never activate a key")

  // Failures are still isolated when only the selected key's usage is rendered.
  status.go_accounts![0] = { ...status.go_accounts![0]!, state: "unavailable", allowance: { ...allowance, stale: true } }
  await system.refresh()
  assert.match(accounts()[0]?.textContent ?? "", /Stale.*8%.*64%.*63%.*Showing last known usage/s)
  assert.equal(fetchedAt(), allowance.checked_at)
  assert.ok(doc.querySelector('[data-provider-tab="opencode-go"] .provider-tab-dot.warning'))
  assert.match(doc.querySelector("#system-cards")?.textContent ?? "", /Check results/)
  choose("b".repeat(32))
  assert.match(accounts()[0]?.textContent ?? "", /Within limits/)
  assert.equal(accounts()[0]?.querySelectorAll('[role="progressbar"]').length, 3)
  choose("a".repeat(32))

  for (const [state, message] of [["invalid_key", /API key was rejected/], ["forbidden", /Usage access was denied/], ["unavailable", /Usage could not be checked/]] as const) {
    status.go_accounts![0] = { id: "a".repeat(32), label: "Saved account", active: false, state }
    await system.refresh()
    assert.match(accounts()[0]?.textContent ?? "", message)
    assert.equal(accounts()[0]?.querySelectorAll('[role="progressbar"]').length, 0)
    assert.equal(fetchedAt(), undefined, "no successful usage fetch must not show a timestamp")
  }
  status.go_accounts = [status.go_accounts![1]!]
  await system.refresh()
  assert.equal(accounts().length, 1)
  assert.equal(doc.querySelector("[data-go-account-chooser]"), null)
  assert.match(accounts()[0]?.textContent ?? "", /Current account.*Active key/s)
  assert.ok(doc.querySelector('[data-provider-tab="opencode-go"] .provider-tab-dot.neutral'))

  // A failed system poll preserves both the key label and its stale usage.
  page.setFetch((url) => {
    if (url === "/api/system") throw new Error("offline")
    return json(snapshot)
  })
  await system.refresh()
  assert.match(accounts()[0]?.textContent ?? "", /Current account.*Stale/s)
  assert.equal(fetchedAt(), status.go_accounts![0]!.allowance!.checked_at)
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("Go account viewing survives refresh, reordering and renaming without confusing selection with activity", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  const meter = { percent: 8, limited: false, resets_at: new Date(now + 3_600_000).toISOString() }
  const allowance = { rolling: meter, weekly: meter, monthly: meter, checked_at: new Date(now).toISOString(), stale: false }
  const first = { id: "a".repeat(32), label: "Shared label", active: false, state: "ready" as const, allowance }
  const second = { id: "b".repeat(32), label: "Shared label", active: true, state: "ready" as const, allowance: { ...allowance, rolling: { ...meter, percent: 22 } } }
  const status = systemStatus({ go_accounts: [first, second] })
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(status))
  const system = startSystemStatus(page.document, { autoStart: false, manageHeader: false })
  const dashboard = startDashboard(page.document, { autoStart: false })
  await Promise.all([dashboard.refresh(), system.refresh()])
  const doc = page.document
  const percent = () => doc.querySelector(".provider-usage-account .provider-usage-percent")?.textContent
  assert.equal(percent(), "22%")
  // Until explicitly choosing a view, follow whichever key OpenCode activates.
  first.active = true
  second.active = false
  await system.refresh()
  assert.equal(percent(), "8%")
  doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")!.open = true
  doc.querySelector<HTMLInputElement>(`input[data-go-account="${second.id}"]`)!.click()
  assert.equal(percent(), "22%")
  assert.equal(doc.querySelector(".provider-usage-account-head .provider-usage-key-status.active"), null)
  assert.match(doc.querySelector(".provider-account-active-context")?.textContent ?? "", /Active keyShared label/)

  second.label = "Renamed account"
  status.go_accounts = [second, first]
  doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")!.open = true
  doc.querySelector<HTMLInputElement>(`input[data-go-account="${second.id}"]`)!.focus()
  await Promise.all([dashboard.refresh(), system.refresh()])
  assert.equal(percent(), "22%")
  assert.equal(doc.querySelector(".provider-usage-account-label")?.textContent, "Renamed account")
  assert.equal(doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")?.open, true)
  assert.equal((doc.activeElement as HTMLElement).dataset.goAccount, second.id)
  doc.activeElement!.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as KeyboardEvent)
  assert.equal(doc.querySelector<HTMLDetailsElement>("[data-go-account-chooser]")?.open, false)
  assert.equal(doc.activeElement, doc.querySelector(".provider-account-trigger"))

  first.active = false
  second.active = true
  await system.refresh()
  assert.equal(doc.querySelector(".provider-usage-account-head .provider-usage-key-status.active")?.textContent, "Active key")
  assert.equal(doc.querySelector(".provider-account-active-context"), null)
  status.go_accounts = [first]
  await system.refresh()
  assert.equal(percent(), "8%")
  assert.equal(doc.querySelector("[data-go-account-chooser]"), null)
  assert.equal(doc.querySelector(".provider-usage-key-status.active"), null, "do not invent an active key when none is reported")
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))].sort(), ["/api/dashboard?compact=1", "/api/system"])
  dashboard.destroy()
  system.destroy()
  await page.close()
})

test("system health distinguishes no internet from an unreachable VPS", async () => {
  const page = openPage("system")
  const snapshot = makeSnapshot(now)
  snapshot.relay.reachable = false
  const noInternet = systemStatus({ relay_state: "unreachable", internet_state: "unreachable" })
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(snapshot) : json(noInternet))
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
  page.setFetch((url) => url.startsWith("/api/dashboard?") ? json(makeSnapshot(now)) : json(systemStatus()))
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

test("map prominently encloses every process, its modules and owned files, without calling hosts or services processes", async () => {
  const page = openPage("controls")
  const doc = page.document
  const role = (id: string) => doc.querySelector(`[data-node-id="${id}"] .map-node-role`)?.textContent
  assert.equal(role("vscode"), "Editor")
  assert.equal(role("openchamber"), "App")
  assert.equal(role("opencode"), "Process")
  assert.equal(role("plugin"), "Module")
  assert.equal(role("gate"), "Process")
  assert.equal(role("relay"), "Process")
  assert.equal(role("storage"), "Files")
  assert.equal(role("provider"), "External API")
  assert.match(doc.querySelector(".map-boundary-key")?.textContent ?? "", /Frontend process.*Encloses an interface.*Backend process.*Encloses a local service.*Host \/ location \/ resource.*not a process/)
  const contains = (groupID: string, nodeID: string) => {
    const group = doc.querySelector(`[data-map-group="${groupID}"]`)!
    const node = mapNodes.find((item) => item.id === nodeID)!
    const x = Number(group.getAttribute("x")), y = Number(group.getAttribute("y"))
    return node.x >= x && node.y >= y && node.x + nodeWidth <= x + Number(group.getAttribute("width")) && node.y + nodeHeight <= y + Number(group.getAttribute("height"))
  }
  for (const [id, members] of Object.entries({ vscode: ["vscode"], desktop: ["desktop"], openchamber: ["openchamber"], opencode: ["opencode", "plugin"], gateway: ["gateway"], gate: ["gate"], relay: ["relay", "storage"], dashboard_ui: ["dashboard_ui"], dashboard: ["dashboard"], supervisor: ["supervisor"], remote_provider: ["remote_provider"] })) {
    const outline = doc.querySelector(`[data-map-group="${id}"]`)!
    assert.equal(outline.getAttribute("data-boundary-kind"), "process", id)
    assert.ok(outline.classList.contains("map-process"), `${id}: prominent process outline`)
    assert.match(doc.querySelector(`#map-boundary-${id} [data-boundary-label]`)?.textContent ?? "", /PROCESS/, id)
    assert.deepEqual(mapNodes.filter((node) => contains(id, node.id)).map((node) => node.id), members, id)
  }
  for (const [id, side] of Object.entries({ vscode: "frontend", desktop: "frontend", openchamber: "frontend", dashboard_ui: "frontend", opencode: "backend", gateway: "backend", gate: "backend", relay: "backend", dashboard: "backend", supervisor: "backend", remote_provider: "backend" })) {
    assert.ok(doc.querySelector(`[data-map-group="${id}"]`)!.classList.contains(`map-${side}`), `${id}: ${side} outline`)
    assert.ok(doc.querySelector(`#map-boundary-${id}`)!.classList.contains(`map-${side}`), `${id}: ${side} heading`)
  }
  for (const id of ["remote", "network", "provider", "tunnel"]) {
    assert.notEqual(doc.querySelector(`[data-map-group="${id}"]`)?.getAttribute("data-boundary-kind"), "process", `${id}: no invented process`)
  }
  assert.equal(contains("opencode", "plugin"), true)
  assert.equal(contains("opencode", "gateway"), false)
  assert.equal(contains("relay", "relay"), true)
  assert.equal(contains("relay", "storage"), true)
  assert.equal(contains("remote", "relay"), true)
  assert.equal(contains("remote", "storage"), true)
  assert.equal(contains("remote", "provider"), false)
  assert.equal(contains("provider", "provider"), true)
  assert.match(doc.querySelector("#map-boundary-opencode-description")?.textContent ?? "", /plugin is loaded inside.*not a separate process/)
  assert.match(doc.querySelector("#map-boundary-relay-description")?.textContent ?? "", /persistent files.*survive process restarts/)
  assert.match(doc.querySelector("#map-boundary-remote_provider-description")?.textContent ?? "", /invoked on demand.*not a permanently running server/)
  assert.match(doc.querySelector(".map-boundary-note")?.textContent ?? "", /files survive restarts/)
  for (const node of mapNodes) {
    const description = doc.querySelector(`[data-node-id="${node.id}"]`)?.getAttribute("aria-describedby")
    assert.ok(description && doc.getElementById(description), `${node.id}: accessible boundary description`)
  }
  await page.close()
})

test("OpenChamber is a supervised frontend application attached through the shared frontend gate", async () => {
  const page = openPage("controls")
  page.setFetch(() => json(systemStatus()))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  const row = doc.querySelector<HTMLElement>('[data-component-id="openchamber"]')!
  assert.equal(row.querySelector("[data-component-type]")?.textContent, "Applications")
  assert.equal(row.querySelector("[data-component-description]")?.textContent, "Supervised frontend that attaches to the shared OpenCode service through the frontend health gate. Start it from these controls; it never opens automatically.")
  const node = doc.querySelector<HTMLButtonElement>('[data-node-id="openchamber"]')!
  assert.equal(node.querySelector("strong")?.textContent, "OpenChamber")
  assert.equal(node.querySelector(".map-node-role")?.textContent, "App")
  doc.querySelector<HTMLButtonElement>("#system-architecture-tab")!.click()
  const attach = doc.querySelector('[data-edge-id="openchamber_gate"]')!
  assert.ok(attach.classList.contains("request"))
  assert.match(attach.querySelector("title")?.textContent ?? "", /Model request flow · openchamber → gate: Attach-only local HTTP/)
  const manage = doc.querySelector('[data-edge-id="supervisor_openchamber"]')!
  assert.ok(manage.classList.contains("control"))
  node.click()
  assert.equal(node.getAttribute("aria-pressed"), "true")
  assert.ok(doc.querySelector('[data-edge-id="openchamber_gate"]')!.classList.contains("selected"))
  assert.ok(doc.querySelector('[data-edge-id="supervisor_openchamber"]')!.classList.contains("selected"))
  assert.equal(doc.querySelector("#map-selection")?.textContent, "OpenChamber · 3 visible arrows highlighted")
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  app.destroy()
  await page.close()
})

test("transport boundary switches between a tunnel process and a direct HTTPS path using supervisor evidence", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  const tunnel = status.topology!.nodes.find((node) => node.id === "tunnel")!
  page.setFetch((url) => url === "/api/system" ? json(status) : json(setupStatus()))
  const system = startSystemStatus(page.document, { autoStart: false })
  const doc = page.document
  const outline = doc.querySelector('[data-map-group="tunnel"]')!
  const heading = doc.querySelector("#map-boundary-tunnel")!
  const role = doc.querySelector('[data-node-id="tunnel"] .map-node-role')!
  await system.refresh()
  assert.equal(outline.getAttribute("data-boundary-kind"), "process")
  assert.ok(outline.classList.contains("map-process"))
  assert.match(heading.textContent ?? "", /PROCESS · LOCAL TUNNEL/)
  assert.equal(role.textContent, "Process")
  tunnel.managed = false
  tunnel.lifecycle = "stopped"
  tunnel.readiness = "not_ready"
  tunnel.actions = []
  await system.refresh()
  assert.equal(outline.getAttribute("data-boundary-kind"), "process", "stopped/unmanaged tunnels remain processes")
  tunnel.label = "Direct HTTPS / transport"
  tunnel.lifecycle = "unknown"
  await system.refresh()
  assert.equal(outline.getAttribute("data-boundary-kind"), "path")
  assert.equal(outline.classList.contains("map-process"), false)
  assert.ok(outline.classList.contains("map-path"))
  assert.equal(heading.getAttribute("data-boundary-kind"), "path")
  assert.equal(heading.classList.contains("map-process"), false)
  assert.match(heading.querySelector("[data-boundary-label]")?.textContent ?? "", /PATH · NOT A PROCESS/)
  assert.equal(heading.querySelector("[data-boundary-title]")?.textContent, "Direct HTTPS")
  assert.equal(role.textContent, "Path")
  assert.match(doc.querySelector("#map-boundary-tunnel-description")?.textContent ?? "", /no separate tunnel process/)
  doc.querySelector<HTMLButtonElement>('[data-component-detail="tunnel"]')!.click()
  assert.match(doc.querySelector("#node-inspector-meta")?.textContent ?? "", /BoundaryPATH · NOT A PROCESS · Direct HTTPS/)
  assert.doesNotMatch(doc.querySelector("#node-inspector-status")?.textContent ?? "", /Process:/)
  delete status.topology
  await system.refresh()
  assert.equal(outline.getAttribute("data-boundary-kind"), "transport")
  assert.equal(outline.classList.contains("map-path"), false)
  assert.match(heading.querySelector("[data-boundary-label]")?.textContent ?? "", /MODE UNKNOWN/)
  assert.equal(role.textContent, "Transport")
  system.destroy()
  await page.close()
})

test("controls show the component table separately from the read-only map and poll only the supervisor", async () => {
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
  assert.equal(doc.querySelectorAll("[data-node-id]").length, 17)
  assert.match(doc.querySelector('[data-node-id="storage"]')?.getAttribute("aria-label") ?? "", /Cache \/ saved responses \(Files\).*Highlight connections/)
  assert.equal(doc.querySelector("#service-controls"), null)
  assert.equal(doc.querySelector("#activity-console"), null)
  assert.equal(doc.querySelector("#auth-countdown"), null)
  assert.deepEqual([...new Set(page.fetchCalls.map((call) => call.url))], ["/api/system", "/api/system/setup"])
  assert.equal(doc.querySelectorAll("[data-component-id]").length, 12)
  assert.ok(doc.querySelector('[data-component-id="supervisor"]'))
  assert.ok(doc.querySelector('[data-component-id="dashboard"]'))
  assert.ok(doc.querySelector('[data-component-id="gate"]'), "gate lifecycle controls are present")
  const editor = doc.querySelector<HTMLElement>('[data-component-id="vscode"]')!
  assert.equal(editor.querySelector("[data-component-type]")?.textContent, "Applications")
  assert.equal(editor.querySelector("[data-component-status]")?.textContent, "Not observed")
  assert.equal(editor.querySelector("[data-component-lifecycle]")?.textContent, "Unmanaged")
  assert.equal(editor.querySelector("[data-component-actions]")?.textContent, "Open not configured")
  assert.equal(editor.querySelectorAll("[data-component-action]").length, 0, "the user-launched editor has no start, restart or stop controls")
  doc.querySelector<HTMLButtonElement>("#system-architecture-tab")!.click()
  assert.equal(doc.querySelector<HTMLElement>("#system-controls-view")!.hidden, true)
  assert.equal(doc.querySelector<HTMLElement>("#system-architecture-view")!.hidden, false)
  doc.querySelector<HTMLButtonElement>('[data-node-id="plugin"]')!.click()
  assert.equal(doc.querySelector<HTMLDialogElement>("#node-inspector")!.open, false)
  assert.ok(doc.querySelector('[data-edge-id="opencode_plugin"]')?.classList.contains("selected"))
  doc.querySelector<HTMLButtonElement>('[data-node-id="storage"]')!.click()
  assert.ok(doc.querySelector('[data-edge-id="relay_storage"]')?.classList.contains("selected"))
  assert.equal(doc.querySelector("#system-architecture-view [data-component-action]"), null)
  system.destroy()
  await page.close()
})

test("architecture roles stay independent of live health, which remains available in control details", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  page.setFetch((url) => url === "/api/system" ? json(status) : json(setupStatus()))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.match(doc.querySelector(".topology-legend")?.textContent ?? "", /Model request flow.*Checks \/ recovery \/ management/)
  const edge = (id: string) => doc.querySelector(`[data-edge-id="${id}"]`)
  assert.ok(edge("vscode_gate")?.classList.contains("request"))
  assert.ok(edge("gate_opencode")?.classList.contains("request"))
  assert.ok(edge("desktop_opencode")?.classList.contains("request"))
  assert.ok(edge("opencode_plugin")?.classList.contains("request"))
  assert.ok(edge("relay_storage")?.classList.contains("control"), "storage ownership is not model request flow")
  assert.ok(edge("relay_provider")?.classList.contains("request"))
  assert.ok(edge("gate_gateway")?.classList.contains("control"))
  assert.ok(edge("supervisor_gate")?.classList.contains("control"))
  assert.ok(edge("tunnel_network")?.classList.contains("control"))
  assert.ok(edge("remote_relay")?.classList.contains("control"))
  assert.ok(edge("dashboard_ui_dashboard")?.classList.contains("control"), "dashboard traffic is not model traffic")
  assert.ok(edge("dashboard_supervisor"), "management connections are visible by default")
  assert.ok(edge("dashboard_supervisor")?.classList.contains("control"))
  for (const id of ["dashboard_gateway", "dashboard_opencode"]) {
    assert.ok(edge(id)?.classList.contains("control"), `${id}: diagnostics are not model requests`)
    assert.match(edge(id)?.querySelector("title")?.textContent ?? "", /Read-only diagnostics/)
    assert.equal(edge(`${id}_response`), null, "diagnostic results are not model response lanes")
  }
  assert.match(edge("dashboard_opencode")?.querySelector("title")?.textContent ?? "", /Optional read-only/)
  assert.match(edge("relay_storage")?.querySelector("title")?.textContent ?? "", /Storage ownership \/ read-write access.*request cache.*response mailbox/)
  assert.match(edge("tunnel_network")?.querySelector("title")?.textContent ?? "", /Dependency \/ readiness check · tunnel → network/)
  assert.ok(edge("supervisor_gateway")?.classList.contains("control"))
  assert.match(edge("gateway_tunnel")?.querySelector("title")?.textContent ?? "", /Model request flow/)
  assert.doesNotMatch(edge("gateway_tunnel")?.querySelector("title")?.textContent ?? "", /unknown|ready|blocked/)
  const original = edge("gateway_tunnel")
  status.topology!.edges.find((item) => item.id === "gateway_tunnel")!.state = "blocked"
  await system.refresh()
  assert.ok(edge("gateway_tunnel")?.classList.contains("request"), "a blocked request link retains its flow color")
  assert.equal(edge("gateway_tunnel"), original, "live state changes do not rebuild structural architecture arrows")
  assert.equal(edge("gateway_tunnel")?.classList.contains("blocked"), false)
  doc.querySelector<HTMLButtonElement>('[data-component-detail="gateway"]')!.click()
  assert.match(doc.querySelector("#node-connections")?.textContent ?? "", /Blocked/, "operational connection health is shown in card diagnostics")
  system.destroy()
  await page.close()
})

test("a healthy gate keeps local sessions available during a relay outage while relay readiness is not ready", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  const gate = status.topology!.nodes.find((node) => node.id === "gate")!
  gate.lifecycle = "running"
  gate.readiness = "ready"
  gate.detail = "Listener and local backend ready. Relay unavailable: gateway_down. Attached frontends can open sessions; while the local gateway is running, prompts wait for relay recovery within its retry window. The gate is not restarted."
  status.topology!.edges.find((edge) => edge.id === "gate_opencode")!.state = "ready"
  status.topology!.edges.find((edge) => edge.id === "gate_gateway")!.state = "not_ready"
  page.setFetch(() => json(status))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  const card = doc.querySelector<HTMLElement>('[data-component-id="gate"]')!
  assert.equal(card.querySelector("[data-component-status]")?.textContent, "Ready")
  assert.equal(card.querySelector("[data-component-lifecycle]")?.textContent, "Running")
  doc.querySelector<HTMLButtonElement>('[data-component-detail="gate"]')!.click()
  assert.match(doc.querySelector("#node-inspector-detail")?.textContent ?? "", /Relay unavailable: gateway_down/)
  assert.match(doc.querySelector("#node-connections")?.textContent ?? "", /Frontend health gate → OpenCode server.*Ready/s)
  assert.match(doc.querySelector("#node-connections")?.textContent ?? "", /Frontend health gate → Local gateway.*Not ready/s)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false, "relay failure never triggers a gate action")
  system.destroy()
  await page.close()
})

test("controls show current recovery status without history and keep shutdown safeguards", async () => {
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
  const tunnel = doc.querySelector('[data-component-id="tunnel"] [data-component-status]')!
  assert.equal(tunnel.classList.contains("working"), true)
  assert.match(tunnel.textContent ?? "", /recover…/)
  assert.match(doc.querySelector("#recovery-status")?.textContent ?? "", /Encrypted tunnel: recover/)
  assert.equal(doc.querySelector("#recovery-progress, #recovery-steps"), null)
  assert.equal(doc.querySelector<HTMLInputElement>("#auto-reconnect")!.disabled, true)
  const shutdown = doc.querySelector<HTMLButtonElement>("#stop-system")!
  assert.equal(shutdown.disabled, false, "shutdown must remain available to stop an active recovery")
  page.setConfirm((message) => {
    assert.match(message ?? "", /Cancel active recovery.*disable automatic reconnect and wake/i)
    return true
  })
  shutdown.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const firstAction = (action ?? {}) as Record<string, unknown>
  assert.equal(firstAction.component, "all")
  assert.equal(firstAction.action, "stop")
  assert.match(String(firstAction.request_id), /^[a-f0-9]{32}$/)
  run.status = "completed"
  run.steps[0]!.status = "completed"
  status.topology!.nodes.find((node) => node.id === "tunnel")!.activity = "idle"
  await system.refresh()
  assert.equal(tunnel.classList.contains("working"), false)
  const readyShutdown = doc.querySelector<HTMLButtonElement>("#stop-system")!
  assert.equal(readyShutdown.disabled, false)
  page.setConfirm((message) => {
    assert.match(message ?? "", /dashboard and supervisor stay running.*computer stays on/i)
    return true
  })
  shutdown.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const finalAction = (action ?? {}) as Record<string, unknown>
  assert.match(String(finalAction.request_id), /^[a-f0-9]{32}$/)
  delete finalAction.request_id
  assert.deepEqual(finalAction, { component: "all", action: "stop", confirmed: true })
  assert.equal(doc.querySelector("#service-controls"), null)
  assert.equal(doc.querySelector("#activity-console"), null)
  system.destroy()
  await page.close()
})

test("recovery settings are directly visible in Settings and card details retain structured connections", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  page.setFetch(() => json(status))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#recovery-progress, #recovery-steps, .recovery-options"), null)
  doc.querySelector<HTMLButtonElement>("#system-settings-tab")!.click()
  const settings = doc.querySelector<HTMLElement>("#system-settings-view")!
  assert.equal(settings.hidden, false)
  assert.ok(settings.querySelector("#auto-reconnect"))
  assert.ok(settings.querySelector("#auto-wake"))
  assert.equal(settings.querySelector("details, summary"), null)
  assert.equal(doc.querySelector("#system-controls-view #auto-reconnect"), null)
  assert.match(doc.querySelector("#auto-reconnect-description")?.textContent ?? "", /background/)
  assert.match(doc.querySelector(".setting-warning")?.textContent ?? "", /compute charges/)
  await system.refresh()
  assert.equal(settings.hidden, false, "polling preserves the selected tab")
  doc.querySelector<HTMLButtonElement>("#system-controls-tab")!.click()
  doc.querySelector<HTMLButtonElement>('[data-component-detail="remote"]')!.click()
  const connections = doc.querySelector("#node-connections")!
  assert.equal(connections.querySelector("h4")?.textContent, "Connections")
  const related = status.topology!.edges.filter((edge) => edge.source === "remote" || edge.target === "remote")
  assert.ok(related.length > 0)
  assert.equal(connections.querySelectorAll(".connection-list > .connection-card").length, related.length)
  assert.ok(connections.querySelector(".connection-heading strong")?.textContent?.includes("→"))
  assert.ok(connections.querySelector(".status-pill")?.textContent)
  assert.ok(connections.querySelector(".connection-protocol")?.textContent)
  status.topology!.edges = []
  await system.refresh()
  assert.equal(connections.textContent, "", "no orphan heading when there are no connections")
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
  assert.match(page.document.querySelector("#recovery-status")?.textContent ?? "", /Automatic recovery is off.*Start \/ recover system/)
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
  const button = page.document.querySelector<HTMLButtonElement>('[data-component-id="remote"] [data-component-action="wake"]')!
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
  assert.equal(page.document.querySelector<HTMLButtonElement>('[data-component-id="remote"] [data-component-action="wake"]')!.disabled, true)

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
  const button = page.document.querySelector<HTMLButtonElement>('[data-component-id="desktop"] [data-component-action="start"]')!
  assert.equal(button.disabled, false)
  button.click()
  button.click()
  assert.equal(actions.length, 1)
  const action = actions[0] as Record<string, unknown>
  assert.match(String(action.request_id), /^[a-f0-9]{32}$/)
  delete action.request_id
  assert.deepEqual(action, { component: "desktop", action: "start", confirmed: false })
  assert.deepEqual(actionHeaders[0], { "Content-Type": "application/json", "X-DeltaRelay-Control": status.csrf_token })
  assert.equal(page.document.querySelector<HTMLButtonElement>('[data-component-id="desktop"] [data-component-action="start"]')!.disabled, true)
  release(json({ accepted: true }, 202))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(page.document.querySelector("#activity-console"), null)
  system.destroy()
  await page.close()
})

test("Varro in VS Code opens only from its card with one protected request and no service action", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  status.topology!.nodes.find((node) => node.id === "vscode")!.actions = ["open"]
  status.topology!.intent.system = "stopped"
  const actions: Record<string, unknown>[] = []
  let release: (response: Response) => void = () => undefined
  const held = new Promise<Response>((resolve) => { release = resolve })
  page.setFetch((url, init) => {
    if (url === "/api/system") return json(status)
    if (url === "/api/system/action") {
      actions.push(JSON.parse(String(init.body)))
      return held
    }
    throw new Error(`Unexpected URL ${url}`)
  })
  page.setConfirm(() => { throw new Error("opening the editor must not ask for confirmation") })
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  const button = doc.querySelector<HTMLButtonElement>('[data-component-id="vscode"] [data-component-action="open"]')!
  assert.equal(button.textContent, "Open")
  assert.equal(button.disabled, false, "an intentionally stopped stack does not block opening the editor")
  button.click()
  button.click()
  assert.equal(actions.length, 1, "a second click while the request is pending is ignored")
  const action = actions[0]!
  assert.match(String(action.request_id), /^[a-f0-9]{32}$/)
  delete action.request_id
  assert.deepEqual(action, { component: "vscode", action: "open", confirmed: false })
  assert.equal(doc.querySelector<HTMLButtonElement>('[data-component-id="vscode"] [data-component-action="open"]')!.disabled, true)
  release(json({ accepted: true }, 202))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(doc.querySelector("#control-notice")?.textContent ?? "", /Open request sent\. The supervisor does not observe the editor window/)
  assert.equal(page.fetchCalls.filter((call) => call.url === "/api/system/action").length, 1)
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
  assert.ok([...doc.querySelectorAll<HTMLButtonElement>("[data-component-action]")].every((button) => button.disabled))
  status = systemStatus()
  page.setFetch(() => json(status))
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, false)
  page.setFetch(() => { throw new Error("offline") })
  await system.refresh()
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")?.disabled, true)
  assert.ok([...doc.querySelectorAll<HTMLButtonElement>("[data-component-action]")].every((button) => button.disabled))
  assert.match(doc.querySelector("#connection-label")?.textContent ?? "", /Disconnected/)
  system.destroy()
  await page.close()
})

test("intentional system stop blocks card recovery but keeps supported remote shutdown available", async () => {
  const page = openPage("controls")
  const status = systemStatus()
  status.topology!.intent.system = "stopped"
  page.setFetch(() => json(status))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")!.disabled, false)
  assert.equal(doc.querySelector<HTMLButtonElement>("#stop-remote")!.disabled, false)
  assert.equal(doc.querySelector<HTMLButtonElement>('[data-component-id="gateway"] [data-component-action="recover"]')!.disabled, true)
  assert.equal(doc.querySelector<HTMLInputElement>("#auto-reconnect")!.disabled, true)
  app.destroy()
  await page.close()
})

test("shutdown in progress disables conflicting actions and reports unconfirmed compute billing", async () => {
  const page = openPage("controls")
  let status = systemStatus({
    settings: { auto_reconnect: false, auto_wake: false },
    remote: { id: "codespaces", label: "GitHub Codespaces", host_state: "stopping", capabilities: ["host.wake", "host.stop"] },
    recovery: { busy: true, phase: "stopping_remote_host", attempts: 0, last_error: "", last_connected_at: null, next_retry_at: null },
  })
  status.topology!.intent = { system: "stopped", remote: "stopped" }
  page.setFetch(() => json(status))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  assert.match(doc.querySelector("#recovery-status")?.textContent ?? "", /Shutdown in progress.*Compute charges may continue until confirmation/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")!.disabled, true)
  assert.equal(doc.querySelector<HTMLButtonElement>("#stop-system")!.disabled, true)
  assert.equal(doc.querySelector<HTMLButtonElement>("#stop-remote")?.disabled ?? true, true)
  status = {
    ...status,
    remote: { ...status.remote, host_state: "stopped" },
    recovery: { ...status.recovery, busy: false, phase: "system_stopped" },
  }
  await app.refresh()
  assert.match(doc.querySelector("#recovery-status")?.textContent ?? "", /Remote shutdown confirmed by GitHub Codespaces.*Storage charges may continue/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")!.disabled, false)
  assert.equal(doc.querySelector<HTMLInputElement>("#auto-reconnect")!.disabled, true)
  app.destroy()
  await page.close()
})

test("a remote-only stop leaves Start system available and settings paused until explicit resume", async () => {
  const page = openPage("controls")
  const status = systemStatus({
    relay_state: "unreachable",
    settings: { auto_reconnect: false, auto_wake: false },
    remote: { id: "codespaces", label: "GitHub Codespaces", host_state: "stopped", capabilities: ["host.wake", "host.stop"] },
  })
  status.topology!.intent = { system: "running", remote: "stopped" }
  page.setFetch(() => json(status))
  const app = startSystemStatus(page.document, { autoStart: false })
  await app.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Remote host stopped")
  assert.match(doc.querySelector("#recovery-status")?.textContent ?? "", /Remote shutdown confirmed/)
  assert.equal(doc.querySelector<HTMLButtonElement>("#start-system")!.disabled, false)
  assert.equal(doc.querySelector<HTMLInputElement>("#auto-reconnect")!.disabled, true)
  assert.equal(doc.querySelector<HTMLInputElement>("#auto-wake")!.disabled, true)
  assert.ok([...doc.querySelectorAll<HTMLButtonElement>('[data-component-id="tunnel"] [data-component-action]')].every((button) => button.disabled),
    "a remote-only stop must not offer transport actions that could wake compute")
  app.destroy()
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
  assert.equal(page.document.querySelector<HTMLSelectElement>("#setup-provider")?.value, "ssh")
  assert.match(page.document.querySelector("#setup-provider-requirements")?.textContent ?? "", /No GitHub account or CLI is required/)
  page.setConfirm(() => false)
  page.fire(form, "submit")
  assert.equal(installs.length, 0)
  page.setConfirm((message) => {
    assert.match(message ?? "", /user@my-host/)
    assert.doesNotMatch(message ?? "", /Codespace|GitHub|compute charges/)
    return true
  })
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

test("setup requirements and billing warnings follow the selected provider", async () => {
  const page = openPage("controls")
  page.setFetch((url) => json(url === "/api/system" ? systemStatus() : setupStatus({ available: true, required: true })))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  const provider = doc.querySelector<HTMLSelectElement>("#setup-provider")!
  const form = doc.querySelector<HTMLFormElement>("#remote-setup-form")!
  doc.querySelector<HTMLInputElement>("#setup-target")!.value = "existing-codespace"
  provider.value = "codespaces"
  page.fire(provider, "change")
  assert.equal(doc.querySelector("#setup-target-label")?.textContent, "Existing Codespace name")
  assert.equal(doc.querySelector<HTMLElement>("#setup-ssh-port-label")?.hidden, true)
  assert.match(doc.querySelector("#setup-provider-requirements")?.textContent ?? "", /authenticated GitHub CLI.*billing/)
  let confirmations = 0
  page.setConfirm((message) => {
    confirmations++
    assert.match(message ?? "", /stopped Codespace.*compute charges/)
    return false
  })
  page.fire(form, "submit")
  assert.equal(confirmations, 1)
  provider.value = "ssh"
  page.fire(provider, "change")
  assert.equal(doc.querySelector("#setup-target-label")?.textContent, "SSH alias or user@host")
  assert.equal(doc.querySelector<HTMLElement>("#setup-ssh-port-label")?.hidden, false)
  assert.doesNotMatch(doc.querySelector("#setup-provider-requirements")?.textContent ?? "", /Codespaces|billing/)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
  system.destroy()
  await page.close()
})

test("SSH dashboard uses configured host capabilities without assuming cloud power management", async () => {
  const page = openPage("controls")
  const status = systemStatus({ remote: { id: "ssh", label: "SSH remote host", host_state: "unknown", capabilities: ["relay.ensure", "relay.restart"] } })
  page.setFetch((url) => json(url === "/api/system" ? status : setupStatus()))
  const system = startSystemStatus(page.document, { autoStart: false })
  await system.refresh()
  const doc = page.document
  assert.equal(doc.querySelector("#control-connection")?.textContent, "Relay connected")
  assert.equal(doc.querySelector("#stop-remote"), null)
  assert.equal(doc.querySelector<HTMLElement>("#auto-wake-setting")?.hidden, true)
  doc.querySelector<HTMLButtonElement>('[data-component-detail="remote"]')!.click()
  assert.equal(doc.querySelector("#node-inspector-title")?.textContent, "SSH remote host")
  assert.equal(doc.querySelector("[data-component-action=\"wake\"]"), null)
  assert.equal(doc.querySelector("[data-component-id=\"remote\"] [data-component-action=\"stop\"]"), null)
  assert.doesNotMatch(doc.querySelector("#shutdown-detail")?.textContent ?? "", /VPS|billing|Codespace/)
  let confirmations = 0
  page.setConfirm((message) => {
    confirmations++
    assert.doesNotMatch(message ?? "", /VPS|Codespace|billing|may be woken/)
    assert.match(message ?? "", /does not support waking/)
    return false
  })
  doc.querySelector<HTMLButtonElement>("#start-system")!.click()
  assert.equal(confirmations, 1)
  assert.equal(page.fetchCalls.some((call) => call.init.method === "POST"), false)
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
