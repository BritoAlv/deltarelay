import { bytes, percentage, relativeTime, savings } from "../../lib/metrics.js"
import { observationConnection, type DashboardViewState } from "../../lib/state.js"
import { requiredById } from "../dom.js"

export interface OverviewOptions {
  root: HTMLElement
  navCount: HTMLElement
  notes: HTMLElement
  onRefresh: () => void
  onPauseToggle: () => void
}

export interface OverviewFeature {
  render(state: DashboardViewState): void
}

const emptyStatIds = ["stat-reduction", "stat-saved", "stat-sessions", "stat-requests", "reuse-value", "reuse-bytes", "uploaded-bytes", "chart-original", "chart-encoded"]

export function mountOverview({ root, navCount, notes, onRefresh, onPauseToggle }: OverviewOptions): OverviewFeature {
  const refreshButton = requiredById<HTMLButtonElement>(root, "refresh-button")
  const pauseButton = requiredById<HTMLButtonElement>(root, "pause-button")
  const pauseIcon = pauseButton.innerHTML
  const connectionBadge = requiredById(root, "connection-badge")
  const connectionLabel = requiredById(root, "connection-label")
  const updatedAt = requiredById(root, "updated-at")
  const refreshNote = requiredById(root, "refresh-note")
  const notice = requiredById<HTMLElement>(root, "notice")
  const reuseRing = requiredById<SVGCircleElement>(root, "reuse-ring")
  const retentionNote = requiredById(notes, "retention-note")
  const integer = (value: number) => value.toLocaleString()

  refreshButton.addEventListener("click", onRefresh)
  pauseButton.addEventListener("click", onPauseToggle)

  const setText = (id: string, value: string | number) => { requiredById(root, id).textContent = String(value) }

  function renderConnection(state: DashboardViewState) {
    const { snapshot, stale, paused } = state
    const connection = observationConnection(state.system)
    refreshButton.disabled = state.busy
    connectionBadge.classList.toggle("stale", stale || paused)
    setText("connection-label", stale ? "Disconnected" : snapshot ? paused ? "Paused" : "Live" : "Connecting")
    setText("updated-at", snapshot ? `Updated ${relativeTime(snapshot.collected_at)}` : "Waiting for local gateway")
    setText("refresh-note", paused ? "Automatic refresh paused" : "Auto-refresh every 10s")
    pauseButton.setAttribute("aria-label", paused ? "Resume automatic refresh" : "Pause automatic refresh")
    pauseButton.title = paused ? "Resume automatic refresh" : "Pause automatic refresh"
    pauseButton.setAttribute("aria-pressed", String(paused))
    pauseButton.innerHTML = paused ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m8 5 12 7-12 7V5z"/></svg>' : pauseIcon
    notice.hidden = false
    if (state.error) notice.textContent = `${state.error}${snapshot ? " Showing the last successful snapshot; system states below are stale." : ""}`
    else if (snapshot?.history.persistence_error) notice.textContent = "Statistics could not be saved to disk. Live observations still work, but new history may be lost on restart. Check permissions and free space for the gateway’s --stats-file."
    else if (snapshot && !snapshot.relay.reachable) notice.textContent = connection === "remote_stopped" ? "The remote host is stopped. Resume it using System controls or your hosting provider. Automatic reconnect and wake are off." : connection === "no_internet" ? "This computer has no internet connection, so the VPS health check cannot run. Check Wi-Fi, Ethernet, VPN, or the default route. There is no direct-provider fallback." : connection === "vps_unreachable" ? "Internet is reachable, but the VPS health check failed. Check the relay, VPN split routes, or SSH tunnel. There is no direct-provider fallback." : "The gateway is reachable, but its VPS health check failed. Check the relay, VPN, or SSH tunnel. There is no direct-provider fallback."
    else if (snapshot && !snapshot.history.persistent) notice.textContent = "History is in-memory only. Set the gateway’s --stats-file to retain session statistics across restarts."
    else notice.hidden = true
  }

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
      navCount.textContent = "—"
      reuseRing.style.strokeDashoffset = "414.69"
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
    setText("stat-requests-foot", `${totals.active} running · ${integer(totals.failed)} unsuccessful`)
    navCount.textContent = String(snapshot.history.sessions.length)
    const reuse = totals.body_bytes > 0 ? totals.reused_body_bytes / totals.body_bytes * 100 : null
    setText("reuse-value", percentage(reuse))
    setText("reuse-bytes", bytes(totals.reused_body_bytes))
    setText("uploaded-bytes", bytes(totals.uploaded_chunk_bytes))
    reuseRing.style.strokeDashoffset = String(414.69 * (1 - Math.max(0, Math.min(100, reuse ?? 0)) / 100))
    retentionNote.textContent = `History since ${new Date(snapshot.history.since).toLocaleString()}. Keeps up to ${snapshot.history.session_limit} sessions and ${integer(snapshot.history.request_limit)} requests. ${integer(snapshot.history.evicted_sessions)} older sessions and ${integer(snapshot.history.dropped_requests)} request entries trimmed; global totals are preserved. Session totals restart if an evicted session reappears. Earlier history is not imported from logs. ${snapshot.history.persistent ? "History is saved privately on the gateway." : "History is in memory only."}`
  }

  return {
    render(state) {
      renderConnection(state)
      renderStats(state)
    },
  }
}
