import { relativeTime } from "../lib/metrics.js"
import { createPoller } from "../lib/polling.js"
import { connectionState, fetchSystem, type SystemStatus } from "../lib/system.js"
import { systemObservations, type SystemObservation } from "../lib/state.js"
import { mountControls } from "./features/controls.js"
import { mountActivity } from "./features/activity.js"
import { mountHeader } from "./features/header.js"

export interface SystemOptions {
  autoStart?: boolean
  /** Render the shared page header. Health-only pages leave it to the dashboard poller. */
  manageHeader?: boolean
  refreshNote?: string
  waitingLabel?: string
}

export interface SystemApp {
  refresh(): Promise<void>
  renderAuth(): void
  pause(): void
  resume(): void
  destroy(): void
  readonly paused: boolean
}

// The supervisor schedule is independent from the gateway diagnostics schedule.
// It publishes explicit freshness observations for features on the same page
// and mounts controls only when the current page includes them.
export function startSystemStatus(doc: Document = document, options: SystemOptions = {}): SystemApp {
  const {
    autoStart = true,
    manageHeader = true,
    refreshNote = "Auto-refresh every 5s",
    waitingLabel = "Waiting for local supervisor",
  } = options
  const view = doc.defaultView ?? globalThis
  const controlsRoot = doc.getElementById("controls")
  let system: SystemStatus | null = null
  let stale = true
  let busy = false
  let paused = false
  let receivedAt = 0
  let destroyed = false

  const header = manageHeader ? mountHeader({
    doc,
    refreshNote,
    onRefresh: () => void refresh(),
    onPauseToggle: () => togglePause(),
  }) : null
  const activityRoot = doc.getElementById("activity-console")
  const activity = activityRoot ? mountActivity(activityRoot, autoStart) : null
  const controls = controlsRoot ? mountControls({ root: controlsRoot, onRefresh: () => void refresh(), onAction: () => activity?.reveal() }) : null
  const poller = createPoller({ intervalMs: 5_000, run: refreshStatus, document: doc, onPaused: render })
  const countdownTimer: ReturnType<typeof setInterval> | null = controls && autoStart
    ? view.setInterval(() => { if (doc.visibilityState !== "hidden") controls.renderAuth() }, 1_000)
    : null

  function observation(): SystemObservation {
    if (!system) return { connection: "unknown", collectedAt: null, receivedAt: receivedAt || null, stale: true, managed: false }
    return {
      connection: connectionState(system),
      collectedAt: system.collected_at,
      receivedAt: receivedAt || null,
      stale,
      managed: system.managed,
    }
  }

  function render() {
    if (destroyed) return
    controls?.update(system, stale, receivedAt)
    systemObservations.publish(observation())
    if (!header) return
    const notice = stale
      ? "System status is stale. Controls are disabled until a fresh connection is available."
      : paused ? "Automatic status refresh is paused." : null
    header.render({
      label: stale ? "Disconnected" : system ? paused ? "Paused" : "Live" : "Connecting",
      updatedAt: system ? `Updated ${relativeTime(system.collected_at)}` : waitingLabel,
      paused,
      stale,
      busy,
      notice,
    })
  }

  function togglePause() {
    paused = !paused
    if (paused) { poller.pause(); activity?.pause() }
    else { poller.resume(); activity?.resume() }
    render()
  }

  async function refresh() {
    await Promise.all([refreshStatus(), activity?.refresh()])
  }

  async function refreshStatus() {
    if (destroyed || busy) return
    busy = true
    render()
    try {
      const next = await fetchSystem(AbortSignal.timeout(6000))
      if (destroyed) return
      system = next
      stale = false
      receivedAt = Date.now()
    } catch {
      if (destroyed) return
      // Keep the last successful status on screen but mark it stale, which
      // disables every control until a fresh observation arrives.
      stale = true
    } finally {
      if (!destroyed) {
        busy = false
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
    renderAuth: () => controls?.renderAuth(),
    pause() {
      if (paused) return
      togglePause()
    },
    resume() {
      if (!paused) return
      togglePause()
    },
    destroy() {
      destroyed = true
      poller.stop()
      activity?.destroy()
      if (countdownTimer !== null) view.clearInterval(countdownTimer)
    },
    get paused() { return paused },
  }
}
