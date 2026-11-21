import type { DashboardViewState } from "../../lib/state.js"
import type { Snapshot } from "../../lib/types.js"
import { compactTokens, fetchUsage, tokenNumber, usageFromSnapshot, usageParams, type UsageFilter, type UsageReport } from "../../lib/usage.js"
import { requiredById } from "../dom.js"
import { mountOverviewRange } from "./overview-range.js"

export interface UsageScope {
  render(state: DashboardViewState): void
  report(): UsageReport | null
  ready(): boolean
  destroy(): void
}

// The usage summary and the sessions table share one local report. The summary
// owns the time-range scope; the table and dialog only read its result.
export function mountUsageScope(root: HTMLElement, onChange: () => void): UsageScope {
  const get = <T extends HTMLElement>(id: string) => requiredById<T>(root, id)
  let state: DashboardViewState | null = null
  let filter: UsageFilter = {}
  let signature = ""
  let reportSignature = ""
  let report: UsageReport | null = null
  let revision: Snapshot | null = null
  let loading = false
  let error = ""
  let destroyed = false
  let controller: AbortController | null = null
  const range = mountOverviewRange(get("overview-range"), () => { revision = null; refreshSelection() })

  function boundary(at: number): string {
    const date = new Date(at)
    if (date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0) return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
    return date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", ...(date.getSeconds() ? { second: "2-digit" } : {}) })
  }

  function refreshSelection() {
    if (!state?.snapshot) return
    const selectedRange = range.render(state.snapshot)
    filter = { start: selectedRange.start, end: selectedRange.end, host: state.host }
    signature = usageParams(filter).toString()
    get("usage-period-caption").textContent = `${selectedRange.label} · ${boundary(selectedRange.start)} → ${boundary(selectedRange.end)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone} · Local request-start time; start included, end excluded.`
    for (const format of ["csv", "json"]) {
      get<HTMLAnchorElement>(`usage-export-${format}`).href = `/api/dashboard/usage/export?${usageParams(filter)}&format=${format}`
    }
    if (revision === state.snapshot && reportSignature === signature) return
    void load()
  }

  async function load() {
    if (!state?.snapshot) return
    const snapshot = state.snapshot
    const requestedSignature = signature
    const requestedFilter = { ...filter }
    controller?.abort()
    const nextController = new AbortController()
    controller = nextController
    revision = snapshot
    loading = true
    error = ""
    if (!snapshot.requests_paged) {
      report = usageFromSnapshot(snapshot, requestedFilter)
      reportSignature = requestedSignature
      loading = false
      draw()
      onChange()
      return
    }
    try {
      const next = await fetchUsage(requestedFilter, AbortSignal.any([nextController.signal, AbortSignal.timeout(7000)]))
      if (destroyed || nextController !== controller) return
      report = next
      reportSignature = requestedSignature
    } catch (cause) {
      if (destroyed || nextController !== controller) return
      error = cause instanceof Error ? cause.message : "Local usage is unavailable."
    } finally {
      if (!destroyed && nextController === controller) {
        loading = false
        // Remember a failed revision too; retry on the next snapshot or Refresh,
        // not on every synchronous render.
        draw()
        onChange()
      }
    }
  }

  function text(id: string, value: string) {
    const element = get(id)
    if (element.textContent !== value) element.textContent = value
  }

  function draw() {
    const ready = report !== null && reportSignature === signature
    get("usage-summary").setAttribute("aria-busy", String(!ready && loading))
    const notice = get("usage-notice")
    notice.hidden = !error && !report?.incomplete_history
    notice.textContent = error ? `${error}${report ? " Showing the last successfully loaded period; values may be stale." : ""}` : report?.incomplete_history ? "Older history contains missing request records. These totals cover retained observations only." : ""
    if (!report) {
      text("usage-coverage", error ? "Measurements unavailable" : "Loading local usage…")
      return
    }
    const m = report.metrics
    text("usage-requests", tokenNumber(report.requests))
    text("usage-sessions", tokenNumber(report.session_count))
    text("usage-unattributed", report.unattributed_requests ? `${tokenNumber(report.unattributed_requests)} requests without a session ID` : "Distinct session IDs")
    text("usage-input", compactTokens(m.input_tokens))
    text("usage-output", compactTokens(m.output_tokens))
    get("usage-input").title = tokenNumber(m.input_tokens)
    get("usage-output").title = tokenNumber(m.output_tokens)
    text("usage-input-coverage", m.input_requests ? `Reported for ${tokenNumber(m.input_requests)} / ${tokenNumber(report.requests)} requests` : "No reported measurements")
    text("usage-output-coverage", m.output_requests ? `Reported for ${tokenNumber(m.output_requests)} / ${tokenNumber(report.requests)} requests` : "No reported measurements")
    text("usage-coverage", !ready ? `${loading ? "Loading selected period…" : "Selected scope unavailable."} Showing previous measurements.` : report.requests === 0 ? "No requests match the selected period." : `${tokenNumber(m.measured_requests)} of ${tokenNumber(report.requests)} requests with token data · ${tokenNumber(m.complete_requests)} complete${report.unknown_key_requests ? ` · ${tokenNumber(report.unknown_key_requests)} unattributed request${report.unknown_key_requests === 1 ? "" : "s"}` : ""}${loading ? " · Refreshing…" : ""}`)
  }

  return {
    render(next: DashboardViewState) {
      state = next
      if (state.snapshot && (revision !== state.snapshot || !signature || filter.host !== state.host)) refreshSelection()
      draw()
    },
    report: () => report,
    ready: () => report !== null && reportSignature === signature,
    destroy() { destroyed = true; controller?.abort(); range.destroy() },
  }
}
