import { bytes, percentage, savings } from "../../lib/metrics.js"
import type { DashboardViewState } from "../../lib/state.js"
import { requiredById } from "../dom.js"

export interface StatsFeature {
  render(state: DashboardViewState): void
}

const emptyStatIds = ["stat-reduction", "stat-saved", "stat-sessions", "stat-requests"]
const integer = (value: number) => value.toLocaleString()

export function mountStats(root: HTMLElement): StatsFeature {
  const setText = (id: string, value: string | number) => { requiredById(root, id).textContent = String(value) }

  function renderStats({ snapshot }: DashboardViewState) {
    if (!snapshot) {
      // Never leave stale numbers on screen after the gateway disconnects.
      for (const id of emptyStatIds) {
        setText(id, "—")
        requiredById(root, id).classList.remove("negative")
      }
      setText("stat-saved-foot", "No data")
      setText("stat-sessions-foot", "No data")
      setText("stat-requests-foot", "No data")
      return
    }
    const totals = snapshot.history.totals
    const reduction = savings(totals.body_bytes, totals.encoded_upload_bytes)
    setText("stat-reduction", percentage(reduction))
    requiredById(root, "stat-reduction").classList.toggle("negative", reduction !== null && reduction < 0)
    const saved = totals.body_bytes - totals.encoded_upload_bytes
    setText("stat-saved", bytes(saved))
    requiredById(root, "stat-saved").classList.toggle("negative", saved < 0)
    setText("stat-saved-foot", `${bytes(totals.encoded_upload_bytes)} sent of ${bytes(totals.body_bytes)} original`)
    const activeSessions = snapshot.history.sessions.filter((session) => session.active > 0).length
    setText("stat-sessions", integer(snapshot.history.sessions.length))
    setText("stat-sessions-foot", `${activeSessions} active · ${snapshot.history.evicted_sessions ? `${integer(snapshot.history.evicted_sessions)} older evicted` : "retained history"}`)
    requiredById<HTMLElement>(root, "active-session-dot").style.opacity = activeSessions ? "1" : ".3"
    setText("stat-requests", integer(totals.requests))
    setText("stat-requests-foot", `${totals.active} running · ${integer(totals.failed)} failed · ${integer(totals.cancelled)} cancelled`)
  }

  return { render: renderStats }
}
