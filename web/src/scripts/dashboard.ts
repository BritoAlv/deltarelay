import { fetchSnapshot } from "../lib/api.js"
import { bytes, duration, filterSessions, percentage, relativeTime, savings, sessionState, trafficBuckets } from "../lib/metrics.js"
import type { Session, Snapshot } from "../lib/types.js"
import type { ConnectionState } from "../lib/system.js"

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!value) throw new Error(`Missing dashboard element: ${id}`)
  return value as T
}

// Diagnostics are data, never markup. All strings rendered into templates go
// through this function (including opaque IDs, upstream names, and errors).
function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

const text = (id: string, value: string | number) => { element(id).textContent = String(value) }
const integer = (value: number) => value.toLocaleString()
const pill = (label: string, state: string) => `<span class="status-pill ${state}">${escape(label)}</span>`
const icons = [...document.querySelectorAll(".system-icon")].map((icon) => icon.innerHTML)
const initialSystemCards = element("system-cards").innerHTML
const initialChart = element("traffic-chart").innerHTML
const refreshButton = element<HTMLButtonElement>("refresh-button")
const pauseButton = element<HTMLButtonElement>("pause-button")
const pauseIcon = pauseButton.innerHTML
const dialog = element<HTMLDialogElement>("session-dialog")
const pageSize = 8

let snapshot: Snapshot | null = null
let paused = false
let stale = false
let busy = false
let page = 1
let selectedSession: string | null = null
let generation = 0
let lastError = ""
let networkConnection: ConnectionState = "unknown"

document.addEventListener("deltarelay:system", (event) => {
  const value = (event as CustomEvent).detail?.connection
  const next = value === "connected" || value === "codespace_stopped" || value === "no_internet" || value === "vps_unreachable" ? value : "unknown"
  if (next === networkConnection) return
  networkConnection = next
  render()
})

function renderConnection() {
  const badge = element("connection-badge")
  badge.classList.toggle("stale", stale || paused)
  text("connection-label", stale ? "Disconnected" : snapshot ? paused ? "Paused" : "Live" : "Connecting")
  text("updated-at", snapshot ? `Updated ${relativeTime(snapshot.collected_at)}` : "Waiting for local gateway")
  text("refresh-note", paused ? "Automatic refresh paused" : "Auto-refresh every 10s")
  pauseButton.setAttribute("aria-label", paused ? "Resume automatic refresh" : "Pause automatic refresh")
  pauseButton.title = paused ? "Resume automatic refresh" : "Pause automatic refresh"
  pauseButton.setAttribute("aria-pressed", String(paused))
  pauseButton.innerHTML = paused ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m8 5 12 7-12 7V5z"/></svg>' : pauseIcon
  const notice = element("notice")
  notice.hidden = false
  if (lastError) notice.textContent = `${lastError}${snapshot ? " Showing the last successful snapshot; system states below are stale." : ""}`
  else if (snapshot?.history.persistence_error) notice.textContent = "Statistics could not be saved to disk. Live observations still work, but new history may be lost on restart. Check permissions and free space for the gateway’s --stats-file."
  else if (snapshot && !snapshot.relay.reachable) notice.textContent = networkConnection === "codespace_stopped" ? "The Codespace is stopped. Use Wake Codespace in System controls to resume. Automatic reconnect and wake are off." : networkConnection === "no_internet" ? "This computer has no internet connection, so the VPS health check cannot run. Check Wi-Fi, Ethernet, VPN, or the default route. There is no direct-provider fallback." : networkConnection === "vps_unreachable" ? "Internet is reachable, but the VPS health check failed. Check the relay, VPN split routes, or SSH tunnel. There is no direct-provider fallback." : "The gateway is reachable, but its VPS health check failed. Check the relay, VPN, or SSH tunnel. There is no direct-provider fallback."
  else if (snapshot && !snapshot.history.persistent) notice.textContent = "History is in-memory only. Set the gateway’s --stats-file to retain session statistics across restarts."
  else notice.hidden = true
}

function renderStats(data: Snapshot) {
  const totals = data.history.totals
  const reduction = savings(totals.body_bytes, totals.encoded_upload_bytes)
  text("stat-reduction", percentage(reduction))
  element("stat-reduction").classList.toggle("negative", reduction !== null && reduction < 0)
  const saved = totals.body_bytes - totals.encoded_upload_bytes
  text("stat-saved", bytes(saved))
  element("stat-saved").classList.toggle("negative", saved < 0)
  text("stat-saved-foot", `${bytes(totals.encoded_upload_bytes)} sent of ${bytes(totals.body_bytes)} original`)
  const activeSessions = data.history.sessions.filter((s) => s.active > 0).length
  text("stat-sessions", integer(data.history.sessions.length))
  text("stat-sessions-foot", `${activeSessions} active · ${data.history.evicted_sessions ? `${integer(data.history.evicted_sessions)} older evicted` : "retained history"}`)
  element("active-session-dot").style.opacity = activeSessions ? "1" : ".3"
  text("stat-requests", integer(totals.requests))
  text("stat-requests-foot", `${totals.active} running · ${integer(totals.failed)} unsuccessful`)
  text("nav-session-count", data.history.sessions.length)
  text("session-count", data.history.sessions.length)
  const reuse = totals.body_bytes > 0 ? totals.reused_body_bytes / totals.body_bytes * 100 : null
  text("reuse-value", percentage(reuse))
  text("reuse-bytes", bytes(totals.reused_body_bytes))
  text("uploaded-bytes", bytes(totals.uploaded_chunk_bytes))
  const ring = document.getElementById("reuse-ring") as unknown as SVGCircleElement
  ring.style.strokeDashoffset = String(414.69 * (1 - Math.max(0, Math.min(100, reuse ?? 0)) / 100))
  text("retention-note", `History since ${new Date(data.history.since).toLocaleString()}. Keeps up to ${data.history.session_limit} sessions and ${integer(data.history.request_limit)} requests. ${integer(data.history.evicted_sessions)} older sessions and ${integer(data.history.dropped_requests)} request entries trimmed; global totals are preserved. Session totals restart if an evicted session reappears. Earlier history is not imported from logs. ${data.history.persistent ? "History is saved privately on the gateway." : "History is in memory only."}`)
}

function renderChart(data: Snapshot) {
  const hours = Number(element<HTMLSelectElement>("chart-range").value)
  const buckets = trafficBuckets(data.history.recent_requests, hours, Date.parse(data.collected_at))
  const original = buckets.reduce((n, b) => n + b.body, 0)
  const encoded = buckets.reduce((n, b) => n + b.encoded, 0)
  const requests = buckets.reduce((n, b) => n + b.requests, 0)
  text("chart-original", bytes(original))
  text("chart-encoded", bytes(encoded))
  text("chart-count", `${integer(requests)} requests in this window`)
  const chart = element("traffic-chart")
  chart.setAttribute("aria-label", `Last ${hours} hours of retained, finished requests: ${bytes(original)} original bodies, ${bytes(encoded)} encoded uploads, ${requests} requests.`)
  const max = Math.max(...buckets.flatMap((b) => [b.body, b.encoded]), 1024)
  const left = 62, right = 778, top = 17, bottom = 178
  const x = (i: number) => left + i * (right - left) / (buckets.length - 1)
  const y = (n: number) => bottom - n / max * (bottom - top)
  const points = (key: "body" | "encoded") => buckets.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b[key]).toFixed(1)}`).join(" ")
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = max * (4 - i) / 4
    return `<line class="chart-grid" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${left - 10}" y="${y(value) + 3}" text-anchor="end">${escape(bytes(value, 0))}</text>`
  }).join("")
  const labels = buckets.filter((_, i) => i % 5 === 0 || i === buckets.length - 1).map((b) => {
    const i = buckets.indexOf(b)
    const date = new Date(b.at)
    const label = hours > 24 ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    return `<text class="chart-axis" x="${x(i)}" y="206" text-anchor="${i === 0 ? "start" : i === 23 ? "end" : "middle"}">${escape(label)}</text>`
  }).join("")
  const dots = buckets.filter((b) => b.requests > 0).map((b) => `<circle class="chart-upload-dot" cx="${x(buckets.indexOf(b))}" cy="${y(b.encoded)}" r="3"><title>${escape(new Date(b.at).toLocaleString())}: ${b.requests} requests · ${escape(bytes(b.body))} original → ${escape(bytes(b.encoded))} uploaded</title></circle>`).join("")
  chart.innerHTML = `<svg viewBox="0 0 800 220" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="body-fill" x1="0" x2="0" y1="0" y2="1"><stop class="chart-body-stop" offset="0%" stop-opacity=".13"/><stop class="chart-body-stop" offset="100%" stop-opacity="0"/></linearGradient><linearGradient id="upload-fill" x1="0" x2="0" y1="0" y2="1"><stop class="chart-upload-stop" offset="0%" stop-opacity=".18"/><stop class="chart-upload-stop" offset="100%" stop-opacity=".02"/></linearGradient></defs>${grid}<path d="${points("body")} L${right},${bottom} L${left},${bottom} Z" fill="url(#body-fill)"/><path d="${points("encoded")} L${right},${bottom} L${left},${bottom} Z" fill="url(#upload-fill)"/><path class="chart-body" d="${points("body")}"/><path class="chart-upload" d="${points("encoded")}"/>${dots}${labels}${requests === 0 ? '<text class="chart-empty-label" x="420" y="95" text-anchor="middle">No finished requests in this window</text>' : ""}</svg>`
}

function renderSystem(data: Snapshot) {
  const { gateway, relay, history } = data
  const health = relay.health
  const controlIssue = gateway.pending_cancellations > 0 || Boolean(gateway.control_error)
  const cacheRatio = health.max_cache_bytes > 0 ? health.cache_bytes / health.max_cache_bytes : 0
  const responseRatio = health.max_response_storage_bytes > 0 ? health.response_storage_bytes / health.max_response_storage_bytes : 0
  const storageIssue = Math.max(cacheRatio, responseRatio) >= .85
  const providerIssue = data.providers.some((p) => p.last_status >= 400 || p.last_error)
  const codespaceStopped = !relay.reachable && networkConnection === "codespace_stopped"
  const noInternet = !relay.reachable && networkConnection === "no_internet"
  const vpsUnreachable = !relay.reachable && networkConnection === "vps_unreachable"
  text("system-summary", stale ? "Stale · last observed states below" : codespaceStopped ? "Codespace stopped" : noInternet ? "No internet" : vpsUnreachable ? "VPS needs attention" : !relay.reachable ? "VPS needs attention" : !health.forwarding ? "Forwarding is disabled" : controlIssue || storageIssue ? "Attention needed" : "Relay checks passed")
  const statePill = (label: string, state: string) => pill(stale ? "Stale" : label, stale ? "warning" : state)
  const providers = data.providers.map((provider) => {
    const state = provider.active > 0 ? "active" : provider.last_status >= 400 || provider.last_error ? "warning" : provider.last_seen ? "good" : "neutral"
    const label = provider.active > 0 ? `${provider.active} running` : provider.last_seen ? provider.last_error || `HTTP ${provider.last_status}` : "Unobserved"
    return `<div class="provider-item"><span title="${escape(provider.last_seen ? `Last result ${new Date(provider.last_seen).toLocaleString()}` : "No retained requests")}">${escape(provider.name)}</span>${pill(label, state)}</div>`
  }).join("")
  element("system-cards").innerHTML = `
    <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[0]}</span>${statePill(controlIssue ? "Attention" : "Online", controlIssue ? "warning" : "good")}</div><h3>Local gateway</h3><p>${gateway.active} of ${gateway.concurrency} request slots in use<br />${gateway.pending_cancellations} pending cancellations${gateway.control_error ? " · control error" : ""}</p><p class="system-meta">Uptime ${escape(duration(Math.max(0, Date.parse(data.collected_at) - Date.parse(gateway.started_at))))}</p></article>
    <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[1]}</span>${statePill(codespaceStopped ? "Stopped" : noInternet ? "No internet" : relay.reachable ? "Connected" : "Unreachable", codespaceStopped ? "neutral" : noInternet ? "warning" : relay.reachable ? "good" : "bad")}</div><h3>VPS connection</h3><p>${relay.reachable ? `Protocol v${health.version} · ${relay.latency_ms} ms health check<br />Authenticated relay identity` : codespaceStopped ? "Codespace shutdown confirmed.<br />Use Wake Codespace to resume." : noInternet ? "Internet connectivity from this computer failed.<br />The VPS has not been contacted." : vpsUnreachable ? "Internet is reachable, but the relay did not respond.<br />Check the relay, VPN split routes, or SSH tunnel." : "Health check failed or timed out.<br />Check relay, VPN, or SSH tunnel."}</p><p class="system-meta">${relay.reachable ? `STATE ${escape(health.state_id.slice(0, 14))}…` : codespaceStopped ? "AUTOMATIC RECOVERY OFF" : noInternet ? "CHECK LOCAL NETWORK" : "NO DIRECT FALLBACK"}</p></article>
    <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[2]}</span>${statePill(!relay.reachable ? "Unknown" : storageIssue ? "Near capacity" : "Available", !relay.reachable ? "neutral" : storageIssue ? "warning" : "good")}</div><h3>Storage & mailbox</h3><p>${relay.reachable ? `Cache ${escape(bytes(health.cache_bytes))} / ${escape(bytes(health.max_cache_bytes))}<br />Responses ${escape(bytes(health.response_storage_bytes))} / ${escape(bytes(health.max_response_storage_bytes))}` : noInternet ? "Storage usage is unavailable.<br />Restore internet connectivity." : "Storage usage is unavailable.<br />Restore the VPS connection."}</p><div class="storage-meter" title="Highest of cache and response-storage usage"><span style="width:${relay.reachable ? Math.min(100, Math.max(cacheRatio, responseRatio) * 100) : 0}%"></span></div><p class="system-meta">${history.persistence_error ? "HISTORY SAVE FAILED" : history.persistent ? "SESSION HISTORY SAVED LOCALLY" : "SESSION HISTORY IN MEMORY"}</p></article>
    <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[3]}</span>${statePill(!relay.reachable ? "Unknown" : health.forwarding ? providerIssue ? "Check results" : "Enabled" : "Disabled", !relay.reachable ? "neutral" : !health.forwarding || providerIssue ? "warning" : "good")}</div><h3>Provider forwarding</h3><p>Latest retained results, not live probes</p><div class="provider-list">${providers || '<span class="section-meta">No upstream observations</span>'}</div></article>`
}

function visibleSessions(): Session[] {
  return filterSessions(snapshot?.history.sessions ?? [], element<HTMLInputElement>("session-search").value, element<HTMLSelectElement>("session-filter").value)
}

function renderSessions() {
  const sessions = visibleSessions()
  const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
  page = Math.min(page, totalPages)
  const start = (page - 1) * pageSize
  const rows = sessions.slice(start, start + pageSize)
  element("session-rows").innerHTML = rows.map((session) => {
    const state = sessionState(session)
    const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
    return `<tr><td><button class="session-name" type="button" data-session-id="${escape(session.id)}" title="${escape(session.id || "Unattributed requests")}">${escape(session.id || "Unattributed requests")}</button><span class="session-upstream"><span class="tiny-dot"></span>${escape(session.upstream || "Unknown upstream")}</span></td><td>${pill(state === "active" ? `${session.active} active` : state === "attention" ? "Attention" : "Idle", state)}</td><td class="number">${integer(session.requests)}</td><td class="number">${escape(bytes(session.body_bytes))}</td><td class="number">${escape(bytes(session.encoded_upload_bytes))}</td><td class="number"><span class="reduction-cell ${reduction !== null && reduction < 0 ? "negative" : ""}">${escape(percentage(reduction))}<span class="reduction-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, reduction ?? 0))}%"></span></span></span></td><td title="${escape(new Date(session.updated_at).toLocaleString())}">${escape(relativeTime(session.updated_at))}</td><td><button class="row-detail" type="button" data-session-id="${escape(session.id)}" aria-label="Inspect ${escape(session.id || "unattributed requests")}">↗</button></td></tr>`
  }).join("")
  const empty = element("sessions-empty")
  empty.hidden = sessions.length > 0
  if (snapshot?.history.sessions.length) {
    empty.querySelector("h3")!.textContent = "No matching sessions"
    empty.querySelector("p")!.textContent = "Try a different session ID, upstream, or state filter."
  } else {
    empty.querySelector("h3")!.textContent = "No sessions yet"
    empty.querySelector("p")!.textContent = "Routed requests will appear here automatically. Start the gateway and send a message through DeltaRelay."
  }
  text("table-summary", sessions.length ? `${start + 1}–${Math.min(start + pageSize, sessions.length)} of ${sessions.length} sessions` : "0 sessions")
  text("page-label", `Page ${page} of ${totalPages}`)
  element<HTMLButtonElement>("previous-page").disabled = page <= 1
  element<HTMLButtonElement>("next-page").disabled = page >= totalPages
  element<HTMLButtonElement>("export-button").disabled = sessions.length === 0
}

function renderDetail() {
  if (!snapshot || selectedSession === null) return
  const session = snapshot.history.sessions.find((s) => s.id === selectedSession)
  if (!session) {
    element("session-detail").textContent = "This session has left the retained history. Global counters are unchanged."
    return
  }
  text("detail-title", session.id || "Unattributed requests")
  const requests = snapshot.history.recent_requests.filter((r) => r.session_id === session.id).sort((a, b) => b.sequence - a.sequence)
  const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
  element("session-detail").innerHTML = `<div class="detail-meta"><span>${escape(session.upstream)} · ${integer(session.requests)} requests · ${session.failed} unsuccessful</span>${pill(sessionState(session), sessionState(session))}</div><div class="detail-stats"><div class="detail-stat"><span>Upload reduction</span><strong class="${reduction !== null && reduction < 0 ? "negative" : "accent"}">${escape(percentage(reduction))}</strong></div><div class="detail-stat"><span>Bandwidth saved</span><strong>${escape(bytes(session.body_bytes - session.encoded_upload_bytes))}</strong></div><div class="detail-stat"><span>Recorded call time</span><strong>${escape(duration(session.duration_ms))}</strong></div></div><h3>Recent requests <span class="section-meta">(${requests.length} retained)</span></h3>${requests.map((request) => `<div class="request-entry"><div><code>${escape(request.id)}</code><p>${escape(request.kind)} · ${escape(relativeTime(request.started_at))} · ${escape(duration(request.state === "running" ? Date.parse(snapshot!.collected_at) - Date.parse(request.started_at) : request.duration_ms))}${request.status ? ` · HTTP ${request.status}` : ""}</p>${request.error_code ? `<p class="request-error">${escape(request.error_code)}</p>` : ""}</div><div>${pill(request.state, request.state === "completed" ? "good" : request.state === "running" ? "active" : "warning")}<p class="request-transfer">${request.state === "running" ? "Transfer totals pending" : `${escape(bytes(request.transfer.body_bytes))} → ${escape(bytes(request.transfer.request_body_bytes_sent))}`}</p></div></div>`).join("")}<p class="detail-note">${session.id ? "This session is identified by its opaque OpenCode ID, not its title or content." : "These requests did not include a valid session ID; they are grouped together, not treated as a single OpenCode session."} Request history is bounded; session totals can cover more calls than the retained list. “Interrupted” after a gateway restart does not mean the VPS job was cancelled. Recover saved responses with the request CLI before resubmitting.</p>`
}

function render() {
  renderConnection()
  if (!snapshot) {
    // Never leave stale numbers on screen after the gateway disconnects.
    for (const id of ["stat-reduction", "stat-saved", "stat-sessions", "stat-requests", "reuse-value", "reuse-bytes", "uploaded-bytes", "chart-original", "chart-encoded", "nav-session-count"]) {
      text(id, "—")
      element(id).classList.remove("negative")
    }
    text("stat-saved-foot", "Awaiting transfer statistics")
    text("stat-sessions-foot", "No session data yet")
    text("stat-requests-foot", "All recorded history")
    text("session-count", 0)
    text("system-summary", "Waiting for diagnostics")
    text("chart-count", "0 requests in this window")
    element("traffic-chart").innerHTML = initialChart
    element("traffic-chart").setAttribute("aria-label", "Upload traffic chart awaiting data")
    element("system-cards").innerHTML = initialSystemCards
    document.getElementById("reuse-ring")!.style.strokeDashoffset = "414.69"
    renderSessions()
    return
  }
  renderStats(snapshot)
  renderChart(snapshot)
  renderSystem(snapshot)
  renderSessions()
  if (dialog.open) renderDetail()
}

async function refresh() {
  if (busy) return
  busy = true
  refreshButton.disabled = true
  const current = ++generation
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 7000)
  try {
    const next = await fetchSnapshot(controller.signal)
    if (current !== generation) return
    snapshot = next
    stale = false
    lastError = ""
  } catch (error) {
    if (current !== generation) return
    stale = true
    lastError = error instanceof Error && error.name !== "AbortError" ? error.message : "The local diagnostics request timed out."
  } finally {
    window.clearTimeout(timeout)
    if (current === generation) {
      busy = false
      refreshButton.disabled = false
      render()
    }
  }
}

refreshButton.addEventListener("click", () => void refresh())
pauseButton.addEventListener("click", () => {
  paused = !paused
  renderConnection()
  if (!paused) void refresh()
})
element("chart-range").addEventListener("change", () => { if (snapshot) renderChart(snapshot) })
for (const id of ["session-search", "session-filter"]) element(id).addEventListener(id === "session-search" ? "input" : "change", () => { page = 1; renderSessions() })
element("previous-page").addEventListener("click", () => { page--; renderSessions() })
element("next-page").addEventListener("click", () => { page++; renderSessions() })
element("session-rows").addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button[data-session-id]")
  if (!target) return
  selectedSession = target.dataset.sessionId ?? ""
  renderDetail()
  dialog.showModal()
})
element("close-detail").addEventListener("click", () => dialog.close())
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return
  const bounds = dialog.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
})
element("notes-toggle").addEventListener("click", (event) => {
  event.preventDefault()
  const notes = element("measurement-notes")
  notes.hidden = !notes.hidden
  element("notes-toggle").setAttribute("aria-expanded", String(!notes.hidden))
  if (!notes.hidden) notes.scrollIntoView({ block: "nearest" })
})

element("export-button").addEventListener("click", () => {
  // Prefix spreadsheet formulas in text fields; CSV can be active content.
  const cell = (value: string | number) => `"${String(value).replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`
  const rows = [["session_id", "upstream", "requests", "active", "failed", "body_bytes", "encoded_upload_bytes", "saved_bytes", "reduction_percent", "last_activity"], ...visibleSessions().map((s) => [s.id || "unattributed", s.upstream, s.requests, s.active, s.failed, s.body_bytes, s.encoded_upload_bytes, s.body_bytes - s.encoded_upload_bytes, savings(s.body_bytes, s.encoded_upload_bytes)?.toFixed(2) ?? "", s.updated_at])]
  const blob = new Blob([rows.map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `deltarelay-sessions-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
})

document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => link.addEventListener("click", () => {
  document.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("selected", item === link))
}))
document.addEventListener("visibilitychange", () => { if (!document.hidden && !paused) void refresh() })
window.setInterval(() => {
  if (document.hidden) return
  if (!paused) void refresh()
  else renderConnection()
}, 10_000)
void refresh()
