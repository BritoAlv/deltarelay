import { escapeHtml } from "../../lib/html.js"
import { percentage, span } from "../../lib/metrics.js"
import {
  fetchSystemHistory,
  historyCoverage,
  historyStateLabels,
  historyStates,
  historyTrackedSeconds,
  type HistoryState,
  type SystemHistory,
  type SystemHistoryInterval,
} from "../../lib/system-history.js"
import { formatAxisLabel, formatDate, formatDateTime, type TrafficRange } from "../../lib/traffic.js"
import { requiredById } from "../dom.js"

export interface SystemStatesFeature {
  render(range: TrafficRange | null, paused: boolean): void
  refresh(): void
  destroy(): void
}

const REFRESH_MS = 30_000

const tone: Record<HistoryState, string> = {
  connected: "good",
  recovering: "neutral",
  unreachable: "bad",
  host_stopped: "warning",
  no_internet: "warning",
  stopped: "neutral",
  off: "neutral",
  unknown: "neutral",
}

function rangeKey(range: TrafficRange): string {
  return `${range.start}:${range.end}:${range.bucketMs}`
}

function stateTone(state: HistoryState): string {
  return tone[state]
}

function percentageOf(value: number, total: number): string {
  return percentage(total > 0 ? value / total * 100 : null)
}

export function mountSystemStates(root: HTMLElement): SystemStatesFeature {
  const lanes = requiredById<HTMLElement>(root, "state-lanes")
  const ring = requiredById<HTMLElement>(root, "state-ring")
  const legend = requiredById<HTMLElement>(root, "state-legend")
  const notice = requiredById<HTMLElement>(root, "state-notice")
  const coverage = requiredById<HTMLElement>(root, "state-coverage")
  const currentPill = requiredById<HTMLElement>(root, "state-current-pill")
  const currentSince = requiredById<HTMLElement>(root, "state-current-since")
  const lanesRange = requiredById<HTMLElement>(root, "state-lanes-range")
  const ringRange = requiredById<HTMLElement>(root, "state-ring-range")
  const ringTotal = requiredById<HTMLElement>(root, "state-ring-total")
  let currentRange: TrafficRange | null = null
  let currentKey = ""
  let data: SystemHistory | null = null
  let dataKey = ""
  let error = ""
  let lastFetch = 0
  let request = 0
  let loading = false
  let paused = false
  let destroyed = false

  function resetLanes(message = "Waiting for supervisor history…"): void {
    lanes.innerHTML = `<div class="chart-placeholder">${escapeHtml(message)}</div>`
    lanes.setAttribute("aria-label", "State lane timeline awaiting supervisor history")
  }

  function resetRing(message = "Waiting…"): void {
    ring.innerHTML = `<div class="chart-placeholder">${escapeHtml(message)}</div>`
    ring.setAttribute("aria-label", "State composition awaiting supervisor history")
    legend.innerHTML = ""
  }

  function reset(message = "Waiting for supervisor history…"): void {
    resetLanes(message)
    resetRing("Waiting…")
    coverage.textContent = "No data"
    ringTotal.textContent = "—"
    currentPill.textContent = "Waiting…"
    currentPill.className = "status-pill neutral"
    currentSince.textContent = ""
  }

  function setRangeLabels(range: TrafficRange | null): void {
    const label = range?.label ?? "the selected period"
    lanesRange.textContent = label
    ringRange.textContent = label
  }

  function updateNotice(history: SystemHistory | null): void {
    const messages: string[] = []
    if (error) messages.push(error)
    if (history?.storage_error) messages.push("State history has a storage problem; recent observations are retained in memory only.")
    if (history && !history.intervals_complete) messages.push("State lanes show the first 6,000 transitions. Narrow the selected period for complete detail.")
    const text = messages.join(" ")
    notice.hidden = messages.length === 0
    if (notice.textContent !== text) notice.textContent = text
  }

  function updateCurrent(history: SystemHistory): void {
    const state = history.current.state
    currentPill.textContent = historyStateLabels[state]
    currentPill.className = `status-pill ${stateTone(state)}`
    const since = Date.parse(history.current.since)
    const generated = Date.parse(history.generated_at)
    currentSince.textContent = Number.isFinite(since) && Number.isFinite(generated) && generated >= since
      ? `for ${span((generated - since) / 1000)}`
      : ""
  }

  function axisLabels(start: number, end: number): string[] {
    return [start, start + (end - start) / 2, end].map((at) => formatAxisLabel(at, end - start))
  }

  function renderLanes(history: SystemHistory): void {
    const start = Date.parse(history.start)
    const end = Date.parse(history.end)
    const spanMs = Math.max(1, end - start)
    if (history.intervals.length === 0) {
      resetLanes("No tracked time in this range.")
      coverage.textContent = "No tracked time"
      return
    }
    const rows: string[] = []
    const byState = new Map<HistoryState, SystemHistoryInterval[]>()
    for (const interval of history.intervals) {
      const list = byState.get(interval.state)
      if (list) list.push(interval)
      else byState.set(interval.state, [interval])
    }
    for (const state of historyStates) {
      const intervals = byState.get(state)
      if (!intervals) continue
      const segments = intervals.map((item) => {
        const from = Date.parse(item.start)
        const to = Date.parse(item.end)
        const left = (from - start) / spanMs * 100
        const width = (to - from) / spanMs * 100
        return `<i class="state-lane-segment state-${state}" title="${escapeHtml(`${formatDateTime(from)} → ${formatDateTime(to)} · ${historyStateLabels[state]}: ${span((to - from) / 1000)}`)}" style="left:${left.toFixed(3)}%;width:${Math.max(width, .12).toFixed(3)}%"></i>`
      }).join("")
      rows.push(`<span class="state-lane-label"><i class="state-dot" aria-hidden="true"></i>${escapeHtml(historyStateLabels[state])}</span><span class="state-lane-track">${segments}</span>`)
    }
    const labels = axisLabels(start, end)
    lanes.innerHTML = `<div class="state-lanes-grid">${rows.join("")}<span class="state-lane-axis"><span>${escapeHtml(labels[0]!)}</span><span>${escapeHtml(labels[1]!)}</span><span>${escapeHtml(labels[2]!)}</span></span></div>`
    const summary = historyStates.filter((state) => history.totals[state] > 0)
      .map((state) => `${historyStateLabels[state]} ${span(history.totals[state])}`).join(", ")
    lanes.setAttribute("aria-label", `${currentRange?.label ?? "Selected period"}: ${summary || "no tracked time"}. Exact state transitions.`)
    const observed = historyCoverage(history)
    coverage.textContent = `${observed === null ? "Coverage unknown" : `${percentage(observed)} observed`} · tracking since ${formatDate(Date.parse(history.tracking_since))}`
  }

  function renderRing(history: SystemHistory): void {
    const tracked = historyTrackedSeconds(history)
    const total = tracked > 0 ? tracked : 0
    ringTotal.textContent = total > 0 ? span(total) : "0s"
    if (total <= 0) {
      resetRing("No tracked time in this range.")
      return
    }
    const radius = 82
    const circumference = 2 * Math.PI * radius
    let offset = 0
    const segments: string[] = []
    for (const state of historyStates) {
      const value = history.totals[state]
      if (value <= 0) continue
      const length = value / total * circumference
      segments.push(`<circle class="state-ring-segment state-${state}" cx="110" cy="110" r="${radius}" fill="none" stroke-width="22" stroke-dasharray="${length.toFixed(3)} ${(circumference - length).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}"><title>${escapeHtml(`${historyStateLabels[state]}: ${span(value)} · ${percentageOf(value, total)}`)}</title></circle>`)
      offset += length
    }
    ring.innerHTML = `<svg viewBox="0 0 220 220" aria-hidden="true"><circle class="state-ring-track" cx="110" cy="110" r="${radius}" fill="none" stroke-width="22"/>${segments.join("")}</svg><div class="state-ring-center"><strong>${escapeHtml(percentageOf(history.totals.connected, total))}</strong><span>connected</span></div>`
    const summary = historyStates.filter((state) => history.totals[state] > 0)
      .map((state) => `${historyStateLabels[state]} ${percentageOf(history.totals[state], total)}`).join(", ")
    ring.setAttribute("aria-label", `${currentRange?.label ?? "Selected period"}: ${summary}.`)

    legend.innerHTML = historyStates
      .filter((state) => history.totals[state] > 0)
      .sort((left, right) => history.totals[right] - history.totals[left])
      .map((state) => `<div class="state-legend-row state-${state}"><span class="state-legend-name"><i class="state-dot" aria-hidden="true"></i>${escapeHtml(historyStateLabels[state])}</span><span class="state-legend-value"><strong>${escapeHtml(span(history.totals[state]))}</strong><small>${escapeHtml(percentageOf(history.totals[state], total))}</small></span></div>`)
      .join("")
  }

  function renderData(): void {
    if (!data || dataKey !== currentKey) {
      if (error) {
        resetLanes(error)
        resetRing("Unavailable")
        coverage.textContent = "Unavailable"
        ringTotal.textContent = "—"
        currentPill.textContent = "Unavailable"
        currentPill.className = "status-pill neutral"
        currentSince.textContent = ""
      }
      updateNotice(null)
      return
    }
    updateCurrent(data)
    renderLanes(data)
    renderRing(data)
    updateNotice(data)
  }

  async function load(force = false): Promise<void> {
    if (!currentRange || destroyed || loading || (paused && !force)) return
    const range = currentRange
    const key = currentKey
    const identifier = ++request
    loading = true
    lastFetch = Date.now()
    let next: SystemHistory | null = null
    let failure = ""
    try {
      next = await fetchSystemHistory(range, AbortSignal.timeout(7000))
    } catch (cause) {
      failure = cause instanceof Error && cause.name === "AbortError"
        ? "State history took too long to respond."
        : cause instanceof Error ? cause.message : "State history is unavailable."
    } finally {
      loading = false
    }
    if (destroyed || identifier !== request || key !== currentKey) {
      if (!destroyed && !paused && currentRange && rangeKey(currentRange) !== key) void load()
      return
    }
    if (next) {
      data = next
      dataKey = key
      error = ""
    } else {
      error = failure
    }
    renderData()
  }

  function render(range: TrafficRange | null, isPaused: boolean): void {
    if (destroyed) return
    paused = isPaused
    currentRange = range
    setRangeLabels(range)
    if (!range) {
      currentKey = ""
      reset()
      updateNotice(null)
      return
    }
    const nextKey = rangeKey(range)
    if (nextKey !== currentKey) {
      currentKey = nextKey
      lastFetch = 0
      error = ""
    }
    if (!paused && !loading && (lastFetch === 0 || Date.now() - lastFetch >= REFRESH_MS)) void load()
    if (dataKey !== currentKey) {
      resetLanes(paused ? "Refresh paused" : "Loading state history…")
      resetRing(paused ? "Paused" : "Loading…")
      coverage.textContent = paused ? "Paused" : "Loading…"
      ringTotal.textContent = paused ? "Paused" : "Loading…"
      currentPill.textContent = paused ? "Paused" : "Loading…"
      currentPill.className = "status-pill neutral"
      currentSince.textContent = ""
    }
    renderData()
  }

  reset()

  return {
    render,
    refresh() {
      if (!currentRange || destroyed) return
      lastFetch = 0
      void load(true)
    },
    destroy() {
      destroyed = true
      request++
    },
  }
}
