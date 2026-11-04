import { sessionCsv } from "../../lib/csv.js"
import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, duration, filterSessions, percentage, relativeTime, savings, sessionState } from "../../lib/metrics.js"
import type { DashboardViewState } from "../../lib/state.js"
import type { Session, Snapshot } from "../../lib/types.js"
import { readParams, replaceParams } from "../../lib/url-state.js"
import { required, requiredById } from "../dom.js"

export interface SessionsFeature {
  render(state: DashboardViewState): void
}

const pageSize = 8
const integer = (value: number) => value.toLocaleString()
const pill = (label: string, state: string) => `<span class="status-pill ${state}">${escape(label)}</span>`

export function mountSessions(root: HTMLElement, dialog: HTMLDialogElement): SessionsFeature {
  const search = requiredById<HTMLInputElement>(root, "session-search")
  const filter = requiredById<HTMLSelectElement>(root, "session-filter")
  const exportButton = requiredById<HTMLButtonElement>(root, "export-button")
  const rowsBody = requiredById(root, "session-rows")
  const tableScroll = requiredById<HTMLElement>(root, "session-table-scroll")
  const empty = requiredById<HTMLElement>(root, "sessions-empty")
  const previous = requiredById<HTMLButtonElement>(root, "previous-page")
  const next = requiredById<HTMLButtonElement>(root, "next-page")
  const detail = requiredById(dialog, "session-detail")
  const detailTitle = requiredById(dialog, "detail-title")
  const closeDetail = requiredById<HTMLButtonElement>(dialog, "close-detail")
  const setText = (id: string, value: string | number) => {
    const element = requiredById(root, id)
    const nextValue = String(value)
    if (element.textContent !== nextValue) element.textContent = nextValue
  }

  const initial = readParams(root.ownerDocument)
  const validStates = ["all", "active", "idle", "attention"]
  const initialState = initial.get("state") ?? "all"
  search.value = initial.get("q") ?? ""
  filter.value = validStates.includes(initialState) ? initialState : "all"
  const pageParam = Number(initial.get("page"))
  let state: DashboardViewState | null = null
  let page = Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1
  let selectedSession: string | null = null
  let pendingOpen = initial.get("session")

  function syncUrl(): void {
    replaceParams(root.ownerDocument, {
      q: search.value.trim() || null,
      state: filter.value === "all" ? null : filter.value,
      page: page > 1 ? String(page) : null,
      session: dialog.open && selectedSession ? selectedSession : pendingOpen,
    })
  }

  function visibleSessions(): Session[] {
    return filterSessions(state?.snapshot?.history.sessions ?? [], search.value, filter.value)
  }

  function renderDetail() {
    if (!state?.snapshot || selectedSession === null) return
    const snapshot: Snapshot = state.snapshot
    const session = snapshot.history.sessions.find((candidate) => candidate.id === selectedSession)
    if (!session) {
      detail.textContent = "Session is no longer in retained history. Global totals are unchanged."
      return
    }
    detailTitle.textContent = session.id || "Unattributed requests"
    const requests = snapshot.history.recent_requests.filter((request) => request.session_id === session.id).sort((a, b) => b.sequence - a.sequence)
    const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
    detail.innerHTML = `<div class="detail-meta"><span>${escape(session.upstream)} · ${integer(session.requests)} requests · ${integer(session.failed)} failed · ${integer(session.cancelled)} cancelled</span>${pill(sessionState(session), sessionState(session))}</div><div class="detail-stats"><div class="detail-stat"><span>Upload reduction</span><strong class="${reduction !== null && reduction < 0 ? "negative" : "accent"}">${escape(percentage(reduction))}</strong></div><div class="detail-stat"><span>Bandwidth saved</span><strong>${escape(bytes(session.body_bytes - session.encoded_upload_bytes))}</strong></div><div class="detail-stat"><span>Recorded call time</span><strong>${escape(duration(session.duration_ms))}</strong></div></div><h3>Recent requests <span class="section-meta">(${requests.length} retained)</span></h3>${requests.map((request) => `<div class="request-entry"><div><code translate="no">${escape(request.id)}</code><p>${escape(request.kind)} · ${escape(relativeTime(request.started_at))} · ${escape(duration(request.state === "running" ? Date.parse(snapshot.collected_at) - Date.parse(request.started_at) : request.duration_ms))}${request.status ? ` · HTTP ${request.status}` : ""}</p>${request.error_code ? `<p class="request-error">${escape(request.error_code)}</p>` : ""}</div><div>${pill(request.state, request.state === "completed" ? "good" : request.state === "running" ? "active" : request.state === "cancelled" ? "neutral" : "warning")}<p class="request-transfer">${request.state === "running" ? "Transfer totals pending" : `${escape(bytes(request.transfer.body_bytes))} → ${escape(bytes(request.transfer.request_body_bytes_sent))}`}</p></div></div>`).join("")}<p class="detail-note">${session.id ? "Session ID is opaque; no title or content is shown." : "Requests without a valid session ID are grouped here."} History is bounded; session totals may exceed the retained list. “Interrupted” after a gateway restart does not mean the VPS job was cancelled. Recover saved responses with the request CLI before resubmitting.</p>`
  }

  function openDetail(sessionId: string): void {
    selectedSession = sessionId
    renderDetail()
    if (!dialog.open) dialog.showModal()
    syncUrl()
  }

  function renderSessions() {
    const sessions = visibleSessions()
    const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
    if (state?.snapshot) page = Math.min(page, totalPages)
    const start = (page - 1) * pageSize
    const rows = sessions.slice(start, start + pageSize)
    const active = root.ownerDocument.activeElement as HTMLElement | null
    const focusedRowButton = active && rowsBody.contains(active) ? active.closest<HTMLButtonElement>("button[data-session-id]") : null
    const focusedSession = focusedRowButton?.dataset.sessionId
    const focusedClass = focusedRowButton?.classList.contains("row-detail") ? "row-detail" : "session-name"
    rowsBody.innerHTML = rows.map((session) => {
      const current = sessionState(session)
      const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
      return `<tr><td><button class="session-name" type="button" data-session-id="${escape(session.id)}" title="${escape(session.id || "Unattributed requests")}" translate="no">${escape(session.id || "Unattributed requests")}</button><span class="session-upstream"><span class="tiny-dot" aria-hidden="true"></span>${escape(session.upstream || "Unknown upstream")}</span></td><td>${pill(current === "active" ? `${session.active} active` : current === "attention" ? "Attention" : "Idle", current)}</td><td class="number">${integer(session.requests)}</td><td class="number">${escape(bytes(session.body_bytes))}</td><td class="number">${escape(bytes(session.encoded_upload_bytes))}</td><td class="number"><span class="reduction-cell ${reduction !== null && reduction < 0 ? "negative" : ""}">${escape(percentage(reduction))}<span class="reduction-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, reduction ?? 0))}%"></span></span></span></td><td title="${escape(new Date(session.updated_at).toLocaleString())}">${escape(relativeTime(session.updated_at))}</td><td><button class="row-detail" type="button" data-session-id="${escape(session.id)}" aria-label="Inspect ${escape(session.id || "unattributed requests")}">↗</button></td></tr>`
    }).join("")
    if (focusedSession !== undefined) {
      const replacement = [...rowsBody.querySelectorAll<HTMLButtonElement>(`button.${focusedClass}[data-session-id]`)].find((button) => button.dataset.sessionId === focusedSession)
      replacement?.focus({ preventScroll: true })
    }
    empty.hidden = sessions.length > 0
    tableScroll.hidden = sessions.length === 0
    if (state?.snapshot?.history.sessions.length) {
      required(empty, "h3").textContent = "No matching sessions"
      required(empty, "p").textContent = "Change the search text or state filter."
    } else {
      required(empty, "h3").textContent = "No sessions recorded"
      required(empty, "p").textContent = "Requests routed through the gateway will appear here."
    }
    const totalSessions = state?.snapshot?.history.sessions.length ?? 0
    setText("table-summary", sessions.length
      ? `${start + 1}–${Math.min(start + pageSize, sessions.length)} of ${sessions.length}${sessions.length !== totalSessions ? ` matching (${integer(totalSessions)} total)` : ""} sessions`
      : totalSessions ? `0 of ${integer(totalSessions)} sessions match this filter` : "0 sessions")
    setText("page-label", `Page ${page} of ${totalPages}`)
    previous.disabled = page <= 1
    next.disabled = page >= totalPages
    exportButton.disabled = sessions.length === 0
    setText("session-count", state?.snapshot?.history.sessions.length ?? 0)
    syncUrl()
    if (pendingOpen && state?.snapshot) {
      const sessionId = pendingOpen
      pendingOpen = null
      if (state.snapshot.history.sessions.some((session) => session.id === sessionId)) openDetail(sessionId)
      else syncUrl()
    }
  }

  search.addEventListener("input", () => { page = 1; renderSessions() })
  filter.addEventListener("change", () => { page = 1; renderSessions() })
  previous.addEventListener("click", () => { page--; renderSessions() })
  next.addEventListener("click", () => { page++; renderSessions() })
  rowsBody.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button[data-session-id]")
    if (!target) return
    openDetail(target.dataset.sessionId ?? "")
  })
  closeDetail.addEventListener("click", () => dialog.close())
  dialog.addEventListener("close", () => {
    selectedSession = null
    syncUrl()
  })
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return
    const bounds = dialog.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
  })
  exportButton.addEventListener("click", () => {
    const blob = new Blob([sessionCsv(visibleSessions())], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `deltarelay-sessions-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  })

  return {
    render(nextState) {
      state = nextState
      renderSessions()
      if (dialog.open) renderDetail()
    },
  }
}
