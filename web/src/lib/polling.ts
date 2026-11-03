export interface PollerOptions {
  intervalMs: number
  run: () => void | Promise<void>
  document: Document
  immediate?: boolean
  /** Called on the normal cadence while paused, for local-only re-renders. */
  onPaused?: () => void
}

export interface Poller {
  readonly paused: boolean
  start(): void
  stop(): void
  pause(): void
  resume(): void
  refresh(): void
}

// One polling implementation for independent schedules. Pausing one poller has
// no effect on the other: dashboard diagnostics can pause while supervisor
// controls keep refreshing. A paused poller still fires local-only renders on
// its cadence, but never performs I/O.
export function createPoller({ intervalMs, run, document: doc, immediate = false, onPaused }: PollerOptions): Poller {
  const view = doc.defaultView ?? globalThis
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let paused = false
  const listeners = new AbortController()

  const visible = () => doc.visibilityState !== "hidden"
  const tick = () => {
    if (!visible()) return
    if (paused) {
      onPaused?.()
      return
    }
    void run()
  }
  const arm = () => {
    if (timer !== null || !running) return
    timer = view.setInterval(tick, intervalMs)
  }
  const clear = () => {
    if (timer === null) return
    view.clearInterval(timer)
    timer = null
  }

  doc.addEventListener("visibilitychange", () => {
    if (visible()) tick()
  }, { signal: listeners.signal })

  return {
    get paused() { return paused },
    start() {
      if (running) return
      running = true
      arm()
      if (immediate) tick()
    },
    stop() {
      running = false
      clear()
      listeners.abort()
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
      tick()
    },
    refresh: tick,
  }
}
