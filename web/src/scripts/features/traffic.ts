import { escapeHtml } from "../../lib/html.js"
import { bytes, trafficBuckets } from "../../lib/metrics.js"
import type { DashboardViewState } from "../../lib/state.js"
import { requiredById } from "../dom.js"

export interface TrafficFeature {
  render(state: DashboardViewState): void
}

export function mountTraffic(root: HTMLElement): TrafficFeature {
  const range = requiredById<HTMLSelectElement>(root, "chart-range")
  const chart = requiredById(root, "traffic-chart")
  const initialChart = chart.innerHTML
  const integer = (value: number) => value.toLocaleString()
  const setText = (id: string, value: string | number) => { requiredById(root, id).textContent = String(value) }
  let lastState: DashboardViewState | null = null

  function renderChart(state: DashboardViewState) {
    lastState = state
    if (!state.snapshot) {
      setText("chart-original", "—")
      setText("chart-encoded", "—")
      setText("chart-count", "0 requests in this window")
      chart.innerHTML = initialChart
      chart.setAttribute("aria-label", "Upload traffic chart awaiting data")
      return
    }
    const data = state.snapshot
    const hours = Number(range.value)
    const buckets = trafficBuckets(data.history.recent_requests, hours, Date.parse(data.collected_at))
    const original = buckets.reduce((sum, bucket) => sum + bucket.body, 0)
    const encoded = buckets.reduce((sum, bucket) => sum + bucket.encoded, 0)
    const requests = buckets.reduce((sum, bucket) => sum + bucket.requests, 0)
    setText("chart-original", bytes(original))
    setText("chart-encoded", bytes(encoded))
    setText("chart-count", `${integer(requests)} requests in this window`)
    chart.setAttribute("aria-label", `Last ${hours} hours of retained, finished requests: ${bytes(original)} original bodies, ${bytes(encoded)} encoded uploads, ${requests} requests.`)
    const max = Math.max(...buckets.flatMap((bucket) => [bucket.body, bucket.encoded]), 1024)
    const left = 62, right = 778, top = 17, bottom = 178
    const x = (index: number) => left + index * (right - left) / (buckets.length - 1)
    const y = (value: number) => bottom - value / max * (bottom - top)
    const points = (key: "body" | "encoded") => buckets.map((bucket, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(bucket[key]).toFixed(1)}`).join(" ")
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = max * (4 - index) / 4
      return `<line class="chart-grid" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${left - 10}" y="${y(value) + 3}" text-anchor="end">${escapeHtml(bytes(value, 0))}</text>`
    }).join("")
    const labels = buckets.filter((_, index) => index % 5 === 0 || index === buckets.length - 1).map((bucket) => {
      const index = buckets.indexOf(bucket)
      const date = new Date(bucket.at)
      const label = hours > 24 ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
      return `<text class="chart-axis" x="${x(index)}" y="206" text-anchor="${index === 0 ? "start" : index === 23 ? "end" : "middle"}">${escapeHtml(label)}</text>`
    }).join("")
    const dots = buckets.filter((bucket) => bucket.requests > 0).map((bucket) => `<circle class="chart-upload-dot" cx="${x(buckets.indexOf(bucket))}" cy="${y(bucket.encoded)}" r="3"><title>${escapeHtml(new Date(bucket.at).toLocaleString())}: ${bucket.requests} requests · ${escapeHtml(bytes(bucket.body))} original → ${escapeHtml(bytes(bucket.encoded))} uploaded</title></circle>`).join("")
    chart.innerHTML = `<svg viewBox="0 0 800 220" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="body-fill" x1="0" x2="0" y1="0" y2="1"><stop class="chart-body-stop" offset="0%" stop-opacity=".13"/><stop class="chart-body-stop" offset="100%" stop-opacity="0"/></linearGradient><linearGradient id="upload-fill" x1="0" x2="0" y1="0" y2="1"><stop class="chart-upload-stop" offset="0%" stop-opacity=".18"/><stop class="chart-upload-stop" offset="100%" stop-opacity=".02"/></linearGradient></defs>${grid}<path d="${points("body")} L${right},${bottom} L${left},${bottom} Z" fill="url(#body-fill)"/><path d="${points("encoded")} L${right},${bottom} L${left},${bottom} Z" fill="url(#upload-fill)"/><path class="chart-body" d="${points("body")}"/><path class="chart-upload" d="${points("encoded")}"/>${dots}${labels}${requests === 0 ? '<text class="chart-empty-label" x="420" y="95" text-anchor="middle">No finished requests in this window</text>' : ""}</svg>`
  }

  range.addEventListener("change", () => {
    if (lastState) renderChart(lastState)
  })

  return { render: renderChart }
}
