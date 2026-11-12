import { sessionCsv } from "../../lib/csv.js"
import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, duration, filterSessions, percentage, relativeTime, savings, sessionState } from "../../lib/metrics.js"
import { dataValue } from "../../lib/presentation.js"
import type { DashboardViewState } from "../../lib/state.js"
import type { Session, Snapshot } from "../../lib/types.js"
import { readParams, readSort, replaceParams, sortParams, type SortState } from "../../lib/url-state.js"
import { required, requiredById } from "../dom.js"

export interface SessionsFeature {
  render(state: DashboardViewState): void
}

const pageSize = 8
const integer = (value: number) => value.toLocaleString()
const pill = (label: string, state: string) => `<span class="status-pill ${state}">${escape(label)}</span>`
const sortKeys = ["session", "state", "requests", "original", "uploaded", "reduction", "activity"] as const
type SessionSortKey = (typeof sortKeys)[number]
const sortLabels: Record<SessionSortKey, string> = {
  session: "session",
  state: "state",
  requests: "requests",
  original: "original size",
  uploaded: "uploaded size",
  reduction: "reduction",
  activity: "last activity",
}
const asSortKey = (value: string | undefined): SessionSortKey | null => sortKeys.find((key) => key === value) ?? null
const sortWord = (direction: SortState<SessionSortKey>["direction"]) => direction === "asc" ? "ascending" : "descending"
const capitalised = (value: string) => value.replace(/^./, (letter) => letter.toUpperCase())

export function mountSessions(root: HTMLElement, dialog: HTMLDialogElement): SessionsFeature {
  const search = requiredById<HTMLInputElement>(root, "session-search")
  const filterChips = [...root.querySelectorAll<HTMLButtonElement>("#session-filter-chips [data-filter-value]")]
  const exportButton = requiredById<HTMLButtonElement>(root, "export-button")
  const rowsBody = requiredById(root, "session-rows")
  const tableScroll = requiredById<HTMLElement>(root, "session-table-scroll")
  const summary = requiredById<HTMLElement>(root, "table-summary")
  const empty = requiredById<HTMLElement>(root, "sessions-empty")
  const previous = requiredById<HTMLButtonElement>(root, "previous-page")
  const next = requiredById<HTMLButtonElement>(root, "next-page")
  const sortButtons = [...root.querySelectorAll<HTMLButtonElement>("#session-table-scroll button[data-sort-key]")]
  const sortHeaders = [...root.querySelectorAll<HTMLElement>("#session-table-scroll th[data-sort-key]")]
  const sortSelect = requiredById<HTMLSelectElement>(root, "session-sort")
  const sortDirectionButton = requiredById<HTMLButtonElement>(root, "session-sort-direction")
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
  let filterValue = validStates.includes(initialState) ? initialState : "all"
  let sortState = readSort(initial, sortKeys, "activity", "desc")
  search.value = initial.get("q") ?? ""
  for (const chip of filterChips) chip.setAttribute("aria-pressed", String(chip.dataset.filterValue === filterValue))
  const pageParam = Number(initial.get("page"))
  let state: DashboardViewState | null = null
  let page = Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1
  let selectedSession: string | null = null
  let pendingOpen = initial.get("session")

  function syncUrl(): void {
    replaceParams(root.ownerDocument, {
      q: search.value.trim() || null,
      state: filterValue === "all" ? null : filterValue,
      page: page > 1 ? String(page) : null,
      session: dialog.open && selectedSession ? selectedSession : pendingOpen,
      ...sortParams(sortState, "activity", "desc"),
    })
  }

  function compareSessions(a: Session, b: Session): number {
    const direction = sortState.direction === "asc" ? 1 : -1
    switch (sortState.key) {
      case "session":
        return (a.id || "Unattributed requests").localeCompare(b.id || "Unattributed requests", undefined, { numeric: true, sensitivity: "base" }) * direction
      case "state":
        return sessionState(a).localeCompare(sessionState(b)) * direction
      case "requests":
        return (a.requests - b.requests) * direction
      case "original":
        return (a.body_bytes - b.body_bytes) * direction
      case "uploaded":
        return (a.encoded_upload_bytes - b.encoded_upload_bytes) * direction
      case "reduction": {
        const left = savings(a.body_bytes, a.encoded_upload_bytes)
        const right = savings(b.body_bytes, b.encoded_upload_bytes)
        if (left === null) return right === null ? 0 : 1
        if (right === null) return -1
        return (left - right) * direction
      }
      case "activity": {
        const left = Date.parse(a.updated_at)
        const right = Date.parse(b.updated_at)
        return ((Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0)) * direction
      }
    }
  }

  function visibleSessions(): Session[] {
    return filterSessions(state?.snapshot?.history.sessions ?? [], search.value, filterValue)
      .sort((a, b) => compareSessions(a, b))
  }

  function updateSortControls(): void {
    for (const header of sortHeaders) {
      const active = header.dataset.sortKey === sortState.key
      header.setAttribute("aria-sort", active ? (sortState.direction === "asc" ? "ascending" : "descending") : "none")
    }
    for (const button of sortButtons) {
      const key = asSortKey(button.dataset.sortKey)
      if (!key) continue
      const label = sortLabels[key]
      const active = key === sortState.key
      button.setAttribute("aria-label", active
        ? `${capitalised(label)}, sorted ${sortWord(sortState.direction)}. Activate to sort ${sortState.direction === "asc" ? "descending" : "ascending"}.`
        : `Sort by ${label}`)
    }
    sortSelect.value = sortState.key
    const nextDirection = sortState.direction === "asc" ? "descending" : "ascending"
    sortDirectionButton.dataset.direction = sortState.direction
    sortDirectionButton.setAttribute("aria-label", `Sort direction: ${sortWord(sortState.direction)}. Activate to sort ${nextDirection}.`)
    sortDirectionButton.title = `Sorted ${sortWord(sortState.direction)} — reverse order`
  }

  function sortBy(key: SessionSortKey): void {
    if (key === sortState.key) {
      sortState = { key, direction: sortState.direction === "asc" ? "desc" : "asc" }
    } else {
      sortState = { key, direction: key === "activity" ? "desc" : "asc" }
    }
    page = 1
    renderSessions()
  }

  function reverseSort(): void {
    sortState = { key: sortState.key, direction: sortState.direction === "asc" ? "desc" : "asc" }
    page = 1
    renderSessions()
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
    detail.innerHTML = `<div class="detail-meta"><span class="metadata-line">${dataValue(session.upstream || "Unknown upstream")}<span>${dataValue(integer(session.requests))} requests</span><span>${dataValue(integer(session.failed))} failed</span><span>${dataValue(integer(session.cancelled))} cancelled</span></span>${pill(sessionState(session), sessionState(session))}</div><div class="detail-stats"><div class="detail-stat"><span>Upload reduction</span><strong class="${reduction !== null && reduction < 0 ? "negative" : "accent"}">${escape(percentage(reduction))}</strong></div><div class="detail-stat"><span>Bandwidth saved</span><strong>${escape(bytes(session.body_bytes - session.encoded_upload_bytes))}</strong></div><div class="detail-stat"><span>Recorded call time</span><strong>${escape(duration(session.duration_ms))}</strong></div></div><h3>Recent requests <span class="section-meta">${dataValue(integer(requests.length))} retained</span></h3>${requests.map((request) => `<div class="request-entry"><div><code translate="no">${escape(request.id)}</code><p class="metadata-line">${dataValue(request.kind)}${dataValue(relativeTime(request.started_at))}${dataValue(duration(request.state === "running" ? Date.parse(snapshot.collected_at) - Date.parse(request.started_at) : request.duration_ms))}${request.status ? dataValue(`HTTP ${request.status}`) : ""}</p>${request.error_code ? `<p class="request-error">${escape(request.error_code)}</p>` : ""}</div><div>${pill(request.state, request.state === "completed" ? "good" : request.state === "running" ? "active" : request.state === "cancelled" ? "neutral" : "warning")}<p class="request-transfer metadata-line">${request.state === "running" ? "Transfer totals pending" : `${dataValue(bytes(request.transfer.body_bytes))}<span aria-hidden="true">→</span><span class="sr-only">to</span>${dataValue(bytes(request.transfer.request_body_bytes_sent))}`}</p></div></div>`).join("")}<p class="detail-note">${session.id ? "Session ID is opaque; no title or content is shown." : "Requests without a valid session ID are grouped here."} History is bounded; session totals may exceed the retained list. “Interrupted” after a gateway restart does not mean the remote job was cancelled. Recover saved responses with the request CLI before resubmitting.</p>`
  }

  function openDetail(sessionId: string): void {
    selectedSession = sessionId
    renderDetail()
    if (!dialog.open) dialog.showModal()
    syncUrl()
  }

  function renderSessions() {
    updateSortControls()
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
    const sortNote = ` · sorted by ${sortLabels[sortState.key]} ${sortWord(sortState.direction)}`
    const summaryHtml = sessions.length
      ? `${dataValue(`${start + 1}–${Math.min(start + pageSize, sessions.length)}`)} of ${dataValue(sessions.length)}${sessions.length !== totalSessions ? ` matching (${dataValue(`${integer(totalSessions)} total`)})` : ""} sessions${sortNote}`
      : totalSessions ? `${dataValue(0)} of ${dataValue(integer(totalSessions))} sessions match this filter${sortNote}` : `${dataValue(0)} sessions`
    if (summary.innerHTML !== summaryHtml) summary.innerHTML = summaryHtml
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

  function setFilter(value: string): void {
    filterValue = value
    for (const chip of filterChips) chip.setAttribute("aria-pressed", String(chip.dataset.filterValue === value))
    page = 1
    renderSessions()
  }

  for (const chip of filterChips) chip.addEventListener("click", () => setFilter(chip.dataset.filterValue ?? "all"))
  for (const button of sortButtons) {
    button.addEventListener("click", () => {
      const key = asSortKey(button.dataset.sortKey)
      if (key) sortBy(key)
    })
  }
  sortSelect.addEventListener("change", () => {
    const key = asSortKey(sortSelect.value)
    if (key) sortBy(key)
  })
  sortDirectionButton.addEventListener("click", reverseSort)
  const chips = requiredById<HTMLElement>(root, "session-filter-chips")
  chips.addEventListener("keydown", (event) => {
    const current = (event.target as Element).closest<HTMLButtonElement>("[data-filter-value]")
    if (!current) return
    const index = filterChips.indexOf(current)
    let next = index
    if (event.key === "ArrowRight") next = Math.min(filterChips.length - 1, index + 1)
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1)
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = filterChips.length - 1
    else return
    event.preventDefault()
    filterChips[next]?.focus()
  })
  search.addEventListener("input", () => { page = 1; renderSessions() })
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

  updateSortControls()

  return {
    render(nextState) {
      state = nextState
      renderSessions()
      if (dialog.open) renderDetail()
    },
  }
}
