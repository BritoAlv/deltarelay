import test from "node:test"
import assert from "node:assert/strict"
import { openPage, json } from "./browser.js"
import { makeSnapshot, makeSystemHistory } from "./fixture.js"
import { startDashboard } from "../src/scripts/dashboard.js"
import { startMeasurementPage } from "../src/scripts/measurement-page.js"
import { mountTraffic } from "../src/scripts/features/traffic.js"
import { mountSystemStates } from "../src/scripts/features/system-states.js"
import { overviewData } from "../src/lib/overview.js"
import { isSnapshot } from "../src/lib/api.js"
import { dateTimeRange, formatDateTime, formatDate, formatTime, presetRange } from "../src/lib/traffic.js"
import type { DashboardViewState } from "../src/lib/state.js"

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("timed out waiting for page")
}

test("unchanged chart data preserves DOM; view, data and size changes redraw it", async () => {
  const page = openPage()
  const snapshot = makeSnapshot()
  const state: DashboardViewState = { snapshot, stale: false, paused: false, busy: false, error: "", system: null, host: "" }
  const root = page.document.getElementById("traffic-panel")!
  const feature = mountTraffic(root)
  try {
    const overview = overviewData(snapshot, presetRange("30d", Date.parse(snapshot.collected_at)))
    feature.render(state, overview)
    const chart = page.document.getElementById("traffic-chart")!
    const svg = chart.firstElementChild
    assert.ok(svg)
    feature.render({ ...state, busy: true }, structuredClone(overview))
    feature.render({ ...state, paused: true }, structuredClone(overview))
    assert.equal(chart.firstElementChild, svg, "status updates must not replace chart nodes")
    page.document.getElementById("chart-view-trends")!.click()
    assert.notEqual(chart.firstElementChild, svg, "view changes must redraw")
    const trends = chart.firstElementChild
    const changed = structuredClone(overview)
    changed.traffic.points[0]!.body++
    feature.render(state, changed)
    assert.notEqual(chart.firstElementChild, trends, "changed data must redraw")
    const beforeResize = chart.firstElementChild
    Object.defineProperty(chart, "clientWidth", { configurable: true, value: 1200 })
    feature.render(state, changed)
    assert.notEqual(chart.firstElementChild, beforeResize, "size changes must redraw")
  } finally {
    feature.destroy()
    await page.close()
  }
})

test("unchanged supervisor observations preserve timeline and ring nodes", async () => {
  const page = openPage()
  const now = Date.now()
  const range = presetRange("30d", now)
  let historyState = "connected"
  page.setFetch((input) => {
    const params = new URL(input, "http://localhost").searchParams
    const history = makeSystemHistory(Number(params.get("start")), Number(params.get("end")), Number(params.get("bucket")), historyState)
    history.generated_at = new Date(now + page.fetchCalls.length * 1000).toISOString()
    return json(history)
  })
  const root = page.document.getElementById("system-states")!
  const feature = mountSystemStates(root)
  try {
    feature.render(range, false)
    await until(() => root.querySelector(".state-lane-segment") !== null)
    const segment = root.querySelector(".state-lane-segment")
    const ring = root.querySelector(".state-ring-segment")
    for (let i = 0; i < 5; i++) feature.render({ ...range }, false)
    assert.equal(root.querySelector(".state-lane-segment"), segment)
    assert.equal(root.querySelector(".state-ring-segment"), ring)
    feature.refresh()
    await until(() => page.fetchCalls.length === 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(root.querySelector(".state-lane-segment"), segment, "identical responses must not rebuild timeline nodes")
    assert.equal(root.querySelector(".state-ring-segment"), ring, "freshness metadata alone must not rebuild the ring")
    historyState = "off"
    feature.refresh()
    await until(() => root.querySelector(".state-lane-segment.state-off") !== null)
    assert.notEqual(root.querySelector(".state-lane-segment"), segment)
    assert.notEqual(root.querySelector(".state-ring-segment"), ring)
  } finally {
    feature.destroy()
    await page.close()
  }
})

test("overview renders a compact range summary without needing request history", async () => {
  const page = openPage()
  page.setFetch((input) => {
    const url = new URL(input, "http://localhost")
    if (url.pathname === "/api/system/history") {
      return json(makeSystemHistory(Number(url.searchParams.get("start")), Number(url.searchParams.get("end")), Number(url.searchParams.get("bucket"))))
    }
    assert.equal(url.pathname, "/api/dashboard")
    assert.equal(url.searchParams.get("compact"), "1")
    const start = Number(url.searchParams.get("start"))
    const end = Number(url.searchParams.get("end"))
    const snapshot = makeSnapshot()
    snapshot.requests_paged = true
    snapshot.history.recent_requests = []
    snapshot.history.traffic.hourly.buckets = []
    snapshot.history.traffic.daily.buckets = []
    snapshot.overview = {
      start, end, bucket_ms: Number(url.searchParams.get("bucket")), host: "",
      points: [{ at: start, end, requests: 123, failed: 0, cancelled: 0, body: 1000, encoded: 100, reused: 800, uploadedChunkBytes: 200, response: 0, duration: 0 }],
      sessions: 17, active_sessions: 1, running: 1, source: "requests", coverage_start: start, incomplete: false, incomplete_sessions: false,
    }
    assert.ok(isSnapshot(snapshot))
    return json(snapshot)
  })
  const app = startDashboard(page.document, { autoStart: false })
  try {
    await app.refresh()
    const stats = page.document.getElementById("stats-grid")!
    assert.match(stats.textContent!, /124/, "model requests includes the running request")
    assert.match(stats.textContent!, /17/)
    const svg = page.document.querySelector("#traffic-chart svg")
    assert.ok(svg)
    app.render()
    assert.equal(page.document.querySelector("#traffic-chart svg"), svg)
    assert.equal(page.fetchCalls.some((call) => call.url.startsWith("/api/dashboard/requests")), false)
  } finally {
    app.destroy()
    await page.close()
  }
})

for (const name of ["sessions", "measurement"] as const) {
  test(`${name} pages through requests without loading all history or claiming pagination is data loss`, async () => {
    const page = openPage(name)
    const snapshot = makeSnapshot()
    const retained = snapshot.history.recent_requests
    snapshot.requests_paged = true
    snapshot.history.recent_requests = []
    snapshot.history.traffic.hourly.buckets = []
    snapshot.history.traffic.daily.buckets = []
    page.setFetch((input) => {
      const url = new URL(input, "http://localhost")
      if (url.pathname === "/api/dashboard") {
        assert.equal(url.searchParams.get("compact"), "1")
        return json(snapshot)
      }
      if (url.pathname === "/api/opencode/sessions") return json({ version: 1, checked_at: snapshot.collected_at, sessions: [], truncated: false, stale: false })
      assert.equal(url.pathname, "/api/dashboard/requests")
      const matching = retained.filter((request) => request.session_id === url.searchParams.get("session")).sort((a, b) => b.sequence - a.sequence)
      const before = Number(url.searchParams.get("before"))
      const remaining = matching.filter((request) => !before || request.sequence < before)
      const requests = remaining.slice(0, Number(url.searchParams.get("limit")))
      return json({ requests, total: matching.length, next_before: remaining.length > requests.length ? requests.at(-1)!.sequence : 0 })
    })
    const app = name === "sessions"
      ? startDashboard(page.document, { autoStart: false })
      : startMeasurementPage(page.document, { autoStart: false })
    try {
      await app.refresh()
      if (name === "sessions") page.document.querySelector<HTMLButtonElement>("button[data-session-id]")!.click()
      const selector = name === "sessions" ? ".request-entry" : "details[data-request-id]"
      await until(() => page.document.querySelectorAll(selector).length === 8)
      const firstPage = page.document.querySelector(selector)!.textContent
      const older = page.document.querySelector<HTMLButtonElement>('[data-request-page="older"]')!
      assert.equal(older.disabled, false)
      older.click()
      await until(() => page.document.querySelectorAll(selector).length > 0 && page.document.querySelectorAll(selector).length < 8)
      assert.notEqual(page.document.querySelector(selector)!.textContent, firstPage)
      assert.equal(page.document.querySelector<HTMLButtonElement>('[data-request-page="older"]')!.disabled, true)
      assert.doesNotMatch(page.document.getElementById(name === "sessions" ? "session-detail" : "measurement-trace")!.textContent!, /no longer retained/)
      page.document.querySelector<HTMLButtonElement>('[data-request-page="newer"]')!.click()
      await until(() => page.document.querySelectorAll(selector).length === 8)
      assert.equal(page.document.querySelector(selector)!.textContent, firstPage)
    } finally {
      app.destroy()
      await page.close()
    }
  })
}

test("cached date formatters preserve existing timestamp and chart labels", () => {
  for (const value of [Date.parse("2026-11-01T12:34:56Z"), Date.parse("2026-11-01T12:34:56.789Z")]) {
    const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short", ...(value % 1000 ? { fractionalSecondDigits: 3 as const } : {}) }
    assert.equal(formatDateTime(value), new Date(value).toLocaleString(undefined, options))
    assert.equal(formatDate(value), new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }))
    assert.equal(formatTime(value, true), new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }))
  }
  assert.ok(dateTimeRange("2026-11-01T12:00:00Z", "2026-11-01T13:00:00Z", Date.now()).range)
})
