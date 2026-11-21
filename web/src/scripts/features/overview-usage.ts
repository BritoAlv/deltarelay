import { escapeHtml } from "../../lib/html.js"
import { loadingIndicator } from "../../lib/presentation.js"
import { formatAxisLabel, formatBucketWindow, niceScale, type TrafficRange } from "../../lib/traffic.js"
import {
  compactTokens,
  fetchUsage,
  usageFromSnapshot,
  type UsageMetric,
  type UsageReport,
  type UsageSeries,
  type UsageSeriesModel,
  type UsageSeriesPoint,
} from "../../lib/usage.js"
import type { Snapshot } from "../../lib/types.js"

interface UsageSegment {
  model: string
  total: number
  input: number | null
  output: number | null
  requests: number
  yTop: number
  yBottom: number
}

interface UsagePointLayout {
  point: UsageSeriesPoint
  segments: UsageSegment[]
}

interface UsageChartLayout {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
  slot: number
  points: UsagePointLayout[]
  visible: UsageSeriesModel[]
  y: (value: number) => number
}

export function mountOverviewUsage(root: HTMLElement) {
  const chart = root.querySelector<HTMLElement>("#usage-overview-chart")!
  const tooltip = root.querySelector<HTMLElement>("#usage-overview-tooltip")!
  const legend = root.querySelector<HTMLElement>("[data-usage-overview-legend]")!
  const metricButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-usage-metric]")]
  const text = (selector: string, value: string) => {
    const element = root.querySelector<HTMLElement>(selector)
    if (element && element.textContent !== value) element.textContent = value
  }
  let revision: Snapshot | null = null
  let signature = ""
  let controller: AbortController | null = null
  let destroyed = false
  let report: UsageReport | null = null
  let range: TrafficRange | null = null
  let metric: UsageMetric = "total"
  const hidden = new Set<string>()
  const modelSlots = new Map<string, number>()
  let layout: UsageChartLayout | null = null
  let activeIndex: number | null = null
  let lastWidth = 0
  let resizeFrame = 0
  let observer: ResizeObserver | null = null
  let windowResize: (() => void) | null = null
  const viewWindow = root.ownerDocument.defaultView

  function updateLink(): void {
    const link = root.querySelector<HTMLAnchorElement>("a")
    if (!link) return
    const params = new URLSearchParams(viewWindow?.location.search)
    params.set("usage_view", "usage")
    params.delete("host")
    params.delete("view")
    params.delete("usage_session")
    params.delete("session")
    params.set("key", "")
    link.href = `/sessions?${params}`
  }

  function modelValue(model: UsageSeriesModel | undefined, selected: UsageMetric): number {
    if (!model) return 0
    if (selected === "input") return model.input_tokens ?? 0
    if (selected === "output") return model.output_tokens ?? 0
    return (model.input_tokens ?? 0) + (model.output_tokens ?? 0)
  }

  function modelTotal(model: UsageSeriesModel): number {
    return (model.input_tokens ?? 0) + (model.output_tokens ?? 0)
  }

  function modelColor(model: string): string {
    if (model === "Other models") return "var(--chart-original)"
    return `var(--usage-model-${(modelSlots.get(model) ?? 0) + 1})`
  }

  function assignModelColors(series: UsageSeries): void {
    const assigned = new Map<string, number>()
    const used = new Set<number>()
    for (const model of series.models) {
      if (model.model === "Other models") continue
      const slot = modelSlots.get(model.model)
      if (slot !== undefined && !used.has(slot)) {
        assigned.set(model.model, slot)
        used.add(slot)
      }
    }
    let next = 0
    for (const model of series.models) {
      if (model.model === "Other models" || assigned.has(model.model)) continue
      while (next < 5 && used.has(next)) next++
      const slot = next < 5 ? next : 0
      used.add(slot)
      assigned.set(model.model, slot)
    }
    for (const [model, slot] of assigned) modelSlots.set(model, slot)
  }

  function renderLegend(series: UsageSeries | undefined): void {
    if (!series || series.models.length === 0) {
      legend.replaceChildren()
      return
    }
    const grand = series.models.reduce((sum, model) => sum + modelTotal(model), 0)
    legend.innerHTML = series.models.map((model) => {
      const total = modelTotal(model)
      const share = grand > 0 ? total / grand * 100 : 0
      return `<button type="button" class="usage-model-chip" data-usage-model="${escapeHtml(model.model)}" aria-pressed="${String(!hidden.has(model.model))}" title="${escapeHtml(model.model)}: ${escapeHtml(compactTokens(total))} tokens">
        <i style="background:${modelColor(model.model)}"></i><span class="usage-model-name" dir="auto">${escapeHtml(model.model)}</span><span class="usage-model-total">${escapeHtml(compactTokens(total))} · ${share.toFixed(1)}%</span>
      </button>`
    }).join("")
    legend.querySelectorAll<HTMLButtonElement>("[data-usage-model]").forEach((button) => {
      button.addEventListener("click", () => {
        const model = button.dataset.usageModel || ""
        if (hidden.has(model)) hidden.delete(model)
        else hidden.add(model)
        button.setAttribute("aria-pressed", String(!hidden.has(model)))
        drawChart()
      })
    })
  }

  function updateSummary(next: UsageReport): void {
    text("[data-usage-overview-input]", compactTokens(next.metrics.input_tokens))
    text("[data-usage-overview-output]", compactTokens(next.metrics.output_tokens))
    text("[data-usage-overview-context]", compactTokens(next.metrics.peak_context))
    text("[data-usage-overview-models]", next.series ? String(next.series.models.length) : "—")
    const coverage = next.requests === 0
      ? "No requests in this range · all credential labels · request-start time"
      : `${next.metrics.measured_requests.toLocaleString()} / ${next.requests.toLocaleString()} requests with token data · all credential labels · request-start time`
    text("[data-usage-overview-coverage]", coverage)
  }

  function showMessage(message: string, loading = false): void {
    chart.innerHTML = `<div class="chart-placeholder">${loading ? loadingIndicator(message) : escapeHtml(message)}</div>`
    chart.setAttribute("aria-busy", String(loading))
    chart.setAttribute("aria-label", message)
    tooltip.hidden = true
    layout = null
    activeIndex = null
  }

  function emptyChart(message: string): void {
    const width = 760
    const height = 220
    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true"><text class="usage-chart-empty" x="${width / 2}" y="${height / 2}" text-anchor="middle">${escapeHtml(message)}</text></svg>`
    chart.setAttribute("aria-busy", "false")
    chart.setAttribute("aria-label", message)
    tooltip.hidden = true
    layout = null
    activeIndex = null
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

  function tooltipHtml(point: UsageSeriesPoint, segment: UsageSegment | null): string {
    const current = report
    if (!range || !current?.series) return ""
    const at = Date.parse(point.start)
    const end = Math.min(range.end, at + current.series.bucket_ms)
    const time = formatBucketWindow(at, end, current.series.bucket_ms)
    if (point.requests === 0) {
      return `<div class="tooltip-time">${escapeHtml(time)}</div><p class="usage-tooltip-note">No requests in this bucket.</p>`
    }
    if (point.measured_requests === 0) {
      return `<div class="tooltip-time">${escapeHtml(time)}</div><dl><dt>Requests</dt><dd>${point.requests.toLocaleString()}</dd><dt>Measured</dt><dd>0</dd></dl><p class="usage-tooltip-note">No token measurements. This is a gap, not zero usage.</p>`
    }
    if (segment) {
      const metricNote = metric === "total" ? "" : `<p class="usage-tooltip-note">Bars show ${metric} tokens.</p>`
      return `<div class="tooltip-time">${escapeHtml(time)}</div><dl><dt>Model</dt><dd>${escapeHtml(segment.model)}</dd><dt>Total</dt><dd>${escapeHtml(compactTokens(segment.total))}</dd><dt>Input</dt><dd>${escapeHtml(compactTokens(segment.input))}</dd><dt>Output</dt><dd>${escapeHtml(compactTokens(segment.output))}</dd><dt>Model requests</dt><dd>${segment.requests.toLocaleString()}</dd><dt>Bucket coverage</dt><dd>${point.measured_requests.toLocaleString()} / ${point.requests.toLocaleString()}</dd></dl>${metricNote}`
    }
    const visible = layout?.visible ?? current.series.models
    let input = 0
    let output = 0
    for (const model of visible) {
      const entry = point.models.find((item) => item.model === model.model)
      input += entry?.input_tokens ?? 0
      output += entry?.output_tokens ?? 0
    }
    const hiddenCount = current.series.models.length - visible.length
    const hiddenNote = hiddenCount > 0 ? `<p class="usage-tooltip-note">${hiddenCount} hidden model label${hiddenCount === 1 ? "" : "s"} excluded from the chart.</p>` : ""
    const metricNote = metric === "total" ? "" : `<p class="usage-tooltip-note">Bars show ${metric} tokens.</p>`
    return `<div class="tooltip-time">${escapeHtml(time)}</div><dl><dt>Total</dt><dd>${escapeHtml(compactTokens(input + output))}</dd><dt>Input</dt><dd>${escapeHtml(compactTokens(input))}</dd><dt>Output</dt><dd>${escapeHtml(compactTokens(output))}</dd><dt>Requests</dt><dd>${point.measured_requests.toLocaleString()} / ${point.requests.toLocaleString()}</dd><dt>Peak context</dt><dd>${escapeHtml(compactTokens(point.peak_context))}</dd></dl>${hiddenNote}${metricNote}`
  }

  function highlight(model: string | null): void {
    const svg = chart.querySelector("svg")
    if (!svg) return
    svg.querySelectorAll<SVGRectElement>(".usage-model-segment").forEach((segment) => {
      segment.style.opacity = model && segment.dataset.model !== model ? ".32" : ""
    })
  }

  function showTooltip(index: number, segment: UsageSegment | null): void {
    if (!layout || !range) return
    const point = layout.points[index]
    if (!point) return
    activeIndex = index
    tooltip.innerHTML = tooltipHtml(point.point, segment)
    tooltip.hidden = false
    highlight(segment?.model ?? null)
    const width = tooltip.offsetWidth || 220
    const chartWidth = chart.clientWidth || layout.width
    const x = (layout.left + (index + 0.5) * layout.slot) / layout.width * chartWidth
    tooltip.style.left = `${Math.max(8, Math.min(chartWidth - width - 8, x - width / 2)).toFixed(1)}px`
    tooltip.style.top = "8px"
  }

  function hideTooltip(): void {
    tooltip.hidden = true
    activeIndex = null
    highlight(null)
  }

  function firstActiveIndex(): number {
    if (!layout) return -1
    const index = layout.points.findIndex((point) => point.point.requests > 0)
    return index >= 0 ? index : 0
  }

  function drawChart(): void {
    const current = report
    const series = current?.series
    if (!series || !range) {
      showMessage("Local token measurements unavailable; open Sessions to retry.")
      return
    }
    if (series.points.length === 0 || series.models.length === 0) {
      emptyChart("No token measurements in this range.")
      return
    }
    const visible = series.models.filter((model) => !hidden.has(model.model))
    if (visible.length === 0) {
      emptyChart("Select at least one model in the legend.")
      return
    }
    const width = Math.max(280, chart.clientWidth || chart.parentElement?.clientWidth || 760)
    const height = Math.max(190, chart.clientHeight || 238)
    const span = range.end - range.start
    const left = width < 520 ? 56 : 64
    const right = width - 16
    const top = 18
    const bottom = height - 34
    const plotHeight = bottom - top
    const points = series.points
    const slot = Math.max(1, (right - left) / Math.max(1, points.length))
    const barWidth = Math.max(4, Math.min(24, slot * 0.64))
    let max = 0
    for (const point of points) {
      let pointTotal = 0
      for (const model of visible) pointTotal += modelValue(point.models.find((entry) => entry.model === model.model), metric)
      max = Math.max(max, pointTotal)
    }
    const scale = niceScale(0, max, 4)
    const y = (value: number) => bottom - (value - scale.min) / (scale.max - scale.min || 1) * plotHeight
    const grid = scale.ticks.map((value) => `<line class="chart-grid" x1="${left}" x2="${right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text class="chart-axis" x="${left - 9}" y="${(y(value) + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(compactTokens(value))}</text>`).join("")
    const labels = axisIndices(points.length, width < 420 ? 4 : 7).map((index, position, all) => {
      const point = points[index]
      if (!point) return ""
      const at = Date.parse(point.start)
      if (!Number.isFinite(at)) return ""
      const x = position === 0 ? left : position === all.length - 1 ? right : left + (index + 0.5) * slot
      const anchor = position === 0 ? "start" : position === all.length - 1 ? "end" : "middle"
      return `<text class="chart-axis" x="${x.toFixed(1)}" y="${height - 12}" text-anchor="${anchor}">${escapeHtml(formatAxisLabel(at, span))}</text>`
    }).join("")
    const pointLayouts: UsagePointLayout[] = []
    const bars = points.map((point, index) => {
      const x = left + index * slot + (slot - barWidth) / 2
      const segments: UsageSegment[] = []
      if (point.requests === 0) {
        pointLayouts.push({ point, segments })
        return ""
      }
      if (point.measured_requests === 0) {
        pointLayouts.push({ point, segments })
        return `<rect class="usage-model-nodata" x="${x.toFixed(1)}" y="${(bottom - 7).toFixed(1)}" width="${barWidth.toFixed(1)}" height="7" rx="2"/>`
      }
      let cursor = y(0)
      const parts: string[] = []
      let drawn = 0
      for (const model of visible) {
        const entry = point.models.find((item) => item.model === model.model)
        const value = modelValue(entry, metric)
        if (value <= 0) continue
        const segmentHeight = Math.max(1, value / scale.max * plotHeight)
        const yTop = Math.max(top, cursor - segmentHeight)
        const heightPx = Math.max(1, cursor - yTop)
        segments.push({ model: model.model, total: (entry?.input_tokens ?? 0) + (entry?.output_tokens ?? 0), input: entry?.input_tokens ?? null, output: entry?.output_tokens ?? null, requests: entry?.requests ?? 0, yTop, yBottom: cursor })
        parts.push(`<rect class="usage-model-segment" data-model="${escapeHtml(model.model)}" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${heightPx.toFixed(1)}" fill="${modelColor(model.model)}" rx="1.5"/>`)
        cursor = yTop
        drawn++
      }
      if (drawn === 0) parts.push(`<rect class="usage-chart-unmeasured" x="${x.toFixed(1)}" y="${(bottom - 3).toFixed(1)}" width="${barWidth.toFixed(1)}" height="3" rx="1.5"/>`)
      pointLayouts.push({ point, segments })
      return parts.join("")
    }).join("")
    const empty = points.every((point) => point.measured_requests === 0)
      ? `<text class="usage-chart-empty-label" x="${((left + right) / 2).toFixed(1)}" y="${((top + bottom) / 2).toFixed(1)}" text-anchor="middle">No token measurements in this range</text>`
      : ""
    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs><pattern id="usage-overview-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="transparent"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--subtle)" stroke-width="1.2"/></pattern></defs>
      ${grid}<line class="chart-zero" x1="${left}" x2="${right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>${bars}${labels}${empty}
    </svg>`
    chart.setAttribute("aria-busy", "false")
    const labelsText = visible.map((model) => model.model).join(", ")
    chart.setAttribute("aria-label", `${range.label}: ${metric} tokens stacked by model (${labelsText}). ${current.metrics.measured_requests.toLocaleString()} of ${current.requests.toLocaleString()} requests measured.`)
    layout = { width, height, left, right, top, bottom, slot, points: pointLayouts, visible, y }
    lastWidth = width
    hideTooltip()
  }

  function drawReport(next: UsageReport, nextRange: TrafficRange): void {
    report = next
    range = nextRange
    if (next.series) assignModelColors(next.series)
    updateSummary(next)
    renderLegend(next.series)
    drawChart()
  }

  const schedule = viewWindow?.requestAnimationFrame?.bind(viewWindow) ?? ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16))

  chart.addEventListener("pointermove", (event) => {
    if (!layout) return
    const svg = chart.querySelector("svg")
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const scaleX = layout.width / (rect.width || layout.width)
    const scaleY = layout.height / (rect.height || layout.height)
    const x = (event.clientX - rect.left) * scaleX
    const vy = (event.clientY - rect.top) * scaleY
    if (x < layout.left || x > layout.right) {
      hideTooltip()
      return
    }
    const index = Math.max(0, Math.min(layout.points.length - 1, Math.floor((x - layout.left) / layout.slot)))
    const segment = layout.points[index]?.segments.find((entry) => vy >= entry.yTop && vy <= entry.yBottom) ?? null
    showTooltip(index, segment)
  })
  chart.addEventListener("pointerdown", (event) => {
    if (!layout) return
    const svg = chart.querySelector("svg")
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const x = (event.clientX - rect.left) * (layout.width / (rect.width || layout.width))
    const index = Math.max(0, Math.min(layout.points.length - 1, Math.floor((x - layout.left) / layout.slot)))
    showTooltip(index, null)
  })
  chart.addEventListener("pointerleave", () => {
    hideTooltip()
  })
  chart.addEventListener("focus", () => {
    const index = firstActiveIndex()
    if (index >= 0) showTooltip(index, null)
  })
  chart.addEventListener("blur", () => {
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
    showTooltip(next, null)
  })

  for (const button of metricButtons) {
    button.addEventListener("click", () => {
      metric = button.dataset.usageMetric === "input" ? "input" : button.dataset.usageMetric === "output" ? "output" : "total"
      for (const other of metricButtons) other.setAttribute("aria-pressed", String(other === button))
      drawChart()
    })
  }

  function resize(): void {
    if (resizeFrame || !report || !range) return
    resizeFrame = schedule(() => {
      resizeFrame = 0
      const width = chart.clientWidth || chart.parentElement?.clientWidth || 760
      if (width !== lastWidth && report && range) drawChart()
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

  return {
    render(snapshot: Snapshot | null, nextRange?: TrafficRange) {
      if (!snapshot || !nextRange) return
      updateLink()
      const nextSignature = `${nextRange.start}:${nextRange.end}:${nextRange.bucketMs}`
      if (revision === snapshot && signature === nextSignature) return
      const rangeChanged = signature !== nextSignature
      revision = snapshot
      signature = nextSignature
      controller?.abort()
      const currentController = new AbortController()
      controller = currentController
      const filter = { start: nextRange.start, end: nextRange.end, bucket: nextRange.bucketMs }
      if (!snapshot.requests_paged) {
        drawReport(usageFromSnapshot(snapshot, filter), nextRange)
        return
      }
      if (rangeChanged || !report) {
        if (rangeChanged) {
          report = null
          for (const selector of ["[data-usage-overview-input]", "[data-usage-overview-output]", "[data-usage-overview-context]", "[data-usage-overview-models]"]) text(selector, "—")
          legend.replaceChildren()
        }
        showMessage("Loading local token measurements…", true)
        text("[data-usage-overview-coverage]", "Loading local token measurements…")
      }
      void fetchUsage(filter, AbortSignal.any([currentController.signal, AbortSignal.timeout(7000)])).then((next) => {
        if (!destroyed && controller === currentController) drawReport(next, nextRange)
      }).catch(() => {
        if (destroyed || controller !== currentController) return
        if (report) {
          text("[data-usage-overview-coverage]", "Refresh failed; showing the previous measurements.")
        } else {
          showMessage("Local token measurements unavailable; open Sessions to retry.")
          text("[data-usage-overview-coverage]", "Local token measurements unavailable; open Sessions to retry.")
        }
      })
    },
    destroy() {
      destroyed = true
      controller?.abort()
      observer?.disconnect()
      observer = null
      if (viewWindow && windowResize) viewWindow.removeEventListener("resize", windowResize)
      if (viewWindow?.cancelAnimationFrame && resizeFrame) viewWindow.cancelAnimationFrame(resizeFrame)
      hideTooltip()
    },
  }
}
