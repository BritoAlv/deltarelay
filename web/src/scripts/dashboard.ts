import { fetchSnapshot } from "../lib/api.js"
import { createPoller } from "../lib/polling.js"
import { systemObservations, type DashboardViewState } from "../lib/state.js"
import { requiredById } from "./dom.js"
import { mountHealth } from "./features/health.js"
import { mountOverview } from "./features/overview.js"
import { mountSessions } from "./features/sessions.js"
import { mountTraffic } from "./features/traffic.js"

export interface DashboardOptions {
  autoStart?: boolean
}

export interface DashboardApp {
  refresh(): Promise<void>
  render(): void
  destroy(): void
  readonly paused: boolean
}

// Composes the gateway-backed dashboard features. It never touches the
// supervisor control API: a gateway failure only marks this diagnostic view
// stale, while System controls keep their own independent schedule.
export function startDashboard(doc: Document = document, options: DashboardOptions = {}): DashboardApp {
  const { autoStart = true } = options
  const view = doc.defaultView ?? globalThis
  const overviewRoot = requiredById<HTMLElement>(doc, "overview")
  const trafficRoot = requiredById<HTMLElement>(doc, "traffic-panel")
  const sessionsRoot = requiredById<HTMLElement>(doc, "sessions")
  const healthRoot = requiredById<HTMLElement>(doc, "system")
  const dialog = requiredById<HTMLDialogElement>(doc, "session-dialog")
  const navCount = requiredById<HTMLElement>(doc, "nav-session-count")

  let state: DashboardViewState = { snapshot: null, stale: false, paused: false, busy: false, error: "", system: null }
  let generation = 0
  let destroyed = false

  const overview = mountOverview({
    root: overviewRoot,
    navCount,
    onRefresh: () => void refresh(),
    onPauseToggle: () => togglePause(),
  })
  const traffic = mountTraffic(trafficRoot)
  const sessions = mountSessions(sessionsRoot, dialog)
  const health = mountHealth(healthRoot)
  const unsubscribe = systemObservations.subscribe((system) => {
    state = { ...state, system }
    render()
  })

  const poller = createPoller({ intervalMs: 10_000, run: refresh, document: doc, onPaused: render })
  doc.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => link.addEventListener("click", () => {
    doc.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("selected", item === link))
  }))

  function render() {
    if (destroyed) return
    overview.render(state)
    traffic.render(state)
    sessions.render(state)
    health.render(state)
  }

  function togglePause() {
    state = { ...state, paused: !state.paused }
    if (state.paused) poller.pause()
    else poller.resume()
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
    },
    get paused() { return state.paused },
  }
}
