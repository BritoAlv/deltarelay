import { bytes, percentage } from "../../lib/metrics.js"
import type { OverviewData } from "../../lib/overview.js"
import { dataValue } from "../../lib/presentation.js"
import type { DashboardViewState } from "../../lib/state.js"
import { requiredById } from "../dom.js"

export interface StatsFeature {
  render(state: DashboardViewState, overview: OverviewData | null): void
}

const emptyStatIds = ["stat-reduction", "stat-saved", "stat-sessions", "stat-requests"]
const integer = (value: number) => value.toLocaleString()

export function mountStats(root: HTMLElement): StatsFeature {
  const setText = (id: string, value: string | number) => { requiredById(root, id).textContent = String(value) }
  const meterSaved = requiredById<HTMLElement>(root, "stat-meter-saved")
  const meterSent = requiredById<HTMLElement>(root, "stat-meter-sent")
  const statsNote = requiredById<HTMLElement>(root.ownerDocument, "stats-note")
  const setMeter = (reduction: number | null) => {
    const saved = reduction === null ? 0 : Math.max(0, Math.min(100, reduction))
    meterSaved.style.width = `${saved}%`
    meterSent.style.width = `${100 - saved}%`
  }

  function renderStats({ snapshot }: DashboardViewState, overview: OverviewData | null) {
    if (!snapshot || !overview) {
      // Never leave stale numbers on screen after the gateway disconnects.
      for (const id of emptyStatIds) {
        setText(id, "—")
        requiredById(root, id).classList.remove("negative")
      }
      setText("stat-saved-foot", "No data")
      setText("stat-sessions-foot", "No data")
      setText("stat-requests-foot", "No data")
      statsNote.hidden = true
      statsNote.textContent = ""
      setMeter(null)
      return
    }
    const totals = overview.traffic.totals
    const reduction = totals.reduction
    setText("stat-reduction", percentage(reduction))
    requiredById(root, "stat-reduction").classList.toggle("negative", reduction !== null && reduction < 0)
    setMeter(reduction)
    const saved = totals.saved
    setText("stat-saved", bytes(saved))
    requiredById(root, "stat-saved").classList.toggle("negative", saved < 0)
    requiredById(root, "stat-saved-foot").innerHTML = `${dataValue(bytes(totals.encoded))} sent of ${dataValue(bytes(totals.body))} original`
    const activeSessions = overview.activeSessions
    setText("stat-sessions", integer(overview.sessions))
    requiredById(root, "stat-sessions-foot").innerHTML = `${dataValue(activeSessions)} active now · ${overview.incompleteSessions ? "retained requests only" : "in selected period"}`
    requiredById<HTMLElement>(root, "active-session-dot").style.opacity = activeSessions ? "1" : ".3"
    setText("stat-requests", integer(totals.requests + overview.running))
    const legacy = snapshot.history.totals.legacy ?? 0
    requiredById(root, "stat-requests-foot").innerHTML = `${dataValue(overview.running)} running now · <span class="kpi-warn">${dataValue(integer(totals.failed))} failed</span> · ${dataValue(integer(totals.cancelled))} cancelled`
    if (legacy) {
      statsNote.hidden = false
      statsNote.textContent = `Retained history contains ${integer(legacy)} legacy requests with unknown outcomes. These lifetime counts cannot be assigned to the selected period; older traffic records may predate outcome reconciliation.`
    } else {
      statsNote.hidden = true
      statsNote.textContent = ""
    }
  }

  return { render: renderStats }
}
