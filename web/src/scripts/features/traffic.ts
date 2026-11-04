import { escapeHtml } from "../../lib/html.js"
import { bytes, percentage } from "../../lib/metrics.js"
import {
  compositionSegments,
  customRange,
  dateInputValue,
  DAY_MS,
  formatAxisLabel,
  formatBucketWindow,
  formatDate,
  niceScale,
  presetRange,
  trafficData,
  type TrafficData,
  type TrafficPoint,
  type TrafficPreset,
  type TrafficRange,
  type TrafficView,
} from "../../lib/traffic.js"
import type { DashboardViewState } from "../../lib/state.js"
import { readParams, replaceParams } from "../../lib/url-state.js"
import { requiredById } from "../dom.js"

export interface TrafficFeature {
  render(state: DashboardViewState): void
  destroy(): void
}

const REUSE_RING_LENGTH = 414.69
const validPresets: readonly TrafficPreset[] = ["24h", "7d", "30d", "90d", "custom"]

interface ChartLayout {
  left: number
  right: number
  top: number
  bottom: number
  slot: number
  points: TrafficPoint[]
  y: (value: number) => number
}

export function mountTraffic(root: HTMLElement): TrafficFeature {
  const rangeSelect = requiredById<HTMLSelectElement>(root, "chart-range")
  const custom = requiredById<HTMLElement>(root, "chart-custom")
  const startInput = requiredById<HTMLInputElement>(root, "chart-start")
  const endInput = requiredById<HTMLInputElement>(root, "chart-end")
  const applyButton = requiredById<HTMLButtonElement>(root, "chart-apply")
  const compositionButton = requiredById<HTMLButtonElement>(root, "chart-view-composition")
  const trendsButton = requiredById<HTMLButtonElement>(root, "chart-view-trends")
  const chart = requiredById<HTMLElement>(root, "traffic-chart")
  const tooltip = requiredById<HTMLElement>(root, "chart-tooltip")
  const legend = requiredById<HTMLElement>(root, "chart-legend")
  const notice = requiredById<HTMLElement>(root, "chart-notice")
  const reuseRing = requiredById<SVGCircleElement>(root, "reuse-ring")
  const integer = (value: number) => value.toLocaleString()
  const setText = (id: string, value: string | number) => { requiredById(root, id).textContent = String(value) }

  const initial = readParams(root.ownerDocument)
  const initialPreset = initial.get("range") as TrafficPreset | null
  let lastState: DashboardViewState | null = null
  let preset: TrafficPreset = initialPreset && validPresets.includes(initialPreset) ? initialPreset : "24h"
  let view: TrafficView = initial.get("view") === "trends" ? "trends" : "composition"
  let customStart = initial.get("start") ?? ""
  let customEnd = initial.get("end") ?? ""
  let lastData: TrafficData | null = null
  let lastRange: TrafficRange | null = null
  let layout: ChartLayout | null = null
  let activeIndex: number | null = null
  let pointerInside = false
  let cursorLine: SVGLineElement | null = null
  let cursorDot: SVGCircleElement | null = null
  let lastWidth = 0
  let resizeFrame = 0
  let observer: ResizeObserver | null = null
  let windowResize: (() => void) | null = null
  const viewWindow = root.ownerDocument.defaultView

  function nowFor(state: DashboardViewState): number {
    const parsed = state.snapshot ? Date.parse(state.snapshot.collected_at) : NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  function reset(message = "Waiting for local data…"): void {
    for (const id of ["chart-original", "chart-encoded", "chart-saved", "chart-reused", "chart-saved-rate", "chart-reuse-rate", "reuse-value", "reuse-bytes", "uploaded-bytes"]) setText(id, "—")
    setText("chart-count", "0 requests in this window")
    setText("reuse-scope", "Selected range")
    requiredById(root, "chart-saved").classList.remove("negative")
    requiredById(root, "chart-saved-rate").classList.remove("negative")
    reuseRing.style.strokeDashoffset = String(REUSE_RING_LENGTH)
    chart.innerHTML = `<div class="chart-placeholder">${escapeHtml(message)}</div>`
    chart.setAttribute("aria-label", "Upload traffic chart awaiting data")
    notice.hidden = true
    tooltip.hidden = true
    updateLegend()
    lastData = null
    lastRange = null
    layout = null
    activeIndex = null
  }

  function syncCustomBounds(now: number, state: DashboardViewState): void {
    const since = state.snapshot ? Date.parse(state.snapshot.history.since) : NaN
    const earliest = Number.isFinite(since) ? Math.max(since, now - 90 * DAY_MS) : now - 90 * DAY_MS
    startInput.min = endInput.min = dateInputValue(earliest)
    startInput.max = endInput.max = dateInputValue(now)
  }

  function ensureCustomDefaults(now: number): void {
    if (!customStart || !customEnd || customRange(customStart, customEnd, now).error) {
      customStart = dateInputValue(now - 7 * DAY_MS)
      customEnd = dateInputValue(now)
    }
    startInput.value = customStart
    endInput.value = customEnd
  }

  function resolveRange(state: DashboardViewState): { range?: TrafficRange; error?: string } {
    const now = nowFor(state)
    if (preset !== "custom") return { range: presetRange(preset, now) }
    const result = customRange(customStart, customEnd, now)
    if (!result.range) return { error: result.error ?? "Choose a valid custom range." }
    return { range: result.range }
  }

  function syncUrl(): void {
    replaceParams(root.ownerDocument, {
      range: preset === "24h" ? null : preset,
      view: view === "composition" ? null : view,
      start: preset === "custom" ? customStart || null : null,
      end: preset === "custom" ? customEnd || null : null,
    })
  }

  function updateSummary(data: TrafficData): void {
    const totals = data.totals
    setText("chart-original", bytes(totals.body))
    setText("chart-encoded", bytes(totals.encoded))
    setText("chart-saved", bytes(totals.saved))
    setText("chart-saved-rate", percentage(totals.reduction))
    setText("chart-reused", bytes(totals.reused))
    setText("chart-reuse-rate", percentage(totals.reuse))
    requiredById(root, "chart-saved").classList.toggle("negative", totals.saved < 0)
    requiredById(root, "chart-saved-rate").classList.toggle("negative", totals.saved < 0)
    setText("chart-count", `${integer(totals.requests)} requests${totals.failed ? ` · ${integer(totals.failed)} failed` : ""}${totals.cancelled ? ` · ${integer(totals.cancelled)} cancelled` : ""} in this window`)
    setText("reuse-value", percentage(totals.reuse))
    setText("reuse-bytes", bytes(totals.reused))
    setText("uploaded-bytes", bytes(totals.uploadedChunkBytes))
    if (lastRange) setText("reuse-scope", lastRange.label)
    const reuse = Math.max(0, Math.min(100, totals.reuse ?? 0))
    reuseRing.style.strokeDashoffset = String(REUSE_RING_LENGTH * (1 - reuse / 100))
  }

  function updateLegend(): void {
    const items = view === "composition"
      ? [
          { dot: "delta", label: "Uploaded" },
          { dot: "reuse", label: "Relay cache reuse" },
          { dot: "saved", label: "Bandwidth saved · other" },
          { line: true, label: "Original total" },
        ]
      : [
          { line: true, label: "Original" },
          { dot: "delta", label: "Uploaded" },
          { dot: "saved", label: "Bandwidth saved" },
          { dot: "reuse", label: "Relay cache reuse" },
        ]
    legend.innerHTML = items.map((item) => {
      const marker = item.line ? '<span class="legend-line original"></span>' : `<span class="legend-dot ${item.dot}"></span>`
      return `<span class="chart-legend-item" role="listitem">${marker}${escapeHtml(item.label)}</span>`
    }).join("")
  }

  function updateNotice(data: TrafficData, state: DashboardViewState): void {
    const messages: string[] = []
    if (data.source === "requests") {
      messages.push(state.snapshot?.history.traffic
        ? "No aggregated traffic is available yet. Showing retained request entries only."
        : "This gateway does not expose traffic aggregates yet. Showing retained request entries only; multi-day ranges may be incomplete.")
    }
    if (data.truncated && data.coverageStart !== null) {
      const coverage = data.source === "requests" ? "Retained request coverage starts" : "Aggregated traffic starts"
      messages.push(`${coverage} ${formatDate(data.coverageStart)}; earlier totals are preserved but not plotted.`)
    }
    if (data.totals.requests === 0) messages.push("No finished requests in this range. Widen the range or wait for new traffic.")
    const text = messages.join(" ")
    notice.hidden = messages.length === 0
    if (messages.length && notice.textContent !== text) notice.textContent = text
  }

  function showNotice(message: string): void {
    notice.hidden = false
    if (notice.textContent !== message) notice.textContent = message
  }

  function axisIndices(length: number, target: number): number[] {
    if (length <= target) return Array.from({ length }, (_, index) => index)
    const indices: number[] = []
    for (let index = 0; index < target; index++) {
      const value = Math.round(index * (length - 1) / (target - 1))
      if (!indices.includes(value)) indices.push(value)
    }
    return indices
  }

  function tooltipHtml(point: TrafficPoint, range: TrafficRange): string {
    const saved = point.body - point.encoded
    const savedRate = point.body > 0 ? saved / point.body * 100 : null
    const reuseRate = point.body > 0 ? point.reused / point.body * 100 : null
    const other = saved - point.reused
    const rows = [
      ["Original", bytes(point.body), false],
      ["Uploaded", bytes(point.encoded), false],
      ["Bandwidth saved", `${bytes(saved)} (${percentage(savedRate)})`, saved < 0],
      ["Relay cache reuse", `${bytes(point.reused)} (${percentage(reuseRate)})`, false],
      ["Other savings", bytes(other), other < 0],
      ["Requests", `${integer(point.requests)}${point.failed ? ` · ${integer(point.failed)} failed` : ""}${point.cancelled ? ` · ${integer(point.cancelled)} cancelled` : ""}`, false],
    ] as const
    return `<div class="tooltip-time">${escapeHtml(formatBucketWindow(point.at, point.end, range.bucketMs))}</div><dl>${rows.map(([label, value, negative]) => `<dt>${escapeHtml(label)}</dt><dd${negative ? ' class="negative"' : ""}>${escapeHtml(value)}</dd>`).join("")}</dl>`
  }

  function tooltipText(point: TrafficPoint, range: TrafficRange): string {
    const saved = point.body - point.encoded
    const savedRate = point.body > 0 ? saved / point.body * 100 : null
    const reuseRate = point.body > 0 ? point.reused / point.body * 100 : null
    return `${formatBucketWindow(point.at, point.end, range.bucketMs)}: ${integer(point.requests)} requests${point.failed ? `, ${integer(point.failed)} failed` : ""}${point.cancelled ? `, ${integer(point.cancelled)} cancelled` : ""}. Original ${bytes(point.body)}; uploaded ${bytes(point.encoded)}; saved ${bytes(saved)} (${percentage(savedRate)}); cache reuse ${bytes(point.reused)} (${percentage(reuseRate)}).`
  }

  function drawComposition(data: TrafficData, range: TrafficRange, left: number, top: number, bottom: number, slot: number, y: (value: number) => number, barWidth: number): string {
    const bars = data.points.map((point, index) => {
      const segments = compositionSegments(point)
      const x = left + index * slot + (slot - barWidth) / 2
      let base = 0
      const segment = (value: number, className: string) => {
        if (value <= 0) return ""
        const y0 = y(base)
        const y1 = y(base + value)
        base += value
        return `<rect class="${className}" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0.6, Math.abs(y0 - y1)).toFixed(1)}"/>`
      }
      const uploaded = Math.max(0, Math.min(segments.uploaded, point.body))
      const overshoot = Math.max(0, segments.uploaded - point.body)
      return segment(uploaded, "chart-bar-upload") + segment(segments.reused, "chart-bar-reuse") + segment(segments.other, "chart-bar-other") + segment(overshoot, "chart-bar-overshoot")
    }).join("")
    const line = data.points.map((point, index) => `${index ? "L" : "M"}${(left + (index + 0.5) * slot).toFixed(1)},${y(point.body).toFixed(1)}`).join(" ")
    const original = `<path class="chart-original-line" d="${line}"/>`
    const hits = data.points.map((point, index) => {
      const x = left + index * slot
      return `<rect class="chart-hit" x="${x.toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${bottom - top}" data-index="${index}"><title>${escapeHtml(tooltipText(point, range))}</title></rect>`
    }).join("")
    return bars + original + hits
  }

  function drawTrends(data: TrafficData, range: TrafficRange, left: number, top: number, bottom: number, slot: number, y: (value: number) => number): string {
    const points = data.points
    const xAt = (index: number) => left + (index + 0.5) * slot
    const linePath = (value: (point: TrafficPoint) => number) => {
      let path = ""
      let started = false
      points.forEach((point, index) => {
        if (point.requests === 0) { started = false; return }
        path += `${started ? "L" : "M"}${xAt(index).toFixed(1)},${y(value(point)).toFixed(1)}`
        started = true
      })
      return path
    }
    const areaPath = (value: (point: TrafficPoint) => number) => {
      let path = ""
      let run: { x: number; y: number }[] = []
      const flush = () => {
        if (run.length > 1) {
          const first = run[0]!
          const last = run[run.length - 1]!
          path += `M${first.x.toFixed(1)},${y(0).toFixed(1)} L${run.map((entry) => `${entry.x.toFixed(1)},${entry.y.toFixed(1)}`).join(" L")} L${last.x.toFixed(1)},${y(0).toFixed(1)} Z`
        }
        run = []
      }
      points.forEach((point, index) => {
        if (point.requests === 0) { flush(); return }
        run.push({ x: xAt(index), y: y(value(point)) })
      })
      flush()
      return path
    }
    const saved = (point: TrafficPoint) => point.body - point.encoded
    const dots = (value: (point: TrafficPoint) => number, className: string) => points.map((point, index) => point.requests === 0 ? "" : `<circle class="${className}" cx="${xAt(index).toFixed(1)}" cy="${y(value(point)).toFixed(1)}" r="2.2"/>`).join("")
    const areas = `<path class="chart-saved-area" d="${areaPath(saved)}"/><path class="chart-reuse-area" d="${areaPath((point) => point.reused)}"/>`
    const lines = `<path class="chart-original-line" d="${linePath((point) => point.body)}"/><path class="chart-upload-line" d="${linePath((point) => point.encoded)}"/><path class="chart-saved-line" d="${linePath(saved)}"/><path class="chart-reuse-line" d="${linePath((point) => point.reused)}"/>`
    const markers = dots((point) => point.body, "chart-dot chart-dot-original") + dots((point) => point.encoded, "chart-dot chart-dot-upload") + dots(saved, "chart-dot chart-dot-saved") + dots((point) => point.reused, "chart-dot chart-dot-reuse")
    const hits = points.map((point, index) => {
      const x = left + index * slot
      return `<rect class="chart-hit" x="${x.toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${bottom - top}" data-index="${index}"><title>${escapeHtml(tooltipText(point, range))}</title></rect>`
    }).join("")
    return areas + lines + markers + hits
  }

  function renderChart(data: TrafficData, range: TrafficRange): void {
    const width = Math.max(200, chart.clientWidth || chart.parentElement?.clientWidth || 800)
    const height = Math.max(180, chart.clientHeight || 260)
    const left = width < 520 ? 64 : 70
    const right = width - 16
    const top = 18
    const bottom = height - 32
    const plotHeight = bottom - top
    const span = range.end - range.start
    const points = data.points
    const slot = Math.max(1, (right - left) / Math.max(1, points.length))
    const barWidth = Math.max(2, Math.min(34, slot * 0.66))
    let min = 0
    let max = 1
    if (view === "composition") {
      for (const point of points) {
        const segments = compositionSegments(point)
        max = Math.max(max, point.body, segments.uploaded + segments.reused + segments.other)
      }
    } else {
      for (const point of points) {
        min = Math.min(min, point.body - point.encoded)
        max = Math.max(max, point.body, point.encoded, point.reused, point.body - point.encoded)
      }
    }
    const scale = niceScale(min, max, 4)
    const y = (value: number) => bottom - (value - scale.min) / (scale.max - scale.min) * plotHeight
    const grid = scale.ticks.map((value) => {
      const position = y(value)
      return `<line class="chart-grid" x1="${left}" x2="${right}" y1="${position.toFixed(1)}" y2="${position.toFixed(1)}"/><text class="chart-axis" x="${left - 8}" y="${(position + 3).toFixed(1)}" text-anchor="end">${escapeHtml(bytes(value, 0))}</text>`
    }).join("")
    const zero = scale.min < 0 ? `<line class="chart-zero" x1="${left}" x2="${right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : ""
    const labels = axisIndices(points.length, width < 420 ? 4 : 6).map((index, position, all) => {
      const point = points[index]
      if (!point) return ""
      const x = position === 0 ? left : position === all.length - 1 ? right : left + (index + 0.5) * slot
      const anchor = position === 0 ? "start" : position === all.length - 1 ? "end" : "middle"
      return `<text class="chart-axis" x="${x.toFixed(1)}" y="${height - 12}" text-anchor="${anchor}">${escapeHtml(formatAxisLabel(point.at, span))}</text>`
    }).join("")
    const bars = view === "composition" ? drawComposition(data, range, left, top, bottom, slot, y, barWidth) : drawTrends(data, range, left, top, bottom, slot, y)
    const empty = data.totals.requests === 0 ? `<text class="chart-empty-label" x="${((left + right) / 2).toFixed(1)}" y="${((top + bottom) / 2).toFixed(1)}" text-anchor="middle">No finished requests in this range</text>` : ""
    const coverage = data.truncated && data.coverageStart !== null
      ? Math.max(0, Math.min(1, (data.coverageStart - range.start) / Math.max(1, range.end - range.start))) * (right - left)
      : 0
    const uncovered = coverage > 0
      ? `<rect class="chart-uncovered" x="${left}" y="${top}" width="${coverage.toFixed(1)}" height="${bottom - top}"/><line class="chart-coverage" x1="${(left + coverage).toFixed(1)}" x2="${(left + coverage).toFixed(1)}" y1="${top}" y2="${bottom}"/>`
      : ""
    const cursor = `<line class="chart-cursor" x1="0" x2="0" y1="${top}" y2="${bottom}" style="display:none"/><circle class="chart-cursor-dot" cx="0" cy="0" r="3" style="display:none"/>`
    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${uncovered}${grid}${zero}${bars}${labels}${cursor}${empty}</svg>`
    chart.setAttribute("data-view", view)
    const failed = data.totals.failed ? `, ${integer(data.totals.failed)} failed` : ""
    const cancelled = data.totals.cancelled ? `, ${integer(data.totals.cancelled)} cancelled` : ""
    const coverageText = data.truncated && data.coverageStart !== null ? ` Coverage starts ${formatDate(data.coverageStart)}.` : ""
    chart.setAttribute("aria-label", `${range.label}: ${integer(data.totals.requests)} requests${failed}${cancelled}, ${bytes(data.totals.body)} original bodies, ${bytes(data.totals.encoded)} uploaded, ${bytes(data.totals.saved)} bandwidth saved (${percentage(data.totals.reduction)}), ${bytes(data.totals.reused)} relay cache reuse (${percentage(data.totals.reuse)}). ${view === "composition" ? "Composition" : "Trends"} view.${coverageText}`)
    cursorLine = chart.querySelector<SVGLineElement>("line.chart-cursor")
    cursorDot = chart.querySelector<SVGCircleElement>("circle.chart-cursor-dot")
    layout = { left, right, top, bottom, slot, points, y }
    lastWidth = width
    hideTooltip()
  }

  function hideTooltip(): void {
    tooltip.hidden = true
    activeIndex = null
    if (cursorLine) cursorLine.style.display = "none"
    if (cursorDot) cursorDot.style.display = "none"
  }

  function showTooltip(index: number): void {
    if (!layout || !lastData || !lastRange) return
    const point = layout.points[index]
    if (!point) return
    activeIndex = index
    tooltip.innerHTML = tooltipHtml(point, lastRange)
    tooltip.hidden = false
    const width = tooltip.offsetWidth || 220
    const chartWidth = chart.clientWidth || chart.parentElement?.clientWidth || 800
    const x = layout.left + (index + 0.5) * layout.slot
    tooltip.style.left = `${Math.max(8, Math.min(chartWidth - width - 8, x - width / 2)).toFixed(1)}px`
    tooltip.style.top = "8px"
    if (cursorLine && cursorDot) {
      cursorLine.setAttribute("x1", x.toFixed(1))
      cursorLine.setAttribute("x2", x.toFixed(1))
      cursorLine.style.display = ""
      cursorDot.setAttribute("cx", x.toFixed(1))
      cursorDot.setAttribute("cy", layout.y(point.body).toFixed(1))
      cursorDot.style.display = ""
    }
  }

  function firstActiveIndex(): number {
    if (!layout) return -1
    const index = layout.points.findIndex((point) => point.requests > 0)
    return index >= 0 ? index : 0
  }

  function render(state: DashboardViewState): void {
    lastState = state
    if (!state.snapshot) {
      reset()
      return
    }
    const now = nowFor(state)
    syncCustomBounds(now, state)
    const resolved = resolveRange(state)
    if (!resolved.range) {
      reset("Choose a valid date range.")
      startInput.setAttribute("aria-invalid", "true")
      endInput.setAttribute("aria-invalid", "true")
      showNotice(resolved.error ?? "Choose a valid custom range.")
      return
    }
    startInput.removeAttribute("aria-invalid")
    endInput.removeAttribute("aria-invalid")
    const data = trafficData(state.snapshot, resolved.range)
    const previous = pointerInside ? activeIndex : null
    lastData = data
    lastRange = resolved.range
    updateSummary(data)
    renderChart(data, resolved.range)
    if (previous !== null) showTooltip(previous)
    updateNotice(data, state)
  }

  rangeSelect.addEventListener("change", () => {
    preset = rangeSelect.value as TrafficPreset
    if (preset === "custom") {
      custom.hidden = false
      const now = lastState ? nowFor(lastState) : Date.now()
      ensureCustomDefaults(now)
    } else {
      custom.hidden = true
      notice.hidden = true
    }
    syncUrl()
    if (lastState) render(lastState)
  })

  applyButton.addEventListener("click", () => {
    customStart = startInput.value
    customEnd = endInput.value
    preset = "custom"
    syncUrl()
    if (lastState) {
      render(lastState)
      if (startInput.getAttribute("aria-invalid") === "true") startInput.focus()
    }
  })

  for (const input of [startInput, endInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        applyButton.click()
      }
    })
  }

  function setView(next: TrafficView): void {
    view = next
    compositionButton.setAttribute("aria-pressed", String(next === "composition"))
    trendsButton.setAttribute("aria-pressed", String(next === "trends"))
    updateLegend()
    syncUrl()
    if (lastState) render(lastState)
  }

  compositionButton.addEventListener("click", () => setView("composition"))
  trendsButton.addEventListener("click", () => setView("trends"))

  function handlePointer(event: PointerEvent): void {
    if (!layout) return
    const rect = chart.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (x < layout.left || x > layout.right) {
      pointerInside = false
      hideTooltip()
      return
    }
    const index = Math.floor((x - layout.left) / layout.slot)
    if (index >= 0 && index < layout.points.length) {
      pointerInside = true
      showTooltip(index)
    } else {
      pointerInside = false
      hideTooltip()
    }
  }
  chart.addEventListener("pointermove", handlePointer)
  chart.addEventListener("pointerdown", handlePointer)
  chart.addEventListener("pointerleave", () => {
    pointerInside = false
    hideTooltip()
  })
  chart.addEventListener("focus", () => {
    const index = firstActiveIndex()
    if (index >= 0) showTooltip(index)
  })
  chart.addEventListener("blur", () => {
    pointerInside = false
    hideTooltip()
  })
  chart.addEventListener("keydown", (event) => {
    if (!layout) return
    const current = activeIndex ?? firstActiveIndex()
    let next = current
    if (event.key === "ArrowLeft") next = Math.max(0, current - 1)
    else if (event.key === "ArrowRight") next = Math.min(layout.points.length - 1, current + 1)
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = layout.points.length - 1
    else if (event.key === "Escape") {
      hideTooltip()
      return
    } else return
    event.preventDefault()
    showTooltip(next)
  })

  function resize(): void {
    if (!lastState || resizeFrame) return
    const schedule = viewWindow?.requestAnimationFrame?.bind(viewWindow) ?? ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16))
    resizeFrame = schedule(() => {
      resizeFrame = 0
      const width = chart.clientWidth || chart.parentElement?.clientWidth || 800
      if (width !== lastWidth && lastState) render(lastState)
    }) as unknown as number
  }

  const ResizeObserverCtor = (viewWindow as unknown as { ResizeObserver?: typeof ResizeObserver } | null)?.ResizeObserver
  if (ResizeObserverCtor) {
    observer = new ResizeObserverCtor(resize)
    observer.observe(chart)
  } else if (viewWindow) {
    windowResize = resize
    viewWindow.addEventListener("resize", windowResize)
  }

  rangeSelect.value = preset
  custom.hidden = preset !== "custom"
  compositionButton.setAttribute("aria-pressed", String(view === "composition"))
  trendsButton.setAttribute("aria-pressed", String(view === "trends"))
  if (preset === "custom") ensureCustomDefaults(Date.now())
  syncUrl()
  updateLegend()
  reset()

  return {
    render,
    destroy() {
      observer?.disconnect()
      observer = null
      if (viewWindow && windowResize) viewWindow.removeEventListener("resize", windowResize)
      if (viewWindow?.cancelAnimationFrame && resizeFrame) viewWindow.cancelAnimationFrame(resizeFrame)
      pointerInside = false
      hideTooltip()
    },
  }
}
