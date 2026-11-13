import { bytes, historyHosts, historyTotals, percentage, savings, sessionHost, trackedSessionCount } from "../../lib/metrics.js"
import { dataValue } from "../../lib/presentation.js"
import type { DashboardViewState } from "../../lib/state.js"
import { requiredById } from "../dom.js"

export interface StatsFeature {
  render(state: DashboardViewState): void
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

  function renderStats({ snapshot, host }: DashboardViewState) {
    if (!snapshot) {
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
    const totals = historyTotals(snapshot, host)
    const reduction = savings(totals.body_bytes, totals.encoded_upload_bytes)
    setText("stat-reduction", percentage(reduction))
    requiredById(root, "stat-reduction").classList.toggle("negative", reduction !== null && reduction < 0)
    setMeter(reduction)
    const saved = totals.body_bytes - totals.encoded_upload_bytes
    setText("stat-saved", bytes(saved))
    requiredById(root, "stat-saved").classList.toggle("negative", saved < 0)
    requiredById(root, "stat-saved-foot").innerHTML = `${dataValue(bytes(totals.encoded_upload_bytes))} sent of ${dataValue(bytes(totals.body_bytes))} original`
    const activeSessions = snapshot.history.sessions.filter((session) => (!host || sessionHost(session) === host) && session.active > 0).length
    setText("stat-sessions", integer(trackedSessionCount(snapshot, host)))
    const scope = host ? `${dataValue(host)} · retained history` : `${dataValue(`${historyHosts(snapshot).length} hosts`)} · retained history`
    requiredById(root, "stat-sessions-foot").innerHTML = `${dataValue(activeSessions)} active · ${snapshot.history.evicted_sessions ? `${dataValue(integer(snapshot.history.evicted_sessions))} older evicted` : scope}`
    requiredById<HTMLElement>(root, "active-session-dot").style.opacity = activeSessions ? "1" : ".3"
    setText("stat-requests", integer(totals.requests))
    const legacy = totals.legacy ?? 0
    const legacyText = legacy ? ` · ${dataValue(integer(legacy))} legacy` : ""
    requiredById(root, "stat-requests-foot").innerHTML = `${dataValue(totals.active)} running · <span class="kpi-warn">${dataValue(integer(totals.failed))} failed</span>${legacyText} · ${dataValue(integer(totals.cancelled))} cancelled`
    if (legacy) {
      const currentHost = snapshot.history.host ?? ""
      const currentFailed = currentHost ? historyTotals(snapshot, currentHost).failed : totals.failed
      const historicalFailed = Math.max(0, totals.failed - currentFailed)
      const hostNote = currentHost ? ` Current host ${currentHost}: ${integer(currentFailed)} failed.` : ""
      const historicalNote = historicalFailed ? ` Historical hosts: ${integer(historicalFailed)} failed.` : ""
      statsNote.hidden = false
      statsNote.textContent = `${integer(legacy)} legacy requests predate final-state reconciliation; their outcome is unknown, so they are not counted as failures or cancellations.${hostNote}${historicalNote}`
    } else {
      statsNote.hidden = true
      statsNote.textContent = ""
    }
  }

  return { render: renderStats }
}
