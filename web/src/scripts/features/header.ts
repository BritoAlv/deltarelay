import { requiredById } from "../dom.js"

export interface HeaderView {
  label: string
  updatedAt: string
  paused: boolean
  stale: boolean
  busy?: boolean
  notice?: string | null
  host?: string
  hosts?: string[]
}

export interface HeaderOptions {
  doc: Document
  refreshNote: string
  onRefresh: () => void
  onPauseToggle: () => void
  onHostChange?: (host: string) => void
}

export interface HeaderFeature {
  render(view: HeaderView): void
}

const playIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m8 5 12 7-12 7V5z"/></svg>'

// Shared heading controls for dashboard-backed and supervisor-backed pages.
// Each page has one header and one poller, so pausing or refreshing never
// reaches another page's schedule.
export function mountHeader({ doc, refreshNote, onRefresh, onPauseToggle, onHostChange }: HeaderOptions): HeaderFeature {
  const refreshButton = requiredById<HTMLButtonElement>(doc, "refresh-button")
  const pauseButton = requiredById<HTMLButtonElement>(doc, "pause-button")
  const pauseIcon = pauseButton.innerHTML
  const connectionBadge = requiredById(doc, "connection-badge")
  const connectionLabel = requiredById(doc, "connection-label")
  const updatedAt = requiredById(doc, "updated-at")
  const refreshNoteElement = requiredById(doc, "refresh-note")
  const notice = requiredById<HTMLElement>(doc, "notice")
  const hostFilter = doc.getElementById("host-filter") as HTMLSelectElement | null
  let hostSignature = ""

  refreshButton.addEventListener("click", onRefresh)
  pauseButton.addEventListener("click", onPauseToggle)
  hostFilter?.addEventListener("change", () => onHostChange?.(hostFilter.value))

  function renderHosts(hosts: string[], host: string): void {
    if (!hostFilter) return
    const signature = hosts.join("\u0000")
    if (signature !== hostSignature) {
      hostSignature = signature
      const options = [doc.createElement("option")]
      options[0]!.value = ""
      options[0]!.textContent = "All hosts"
      for (const name of hosts) {
        const option = doc.createElement("option")
        option.value = name
        option.textContent = name
        options.push(option)
      }
      hostFilter.replaceChildren(...options)
    }
    hostFilter.disabled = hosts.length === 0
    hostFilter.value = hosts.includes(host) ? host : ""
  }

  return {
    render({ label, updatedAt: timestamp, paused, stale, busy = false, notice: message = null, host = "", hosts = [] }) {
      renderHosts(hosts, host)
      refreshButton.disabled = busy
      refreshButton.setAttribute("aria-busy", String(busy))
      connectionBadge.classList.toggle("stale", stale || paused)
      connectionBadge.classList.toggle("connecting", label === "Connecting…")
      if (connectionLabel.textContent !== label) connectionLabel.textContent = label
      if (updatedAt.textContent !== timestamp) updatedAt.textContent = timestamp
      const note = paused ? "Automatic refresh paused" : refreshNote
      if (refreshNoteElement.textContent !== note) refreshNoteElement.textContent = note
      pauseButton.setAttribute("aria-label", paused ? "Resume automatic refresh" : "Pause automatic refresh")
      pauseButton.title = paused ? "Resume automatic refresh" : "Pause automatic refresh"
      pauseButton.setAttribute("aria-pressed", String(paused))
      pauseButton.innerHTML = paused ? playIcon : pauseIcon
      const wasHidden = notice.hidden
      notice.hidden = !message
      if (message && (wasHidden || notice.textContent !== message)) notice.textContent = message
    },
  }
}
