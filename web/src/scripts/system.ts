import { createPoller } from "../lib/polling.js"
import { fetchSystem } from "../lib/system.js"
import { requiredById } from "./dom.js"
import { mountControls } from "./features/controls.js"

export interface SystemOptions {
  autoStart?: boolean
}

export interface SystemApp {
  refresh(): Promise<void>
  renderAuth(): void
  destroy(): void
}

// Composes supervisor-backed controls. This schedule is independent from the
// gateway diagnostics schedule, so a gateway outage cannot disable recovery,
// authentication, or service controls.
export function startSystemControls(doc: Document = document, options: SystemOptions = {}): SystemApp {
  const { autoStart = true } = options
  const view = doc.defaultView ?? globalThis
  const root = requiredById<HTMLElement>(doc, "controls")
  const overviewRoot = requiredById<HTMLElement>(doc, "overview")
  let receivedAt = 0
  let destroyed = false

  const controls = mountControls({ root, overviewRoot, onRefresh: () => void refresh() })
  const poller = createPoller({ intervalMs: 5_000, run: refresh, document: doc })
  let countdownTimer: ReturnType<typeof setInterval> | null = autoStart
    ? view.setInterval(() => { if (doc.visibilityState !== "hidden") controls.renderAuth() }, 1_000)
    : null

  async function refresh() {
    if (destroyed) return
    try {
      const next = await fetchSystem(AbortSignal.timeout(6000))
      if (destroyed) return
      receivedAt = Date.now()
      controls.update(next, false, receivedAt)
    } catch {
      if (destroyed) return
      // Keep the last successful snapshot on screen but mark it stale, which
      // disables every control until a fresh observation arrives.
      controls.update(null, true, receivedAt)
    }
  }

  if (autoStart) {
    poller.start()
    void refresh()
  }

  return {
    refresh,
    renderAuth: () => controls.renderAuth(),
    destroy() {
      destroyed = true
      poller.stop()
      if (countdownTimer !== null) view.clearInterval(countdownTimer)
    },
  }
}
