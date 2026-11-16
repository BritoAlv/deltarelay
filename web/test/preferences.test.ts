import test from "node:test"
import assert from "node:assert/strict"
import { openPage, json } from "./browser.js"
import { preferencesStorageKey, readPreferences, readViewParams, replaceViewParams, savePreferences } from "../src/lib/preferences.js"
import { startDashboard } from "../src/scripts/dashboard.js"
import { startMeasurementPage } from "../src/scripts/measurement-page.js"
import { mountControls } from "../src/scripts/features/controls.js"
import { mountOverviewRange } from "../src/scripts/features/overview-range.js"
import { makeOpenCodeSessions, makeSnapshot } from "./fixture.js"

const now = Date.parse("2026-10-28T12:15:00Z")

test("preferences are allowlisted, bounded, scoped, and exclude transient and operational state", async () => {
  const page = openPage()
  try {
    replaceViewParams(page.document, "sessions", { q: "needle", rows: "25", page: "3", session: "private-id", csrf_token: "secret", auto_wake: "true" })
    assert.deepEqual(readPreferences(page.document, "sessions"), { q: "needle", rows: "25" })
    assert.deepEqual(readPreferences(page.document, "measurement"), {})
    assert.equal(new URL(page.window.location.href).searchParams.get("page"), "3", "transient state can still be deep-linked")
    savePreferences(page.document, "components", { q: "components" })
    savePreferences(page.document, "sessions", { q: null, rows: "8", sid: "x".repeat(2049) })
    assert.deepEqual(readPreferences(page.document, "sessions"), { rows: "8" })
    assert.equal(readPreferences(page.document, "components").q, "components")
    const saved = page.window.localStorage.getItem(preferencesStorageKey)!
    for (const secret of ["secret", "private-id", "auto_wake", "csrf_token"]) assert.ok(!saved.includes(secret))
  } finally { await page.close() }
})

test("bare visits restore preferences; explicit URLs replace whole view groups without mixing saved bounds", async () => {
  const page = openPage()
  try {
    savePreferences(page.document, "range", { range: "last", last: "18", unit: "minutes" })
    assert.equal(readViewParams(page.document, "range").get("last"), "18")
    page.window.history.replaceState(null, "", "/?range=last")
    assert.equal(readViewParams(page.document, "range").get("last"), null)
    savePreferences(page.document, "sessions", { q: "hidden", sort: "requests", dir: "asc" })
    savePreferences(page.document, "host", { host: "other-host" })
    page.window.history.replaceState(null, "", "/sessions?session=linked")
    assert.equal(readViewParams(page.document, "sessions").get("q"), null)
    assert.equal(readViewParams(page.document, "host").get("host"), null)
    page.window.history.replaceState(null, "", "/sessions?q=explicit")
    assert.equal(readViewParams(page.document, "sessions").get("q"), "explicit")
    assert.equal(readViewParams(page.document, "sessions").get("sort"), null)
  } finally { await page.close() }
})

test("malformed, obsolete, or denied storage never breaks the dashboard", async () => {
  const page = openPage()
  try {
    for (const raw of ["bad-json", "null", "[]", '"text"']) {
      page.window.localStorage.setItem(preferencesStorageKey, raw)
      assert.deepEqual(readPreferences(page.document, "range"), {})
    }
    page.window.localStorage.setItem(preferencesStorageKey, JSON.stringify({ range: { range: "24h", unit: 123, token: "secret" }, unknown: { q: "x" } }))
    assert.deepEqual(readPreferences(page.document, "range"), { range: "24h" })
    Object.defineProperty(page.window, "localStorage", { configurable: true, get() { throw new Error("denied") } })
    assert.deepEqual(readPreferences(page.document, "range"), {})
    assert.equal(savePreferences(page.document, "range", { range: "24h" }), false)
    assert.doesNotThrow(() => replaceViewParams(page.document, "range", { range: "7d" }))
    assert.equal(new URL(page.window.location.href).searchParams.get("range"), "7d")
  } finally { await page.close() }
})

test("quota errors are harmless and unchanged polling state does not rewrite storage", async () => {
  const page = openPage()
  try {
    let value: string | null = null
    let writes = 0
    Object.defineProperty(page.window, "localStorage", { configurable: true, value: {
      getItem: () => value,
      setItem: (_key: string, next: string) => { writes++; if (writes > 1) throw new Error("quota"); value = next },
    } })
    assert.equal(savePreferences(page.document, "traffic", { view: "trends" }), true)
    assert.equal(savePreferences(page.document, "traffic", { view: "trends" }), true)
    assert.equal(writes, 1)
    assert.equal(savePreferences(page.document, "traffic", { view: null }), false)
  } finally { await page.close() }
})

test("time range and chart mode survive a fresh visit and relative ranges advance with time", async () => {
  const first = openPage()
  first.setFetch(() => json(makeSnapshot(now)))
  const app = startDashboard(first.document, { autoStart: false })
  await app.refresh()
  const range = first.document.querySelector<HTMLSelectElement>("#chart-range")!
  range.value = "24h"
  first.fire(range, "change")
  first.document.querySelector<HTMLButtonElement>("#chart-view-trends")!.click()
  first.document.querySelector<HTMLButtonElement>("#pause-button")!.click()
  const saved = first.window.localStorage.getItem(preferencesStorageKey)!
  app.destroy()
  await first.close()

  const second = openPage()
  second.window.localStorage.setItem(preferencesStorageKey, saved)
  second.setFetch(() => json(makeSnapshot(now + 86_400_000)))
  const restored = startDashboard(second.document, { autoStart: false })
  try {
    await restored.refresh()
    assert.equal(second.document.querySelector<HTMLSelectElement>("#chart-range")!.value, "24h")
    assert.equal(second.document.querySelector("#chart-view-trends")!.getAttribute("aria-pressed"), "true")
    assert.equal(restored.paused, false)
    assert.match(second.document.querySelector("#overview-range-summary")!.textContent!, /Last 24 hours/)
    assert.deepEqual(readPreferences(second.document, "range"), { range: "24h" }, "store the relative preset, not resolved timestamps")
    const defaultRange = second.document.querySelector<HTMLSelectElement>("#chart-range")!
    defaultRange.value = "30d"
    second.fire(defaultRange, "change")
    assert.deepEqual(readPreferences(second.document, "range"), {}, "returning to the default clears the previous preference")
  } finally { restored.destroy(); await second.close() }
})

test("session controls restore on a bare visit without restoring pagination or record dialogs", async () => {
  const page = openPage("sessions")
  savePreferences(page.document, "sessions", { q: "project", state: "idle", sort: "requests", dir: "asc", rows: "25", req_min: "5" })
  page.setFetch(() => json(makeSnapshot(now)))
  const app = startDashboard(page.document, { autoStart: false })
  try {
    await app.refresh()
    assert.equal(page.document.querySelector<HTMLInputElement>("#session-search")!.value, "project")
    assert.equal(page.document.querySelector<HTMLSelectElement>("#session-page-size")!.value, "25")
    assert.equal(page.document.querySelector<HTMLSelectElement>("#session-sort")!.value, "requests")
    assert.equal(page.document.querySelector("#session-sort-direction")!.getAttribute("data-direction"), "asc")
    assert.equal(page.document.querySelector<HTMLDialogElement>("#session-dialog")!.open, false)
    assert.equal(new URL(page.window.location.href).searchParams.get("page"), null)
    assert.equal(new URL(page.window.location.href).searchParams.get("req_min"), "5")
  } finally { app.destroy(); await page.close() }
})

test("custom timestamp bounds restore exactly and invalid drafts do not replace the applied range", async () => {
  const page = openPage()
  const selection = { range: "datetime", start: "2026-10-27T13:15:00+02:00", end: "2026-10-28T10:15:00Z" }
  savePreferences(page.document, "range", selection)
  const range = mountOverviewRange(page.document.getElementById("overview-range")!, () => {})
  try {
    const resolved = range.render(makeSnapshot(now))
    assert.equal(resolved.start, Date.parse(selection.start))
    assert.equal(resolved.end, Date.parse(selection.end))
    const input = page.document.querySelector<HTMLInputElement>("#range-timestamp-start")!
    assert.equal(input.value, selection.start)
    input.value = "invalid timestamp"
    page.document.querySelector<HTMLButtonElement>("#range-timestamp-apply")!.click()
    assert.deepEqual(readPreferences(page.document, "range"), selection)
    assert.equal(range.render(makeSnapshot(now + 86_400_000)).start, resolved.start)
  } finally { range.destroy(); await page.close() }
})

test("invalid saved ranges recover to the default with matching controls", async () => {
  const page = openPage()
  savePreferences(page.document, "range", { range: "last", last: "-2", unit: "hours" })
  const range = mountOverviewRange(page.document.getElementById("overview-range")!, () => {})
  try {
    range.render(makeSnapshot(now))
    assert.equal(page.document.querySelector<HTMLSelectElement>("#chart-range")!.value, "30d")
    assert.deepEqual(readPreferences(page.document, "range"), {})
  } finally { range.destroy(); await page.close() }
})

test("host preferences are shared by Sessions and Measurement, but not Overview", async () => {
  const page = openPage("measurement")
  savePreferences(page.document, "host", { host: "beta" })
  page.setFetch((url) => json(url.includes("opencode") ? makeOpenCodeSessions(now) : makeSnapshot(now)))
  const app = startMeasurementPage(page.document, { autoStart: false })
  try {
    await app.refresh()
    assert.equal(page.document.querySelector<HTMLSelectElement>("#measurement-host-filter")!.value, "beta")
    assert.equal(new URL(page.window.location.href).searchParams.get("host"), "beta")
    assert.equal(readPreferences(page.document, "host").host, "beta")
  } finally { app.destroy(); await page.close() }
  const overview = openPage()
  savePreferences(overview.document, "host", { host: "beta" })
  overview.setFetch(() => json(makeSnapshot(now)))
  const dashboard = startDashboard(overview.document, { autoStart: false })
  try {
    await dashboard.refresh()
    assert.equal(new URL(overview.window.location.href).searchParams.get("host"), null)
    assert.equal(readPreferences(overview.document, "host").host, "beta")
  } finally { dashboard.destroy(); await overview.close() }
})

test("system health restores its provider tab and remembers subsequent tab changes", async () => {
  const page = openPage("system")
  savePreferences(page.document, "health", { provider: "openai" })
  page.setFetch(() => json(makeSnapshot(now)))
  const app = startDashboard(page.document, { autoStart: false })
  try {
    await app.refresh()
    assert.equal(page.document.querySelector('[data-provider-tab="openai"]')!.getAttribute("aria-selected"), "true")
    page.document.querySelector<HTMLButtonElement>('[data-provider-tab="opencode-go"]')!.click()
    assert.equal(readPreferences(page.document, "health").provider, "opencode-go")
  } finally { app.destroy(); await page.close() }
})

test("measurement and components have independent saved search and sort preferences", async () => {
  const page = openPage("measurement")
  savePreferences(page.document, "measurement", { q: "measure query", show: "measured", sort: "session", dir: "asc" })
  savePreferences(page.document, "components", { q: "gateway", sort: "component", dir: "desc" })
  const app = startMeasurementPage(page.document, { autoStart: false })
  try {
    assert.equal(page.document.querySelector<HTMLInputElement>("#measurement-session-search")!.value, "measure query")
    assert.equal(page.document.querySelector<HTMLSelectElement>("#measurement-session-availability")!.value, "measured")
    assert.equal(page.document.querySelector<HTMLSelectElement>("#measurement-session-sort")!.value, "session")
    assert.equal(readPreferences(page.document, "components").q, "gateway")
  } finally { app.destroy(); await page.close() }
})

test("system tabs, map channels, and component filters restore without executing controls", async () => {
  const page = openPage("controls")
  savePreferences(page.document, "controls", { tab: "1", hidden: "request,control,unknown" })
  savePreferences(page.document, "components", { q: "gateway", sort: "component", dir: "desc", location: "Local" })
  const controls = mountControls({ root: page.document.getElementById("controls")!, onRefresh() {} })
  try {
    assert.equal(page.document.querySelector("#system-architecture-tab")!.getAttribute("aria-selected"), "true")
    assert.equal(page.document.querySelector('[data-map-channel="request"]')!.getAttribute("aria-pressed"), "false")
    assert.equal(page.document.querySelector('[data-map-channel="response"]')!.getAttribute("aria-pressed"), "true")
    assert.equal(page.document.querySelector<HTMLInputElement>("#component-filter")!.value, "gateway")
    assert.equal(page.document.querySelector<HTMLSelectElement>("#component-sort")!.value, "component")
    page.document.querySelector<HTMLButtonElement>('[data-map-channel="request"]')!.click()
    assert.equal(readPreferences(page.document, "controls").hidden, "control")
    page.document.querySelector<HTMLButtonElement>("#system-settings-tab")!.click()
    assert.equal(readPreferences(page.document, "controls").tab, "2")
    assert.equal(page.fetchCalls.length, 0)
  } finally { controls.destroy(); await page.close() }
})
