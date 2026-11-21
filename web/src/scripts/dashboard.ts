import { fetchSnapshot } from "../lib/api.js"
import { historyHosts, relativeTime, trackedSessionCount } from "../lib/metrics.js"
import { overviewData } from "../lib/overview.js"
import { createPoller } from "../lib/polling.js"
import { observationConnection, systemObservations, type DashboardViewState } from "../lib/state.js"
import { replaceParams, syncHostLinks } from "../lib/url-state.js"
import { readViewParams, replaceViewParams } from "../lib/preferences.js"
import { requiredById } from "./dom.js"
import { mountHeader, type HeaderView } from "./features/header.js"
import { mountHealth } from "./features/health.js"
import { mountOverviewRange } from "./features/overview-range.js"
import { mountSessions } from "./features/sessions.js"
import { mountStats } from "./features/stats.js"
import { mountSystemStates } from "./features/system-states.js"
import { mountTraffic } from "./features/traffic.js"
import { mountOverviewUsage } from "./features/overview-usage.js"

export interface DashboardOptions {
  autoStart?: boolean
  refreshNote?: string
  waitingLabel?: string
  /** Called after the local dashboard poller pauses or resumes. */
  onPauseChange?: (paused: boolean) => void
}

export interface DashboardApp {
  refresh(): Promise<void>
  render(): void
  destroy(): void
  readonly paused: boolean
}

// Composes the gateway-backed feature that exists on the current page. Overview,
// sessions, and system health each load only their own section, so one page's
// poller and pause state never include another page's markup.
export function startDashboard(doc: Document = document, options: DashboardOptions = {}): DashboardApp {
  const {
    autoStart = true,
    refreshNote = "Auto-refresh every 10s",
    waitingLabel = "Loading local gateway…",
    onPauseChange,
  } = options
  const view = doc.defaultView ?? globalThis
  const statsRoot = doc.getElementById("stats-grid")
  const trafficRoot = doc.getElementById("traffic-panel")
  const statesRoot = doc.getElementById("system-states")
  const sessionsRoot = doc.getElementById("sessions")
  const healthRoot = doc.getElementById("system")
  if (!statsRoot && !trafficRoot && !statesRoot && !sessionsRoot && !healthRoot) {
    throw new Error("Dashboard page has no overview, traffic, system states, sessions, or system section")
  }
  const dialog = sessionsRoot ? requiredById<HTMLDialogElement>(doc, "session-dialog") : null
  const navCount = doc.getElementById("nav-session-count")
  const hostScoped = doc.getElementById("host-filter") !== null
  const initialHost = hostScoped ? readViewParams(doc, "host").get("host") ?? "" : ""
  if (!hostScoped) replaceParams(doc, { host: null })

  let state: DashboardViewState = { snapshot: null, stale: false, paused: false, busy: false, error: "", system: null, host: initialHost }
  let generation = 0
  let destroyed = false
  let rangeClock: number | undefined
  let refreshPending = false
  let refreshTask: Promise<void> | null = null
  const systemStates = statesRoot ? mountSystemStates(statesRoot) : null

  function setHost(host: string): void {
    if (!hostScoped) return
    const hosts = historyHosts(state.snapshot)
    state = { ...state, host: hosts.includes(host) ? host : "" }
    replaceViewParams(doc, "host", { host: state.host || null })
    syncHostLinks(doc, state.host)
    render()
    requestRefresh()
  }

  const header = mountHeader({
    doc,
    refreshNote,
    onRefresh: () => { systemStates?.refresh(); void refresh() },
    onPauseToggle: () => togglePause(),
    onHostChange: setHost,
  })
  const stats = statsRoot ? mountStats(statsRoot) : null
  const traffic = trafficRoot ? mountTraffic(trafficRoot) : null
  const rangeRoot = sessionsRoot ? null : doc.getElementById("overview-range")
  const range = rangeRoot ? mountOverviewRange(rangeRoot, () => { render(); requestRefresh() }) : null
  const overviewUsageRoot = doc.getElementById("overview-model-usage")
  const overviewUsage = overviewUsageRoot ? mountOverviewUsage(overviewUsageRoot) : null
  const sessions = sessionsRoot && dialog ? mountSessions(sessionsRoot, dialog, { onHostChange: setHost }) : null
  const health = healthRoot ? mountHealth(healthRoot) : null
  const unsubscribe = systemObservations.subscribe((system) => {
    state = { ...state, system }
    render()
  })

  const poller = createPoller({ intervalMs: 10_000, run: refresh, document: doc, onPaused: render })

  function headerView(): HeaderView {
    const { snapshot, stale, paused, busy, host } = state
    return {
      label: stale ? "Disconnected" : snapshot ? paused ? "Paused" : "Live" : "Connecting…",
      updatedAt: snapshot ? `Updated ${relativeTime(snapshot.collected_at)}` : waitingLabel,
      paused,
      stale,
      busy,
      host,
      hosts: historyHosts(snapshot),
      notice: dashboardNotice(state),
    }
  }

  function render() {
    if (destroyed) return
    if (hostScoped && state.snapshot && state.host && !historyHosts(state.snapshot).includes(state.host)) {
      state = { ...state, host: "" }
      replaceViewParams(doc, "host", { host: null })
      syncHostLinks(doc, "")
    }
    if (hostScoped && state.snapshot) replaceViewParams(doc, "host", { host: state.host || null })
    header.render(headerView())
    const selectedRange = range?.render(state.snapshot, rangeClock)
    // A compact response belongs to the exact requested window. Do not show
    // zero totals from its intentionally empty request list while switching.
    const summary = state.snapshot?.overview
    const matches = !summary || selectedRange && summary.start === selectedRange.start && summary.end === selectedRange.end && summary.host === state.host
    const overview = state.snapshot && selectedRange && matches ? overviewData(state.snapshot, selectedRange, state.host) : null
    stats?.render(state, overview)
    traffic?.render(state, overview)
    systemStates?.render(state.snapshot ? selectedRange ?? null : null, state.paused)
    sessions?.render(state)
    overviewUsage?.render(state.snapshot, selectedRange)
    health?.render(state)
    // On the overview, the sidebar count follows the selected period like the
    // Sessions card. Pages without a range fall back to the retained catalog.
    const navSessions = range ? overview?.sessions : state.snapshot ? trackedSessionCount(state.snapshot, state.host) : null
    if (navCount) navCount.textContent = navSessions == null ? "—" : String(navSessions)
  }

  function togglePause() {
    state = { ...state, paused: !state.paused }
    if (state.paused) poller.pause()
    else poller.resume()
    onPauseChange?.(state.paused)
    render()
  }

  function refresh(): Promise<void> {
    if (destroyed) return Promise.resolve()
    if (refreshTask) {
      refreshPending = true
      return refreshTask
    }
    refreshTask = (async () => {
      do {
        refreshPending = false
        await refreshOnce()
      } while (refreshPending && !destroyed)
    })().finally(() => { refreshTask = null })
    return refreshTask
  }

  async function refreshOnce() {
    if (destroyed) return
    state = { ...state, busy: true }
    render()
    const current = ++generation
    const controller = new AbortController()
    const timeout = view.setTimeout(() => controller.abort(), 7000)
    try {
      const requestedClock = Date.now()
      const requestedRange = range?.render(null, requestedClock)
      const next = await fetchSnapshot(controller.signal, { compact: true, range: requestedRange, host: state.host, now: requestedClock })
      if (destroyed || current !== generation) return
      rangeClock = next.overview ? requestedClock : undefined
      state = { ...state, snapshot: next, stale: false, error: "" }
    } catch (error) {
      if (destroyed || current !== generation) return
      state = {
        ...state,
        stale: true,
        error: error instanceof Error && error.name !== "AbortError" ? error.message : "The local diagnostics request timed out.",
      }
    } finally {
      view.clearTimeout(timeout)
      if (!destroyed && current === generation) {
        state = { ...state, busy: false }
        render()
      }
    }
  }

  function requestRefresh() {
    if (state.busy) refreshPending = true
    else void refresh()
  }

  syncHostLinks(doc, initialHost)
  render()
  if (autoStart) {
    poller.start()
    void refresh()
  }

  return {
    refresh,
    render,
    destroy() {
      destroyed = true
      poller.stop()
      unsubscribe()
      traffic?.destroy()
      systemStates?.destroy()
      range?.destroy()
      sessions?.destroy()
      overviewUsage?.destroy()
    },
    get paused() { return state.paused },
  }
}

function dashboardNotice(state: DashboardViewState): string | null {
  const { snapshot, error } = state
  if (error) {
    const detail = error.trim()
    const separator = /[.!?]$/.test(detail) ? " " : ". "
    return `${detail}${snapshot ? `${separator}Showing the last successful snapshot; values may be stale.` : ""}`
  }
  if (!snapshot) return null
  if (snapshot.history.persistence_error) return "Statistics could not be saved to disk. Live observations still work, but new history may be lost on restart. Check permissions and free space for the gateway’s --stats-file."
  if (!snapshot.relay.reachable) {
    const connection = observationConnection(state.system)
    return connection === "remote_stopped" ? "The remote host is stopped. Resume it using System controls or your hosting provider. Automatic reconnect and wake are off." : connection === "no_internet" ? "This computer has no internet connection, so the remote relay health check cannot run. Check Wi-Fi, Ethernet, VPN, or the default route. There is no direct-provider fallback." : connection === "vps_unreachable" ? "Internet is reachable, but the remote relay health check failed. Check the relay, VPN split routes, or SSH tunnel. There is no direct-provider fallback." : "The gateway is reachable, but its remote relay health check failed. Check the relay, VPN, or SSH tunnel. There is no direct-provider fallback."
  }
  if (!snapshot.history.persistent) return "History is in-memory only. Set the gateway’s --stats-file to retain session statistics across restarts."
  return null
}
