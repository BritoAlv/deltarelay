import { fetchSnapshot } from "../lib/api.js"
import { relativeTime } from "../lib/metrics.js"
import { createPoller } from "../lib/polling.js"
import type { DashboardViewState } from "../lib/state.js"
import { requiredById } from "./dom.js"
import { mountMeasurement } from "./features/measurement.js"

export interface MeasurementPageOptions {
  autoStart?: boolean
}

export interface MeasurementPageApp {
  refresh(): Promise<void>
  render(): void
  destroy(): void
  readonly paused: boolean
}

// The standalone measurement page uses the same read-only gateway snapshot as
// the main dashboard. It has its own poller so pausing this view never affects
// another open dashboard tab.
export function startMeasurementPage(doc: Document = document, options: MeasurementPageOptions = {}): MeasurementPageApp {
  const { autoStart = true } = options
  const view = doc.defaultView ?? globalThis
  const root = requiredById<HTMLElement>(doc, "measurement")
  const refreshButton = requiredById<HTMLButtonElement>(doc, "measurement-refresh-button")
  const pauseButton = requiredById<HTMLButtonElement>(doc, "measurement-pause-button")
  const pauseIcon = pauseButton.innerHTML
  const connectionBadge = requiredById(doc, "measurement-connection-badge")
  const connectionLabel = requiredById(doc, "measurement-connection-label")
  const updatedAt = requiredById(doc, "measurement-updated-at")
  const refreshNote = requiredById(doc, "measurement-refresh-note")
  const notice = requiredById<HTMLElement>(doc, "measurement-notice")

  let state: DashboardViewState = { snapshot: null, stale: false, paused: false, busy: false, error: "", system: null }
  let generation = 0
  let destroyed = false
  const measurement = mountMeasurement(root)
  const poller = createPoller({ intervalMs: 10_000, run: refresh, document: doc, onPaused: render })

  refreshButton.addEventListener("click", () => void refresh())
  pauseButton.addEventListener("click", () => togglePause())

  function renderConnection() {
    const { snapshot, stale, paused } = state
    const label = stale ? "Disconnected" : snapshot ? paused ? "Paused" : "Live" : "Connecting…"
    refreshButton.disabled = state.busy
    refreshButton.setAttribute("aria-busy", String(state.busy))
    connectionBadge.classList.toggle("stale", stale || paused)
    connectionBadge.classList.toggle("connecting", label === "Connecting…")
    if (connectionLabel.textContent !== label) connectionLabel.textContent = label
    const updated = snapshot ? `Updated ${relativeTime(snapshot.collected_at)}` : "Waiting for local gateway…"
    if (updatedAt.textContent !== updated) updatedAt.textContent = updated
    const note = paused ? "Automatic refresh paused" : "Auto-refresh every 10s"
    if (refreshNote.textContent !== note) refreshNote.textContent = note
    pauseButton.setAttribute("aria-label", paused ? "Resume automatic refresh" : "Pause automatic refresh")
    pauseButton.title = paused ? "Resume automatic refresh" : "Pause automatic refresh"
    pauseButton.setAttribute("aria-pressed", String(paused))
    pauseButton.innerHTML = paused ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m8 5 12 7-12 7V5z"/></svg>' : pauseIcon
    let message = ""
    if (state.error) message = `${state.error}${snapshot ? " Showing the last successful snapshot; measurement values may be stale." : ""}`
    else if (snapshot?.history.persistence_error) message = "Statistics could not be saved to disk. Live observations still work, but new history may be lost on restart. Check permissions and free space for the gateway’s --stats-file."
    else if (snapshot && !snapshot.history.persistent) message = "History is in-memory only. Set the gateway’s --stats-file to retain session statistics across restarts."
    const wasHidden = notice.hidden
    notice.hidden = !message
    if (message && (wasHidden || notice.textContent !== message)) notice.textContent = message
  }

  function render() {
    if (destroyed) return
    measurement.render(state)
    renderConnection()
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
      measurement.destroy()
    },
    get paused() { return state.paused },
  }
}
