import { fetchSnapshot } from "../lib/api.js"
import { relativeTime } from "../lib/metrics.js"
import { createPoller } from "../lib/polling.js"
import { observationConnection, systemObservations, type DashboardViewState } from "../lib/state.js"
import { requiredById } from "./dom.js"
import { mountHeader, type HeaderView } from "./features/header.js"
import { mountHealth } from "./features/health.js"
import { mountSessions } from "./features/sessions.js"
import { mountStats } from "./features/stats.js"
import { mountTraffic } from "./features/traffic.js"

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
    waitingLabel = "Waiting for local gateway",
    onPauseChange,
  } = options
  const view = doc.defaultView ?? globalThis
  const statsRoot = doc.getElementById("stats-grid")
  const trafficRoot = doc.getElementById("traffic-panel")
  const sessionsRoot = doc.getElementById("sessions")
  const healthRoot = doc.getElementById("system")
  if (!statsRoot && !trafficRoot && !sessionsRoot && !healthRoot) {
    throw new Error("Dashboard page has no overview, traffic, sessions, or system section")
  }
  const dialog = sessionsRoot ? requiredById<HTMLDialogElement>(doc, "session-dialog") : null
  const navCount = doc.getElementById("nav-session-count")

  let state: DashboardViewState = { snapshot: null, stale: false, paused: false, busy: false, error: "", system: null }
  let generation = 0
  let destroyed = false

  const header = mountHeader({
    doc,
    refreshNote,
    onRefresh: () => void refresh(),
    onPauseToggle: () => togglePause(),
  })
  const stats = statsRoot ? mountStats(statsRoot) : null
  const traffic = trafficRoot ? mountTraffic(trafficRoot) : null
  const sessions = sessionsRoot && dialog ? mountSessions(sessionsRoot, dialog) : null
  const health = healthRoot ? mountHealth(healthRoot) : null
  const unsubscribe = systemObservations.subscribe((system) => {
    state = { ...state, system }
    render()
  })

  const poller = createPoller({ intervalMs: 10_000, run: refresh, document: doc, onPaused: render })

  function headerView(): HeaderView {
    const { snapshot, stale, paused, busy } = state
    return {
      label: stale ? "Disconnected" : snapshot ? paused ? "Paused" : "Live" : "Connecting",
      updatedAt: snapshot ? `Updated ${relativeTime(snapshot.collected_at)}` : waitingLabel,
      paused,
      stale,
      busy,
      notice: dashboardNotice(state),
    }
  }

  function render() {
    if (destroyed) return
    header.render(headerView())
    stats?.render(state)
    traffic?.render(state)
    sessions?.render(state)
    health?.render(state)
    if (navCount) navCount.textContent = state.snapshot ? String(state.snapshot.history.sessions.length) : "—"
  }

  function togglePause() {
    state = { ...state, paused: !state.paused }
    if (state.paused) poller.pause()
    else poller.resume()
    onPauseChange?.(state.paused)
    render()
  }

  async function refresh() {
    if (destroyed || state.busy) return
    state = { ...state, busy: true }
    render()
    const current = ++generation
    const controller = new AbortController()
    const timeout = view.setTimeout(() => controller.abort(), 7000)
    try {
      const next = await fetchSnapshot(controller.signal)
      if (destroyed || current !== generation) return
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
    },
    get paused() { return state.paused },
  }
}

function dashboardNotice(state: DashboardViewState): string | null {
  const { snapshot, error } = state
  if (error) return `${error}${snapshot ? " Showing the last successful snapshot; values may be stale." : ""}`
  if (!snapshot) return null
  if (snapshot.history.persistence_error) return "Statistics could not be saved to disk. Live observations still work, but new history may be lost on restart. Check permissions and free space for the gateway’s --stats-file."
  if (!snapshot.relay.reachable) {
    const connection = observationConnection(state.system)
    return connection === "remote_stopped" ? "The remote host is stopped. Resume it using System controls or your hosting provider. Automatic reconnect and wake are off." : connection === "no_internet" ? "This computer has no internet connection, so the VPS health check cannot run. Check Wi-Fi, Ethernet, VPN, or the default route. There is no direct-provider fallback." : connection === "vps_unreachable" ? "Internet is reachable, but the VPS health check failed. Check the relay, VPN split routes, or SSH tunnel. There is no direct-provider fallback." : "The gateway is reachable, but its VPS health check failed. Check the relay, VPN, or SSH tunnel. There is no direct-provider fallback."
  }
  if (!snapshot.history.persistent) return "History is in-memory only. Set the gateway’s --stats-file to retain session statistics across restarts."
  return null
}
