import { sessionCsv } from "../../lib/csv.js"
import { iconMarkup } from "../../lib/icons.js"
import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, displaySessions, duration, filterSessions, historyHosts, percentage, relativeTime, savings, sessionRequests, sessionState, type SessionView } from "../../lib/metrics.js"
import { dataValue } from "../../lib/presentation.js"
import { activeColumnFilterCount, compileSessionFilters, emptySessionFilters, filterSessionViews, isColumnFilterActive, parseByteSize, parseDateBound, parseFilterNumber, readSessionFilters, sessionFilterParams, type SessionFilterInput } from "../../lib/session-filters.js"
import { dataPhase, type DashboardViewState } from "../../lib/state.js"
import type { Snapshot } from "../../lib/types.js"
import { readParams, readSort, replaceParams, sortParams, type SortState } from "../../lib/url-state.js"
import { required, requiredById } from "../dom.js"

export interface SessionsFeature {
  render(state: DashboardViewState): void
}

export interface SessionsOptions {
  onHostChange(host: string): void
}

const defaultPageSize = 8
const pageSizes = [8, 25, 50, 100] as const
const integer = (value: number) => value.toLocaleString()
const pill = (label: string, state: string) => `<span class="status-pill ${state}">${escape(label)}</span>`
const sortKeys = ["session", "host", "state", "requests", "original", "uploaded", "reduction", "activity"] as const
type SessionSortKey = (typeof sortKeys)[number]
const sortLabels: Record<SessionSortKey, string> = {
  session: "session",
  host: "remote host",
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

export function mountSessions(root: HTMLElement, dialog: HTMLDialogElement, options: SessionsOptions): SessionsFeature {
  const doc = root.ownerDocument
  const search = requiredById<HTMLInputElement>(root, "session-search")
  const exportButton = requiredById<HTMLButtonElement>(root, "export-button")
  const rowsBody = requiredById(root, "session-rows")
  const tableScroll = requiredById<HTMLElement>(root, "session-table-scroll")
  const summary = requiredById<HTMLElement>(root, "table-summary")
  const empty = requiredById<HTMLElement>(root, "sessions-empty")
  const emptyIcon = required<HTMLElement>(empty, ".empty-icon")
  const emptyIconMarkup = emptyIcon.innerHTML
  const previous = requiredById<HTMLButtonElement>(root, "previous-page")
  const next = requiredById<HTMLButtonElement>(root, "next-page")
  const pageSizeSelect = requiredById<HTMLSelectElement>(root, "session-page-size")
  const sortButtons = [...root.querySelectorAll<HTMLButtonElement>("#session-table-scroll button[data-sort-key]")]
  const sortHeaders = [...root.querySelectorAll<HTMLElement>("#session-table-scroll th[data-sort-key]")]
  const filterButtons = [...root.querySelectorAll<HTMLButtonElement>("button[data-filter-key]")]
  const clearFiltersButton = requiredById<HTMLButtonElement>(root, "clear-session-filters")
  const clearFiltersEmpty = requiredById<HTMLButtonElement>(root, "clear-session-filters-empty")
  const sortSelect = requiredById<HTMLSelectElement>(root, "session-sort")
  const sortDirectionButton = requiredById<HTMLButtonElement>(root, "session-sort-direction")
  const detail = requiredById(dialog, "session-detail")
  const detailTitle = requiredById(dialog, "detail-title")
  const closeDetail = requiredById<HTMLButtonElement>(dialog, "close-detail")
  const measureLink = requiredById<HTMLAnchorElement>(dialog, "detail-measure")
  const popover = requiredById<HTMLElement>(root, "session-filter-popover")
  const popoverTitle = requiredById<HTMLElement>(popover, "session-filter-popover-title")
  const popoverCaret = requiredById<HTMLElement>(popover, "session-filter-caret")
  const popoverBody = requiredById<HTMLElement>(popover, "session-filter-popover-body")
  const popoverHint = requiredById<HTMLElement>(popover, "session-filter-hint")
  const closeFilterButton = requiredById<HTMLButtonElement>(popover, "close-session-filter")
  const clearFilterButton = requiredById<HTMLButtonElement>(popover, "clear-session-filter")
  const doneFilterButton = requiredById<HTMLButtonElement>(popover, "done-session-filter")
  if (popover.parentElement !== doc.body) doc.body.appendChild(popover)
  const setText = (id: string, value: string | number) => {
    const element = requiredById(root, id)
    const nextValue = String(value)
    if (element.textContent !== nextValue) element.textContent = nextValue
  }

  const initial = readParams(doc)
  const validStates = ["all", "active", "idle", "attention"]
  const initialState = initial.get("state") ?? "all"
  let filterValue = validStates.includes(initialState) ? initialState : "all"
  let columnFilters = readSessionFilters(initial)
  let sortState = readSort(initial, sortKeys, "activity", "desc")
  search.value = initial.get("q") ?? ""
  const pageParam = Number(initial.get("page"))
  let state: DashboardViewState | null = null
  let pendingPhase: "loading" | "unavailable" | null = null
  let page = Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1
  const rowsParam = initial.get("rows")
  let pageSize = pageSizes.find((size) => String(size) === rowsParam) ?? defaultPageSize
  pageSizeSelect.value = String(pageSize)
  let selectedSession: string | null = null
  let pendingOpen = initial.get("session")
  let openFilterKey: SessionSortKey | null = null
  let filterTrigger: HTMLButtonElement | null = null

  function syncUrl(): void {
    replaceParams(doc, {
      q: search.value.trim() || null,
      state: filterValue === "all" ? null : filterValue,
      page: page > 1 ? String(page) : null,
      rows: pageSize === defaultPageSize ? null : String(pageSize),
      session: dialog.open && selectedSession ? selectedSession : pendingOpen,
      ...sortParams(sortState, "activity", "desc"),
      ...sessionFilterParams(columnFilters),
    })
  }

  function compareSessions(a: SessionView, b: SessionView): number {
    const direction = sortState.direction === "asc" ? 1 : -1
    switch (sortState.key) {
      case "session":
        return (a.id || "Unattributed requests").localeCompare(b.id || "Unattributed requests", undefined, { numeric: true, sensitivity: "base" }) * direction
      case "host":
        return a.hosts.join(", ").localeCompare(b.hosts.join(", "), undefined, { numeric: true, sensitivity: "base" }) * direction
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

  function visibleSessions(): SessionView[] {
    const sessions = displaySessions(state?.snapshot ?? null, state?.host ?? "")
    return filterSessionViews(filterSessions(sessions, search.value, filterValue), compileSessionFilters(columnFilters))
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
    const session = displaySessions(snapshot, state.host).find((candidate) => candidate.id === selectedSession)
    if (!session) {
      detail.textContent = "Session is no longer in retained history. Global totals are unchanged."
      measureLink.hidden = true
      return
    }
    measureLink.hidden = false
    measureLink.href = `/measurement?session=${encodeURIComponent(session.id)}${state.host ? `&host=${encodeURIComponent(state.host)}` : ""}`
    detailTitle.textContent = session.id || "Unattributed requests"
    const requests = sessionRequests(snapshot, session.id, state.host)
    const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
    detail.innerHTML = `<div class="detail-meta"><span class="metadata-line">${dataValue(session.upstream || "Unknown upstream")}<span>${dataValue(session.hosts.join(", "))}</span><span>${dataValue(integer(session.requests))} requests</span><span>${dataValue(integer(session.failed))} failed</span>${session.legacy ? `<span>${dataValue(integer(session.legacy))} legacy</span>` : ""}<span>${dataValue(integer(session.cancelled))} cancelled</span></span>${pill(sessionState(session), sessionState(session))}</div><div class="detail-stats"><div class="detail-stat"><span>Upload reduction</span><strong class="${reduction !== null && reduction < 0 ? "negative" : "accent"}">${escape(percentage(reduction))}</strong></div><div class="detail-stat"><span>Bandwidth saved</span><strong>${escape(bytes(session.body_bytes - session.encoded_upload_bytes))}</strong></div><div class="detail-stat"><span>Recorded call time</span><strong>${escape(duration(session.duration_ms))}</strong></div></div><h3>Recent requests <span class="section-meta">${dataValue(integer(requests.length))} retained</span></h3>${requests.map((request) => `<div class="request-entry"><div><code translate="no">${escape(request.id)}</code><p class="metadata-line">${dataValue(request.kind)}${dataValue(request.host || "local")}${dataValue(relativeTime(request.started_at))}${dataValue(duration(request.state === "running" ? Date.parse(snapshot.collected_at) - Date.parse(request.started_at) : request.duration_ms))}${request.status ? dataValue(`HTTP ${request.status}`) : ""}</p>${request.error_code ? `<p class="request-error">${escape(request.error_code)}</p>` : ""}</div><div>${pill(request.state, request.state === "completed" ? "good" : request.state === "running" ? "active" : request.state === "cancelled" ? "neutral" : "warning")}<p class="request-transfer metadata-line">${request.state === "running" ? "Transfer totals pending" : `${dataValue(bytes(request.transfer.body_bytes))}${iconMarkup("arrow-right", 14)}<span class="sr-only">to</span>${dataValue(bytes(request.transfer.request_body_bytes_sent))}`}</p></div></div>`).join("")}<p class="detail-note">${session.id ? "Session ID is opaque; no title or content is shown." : "Requests without a valid session ID are grouped here."} New history is retained indefinitely; request lists may still be incomplete for sessions recorded before unlimited retention. “Interrupted” after a gateway restart does not mean the remote job was cancelled. Recover saved responses with the request CLI before resubmitting.</p>`
  }

  function openDetail(sessionId: string): void {
    selectedSession = sessionId
    renderDetail()
    if (!dialog.open) dialog.showModal()
    syncUrl()
  }

  function filterActive(key: SessionSortKey): boolean {
    switch (key) {
      case "host": return (state?.host ?? "") !== ""
      case "state": return filterValue !== "all"
      default: return isColumnFilterActive(columnFilters, key)
    }
  }

  function activeFilterCount(): number {
    let count = activeColumnFilterCount(columnFilters)
    if (filterValue !== "all") count++
    if ((state?.host ?? "") !== "") count++
    if (search.value.trim()) count++
    return count
  }

  function updateFilterControls(): void {
    for (const button of filterButtons) {
      const key = asSortKey(button.dataset.filterKey)
      if (!key) continue
      const active = filterActive(key)
      const label = sortLabels[key]
      button.dataset.active = String(active)
      button.setAttribute("aria-label", active ? `Filter by ${label}, active` : `Filter by ${label}`)
      button.title = active ? `Filter by ${label} (active)` : `Filter by ${label}`
    }
    const active = activeFilterCount()
    clearFiltersButton.hidden = active === 0
    clearFiltersEmpty.hidden = active === 0
  }

  function radioOption(name: string, option: string, value: string, label: string, count: number | null, checked: boolean): string {
    const amount = count === null ? "" : `<span class="filter-option-count">${count}</span>`
    return `<label class="filter-option${checked ? " selected" : ""}"><input type="radio" name="${name}" value="${escape(value)}" data-filter-option="${option}"${checked ? " checked" : ""}><span>${escape(label)}</span>${amount}</label>`
  }

  function filterBody(key: SessionSortKey): string {
    switch (key) {
      case "session":
        return `<label class="filter-text-field"><span class="sr-only">Session ID contains</span><input type="search" data-filter-field="session" value="${escape(columnFilters.session)}" placeholder="Contains session ID…" autocomplete="off" spellcheck="false" maxlength="200"></label>`
      case "host": {
        const hosts = historyHosts(state?.snapshot ?? null)
        const selected = state?.host ?? ""
        if (selected && !hosts.includes(selected)) hosts.push(selected)
        const allSessions = displaySessions(state?.snapshot ?? null)
        const counts = new Map<string, number>()
        for (const session of allSessions) {
          for (const host of session.hosts) counts.set(host, (counts.get(host) ?? 0) + 1)
        }
        const values = [
          { value: "", label: "All hosts", count: allSessions.length },
          ...hosts.map((host) => ({ value: host, label: host, count: counts.get(host) ?? 0 })),
        ]
        return `<div class="filter-options" role="radiogroup" aria-label="Remote host">${values.map((option) => radioOption("filter-host", "host", option.value, option.label, option.count, option.value === selected)).join("")}</div>`
      }
      case "state": {
        const scoped = displaySessions(state?.snapshot ?? null, state?.host ?? "")
        const counts = { active: 0, idle: 0, attention: 0 }
        for (const session of scoped) counts[sessionState(session)]++
        const values = [
          { value: "all", label: "All states", count: scoped.length },
          { value: "active", label: "Active", count: counts.active },
          { value: "idle", label: "Idle", count: counts.idle },
          { value: "attention", label: "Needs attention", count: counts.attention },
        ]
        return `<div class="filter-options" role="radiogroup" aria-label="State">${values.map((option) => radioOption("filter-state", "state", option.value, option.label, option.count, option.value === filterValue)).join("")}</div>`
      }
      case "requests":
        return `<div class="filter-range-fields">
          <label class="filter-range-field"><span>Minimum</span><input type="number" min="0" step="1" inputmode="numeric" placeholder="No minimum" data-filter-field="requestsMin" value="${escape(columnFilters.requestsMin)}"></label>
          <span class="filter-range-separator">to</span>
          <label class="filter-range-field"><span>Maximum</span><input type="number" min="0" step="1" inputmode="numeric" placeholder="No maximum" data-filter-field="requestsMax" value="${escape(columnFilters.requestsMax)}"></label>
        </div>
        <p class="filter-popover-note">Whole requests. Leave a field blank for no limit.</p>`
      case "original":
        return `<div class="filter-range-fields">
          <label class="filter-range-field"><span>Minimum</span><input type="text" inputmode="decimal" placeholder="e.g. 1 MiB" data-filter-field="originalMin" value="${escape(columnFilters.originalMin)}"></label>
          <span class="filter-range-separator">to</span>
          <label class="filter-range-field"><span>Maximum</span><input type="text" inputmode="decimal" placeholder="e.g. 100 MiB" data-filter-field="originalMax" value="${escape(columnFilters.originalMax)}"></label>
        </div>
        <p class="filter-popover-note">Accepts B, KB, KiB, MB, MiB, GB, and GiB. Blank means no limit.</p>`
      case "uploaded":
        return `<div class="filter-range-fields">
          <label class="filter-range-field"><span>Minimum</span><input type="text" inputmode="decimal" placeholder="e.g. 1 MiB" data-filter-field="uploadedMin" value="${escape(columnFilters.uploadedMin)}"></label>
          <span class="filter-range-separator">to</span>
          <label class="filter-range-field"><span>Maximum</span><input type="text" inputmode="decimal" placeholder="e.g. 100 MiB" data-filter-field="uploadedMax" value="${escape(columnFilters.uploadedMax)}"></label>
        </div>
        <p class="filter-popover-note">Accepts B, KB, KiB, MB, MiB, GB, and GiB. Blank means no limit.</p>`
      case "reduction":
        return `<div class="filter-range-fields">
          <label class="filter-range-field"><span>Minimum</span><input type="number" step="any" placeholder="No minimum" data-filter-field="reductionMin" value="${escape(columnFilters.reductionMin)}"></label>
          <span class="filter-range-separator">to</span>
          <label class="filter-range-field"><span>Maximum</span><input type="number" step="any" placeholder="No maximum" data-filter-field="reductionMax" value="${escape(columnFilters.reductionMax)}"></label>
        </div>
        <p class="filter-popover-note">Percent. Negative reductions are allowed.</p>`
      case "activity":
        return `<div class="filter-range-fields">
          <label class="filter-range-field"><span>From</span><input type="date" data-filter-field="activityFrom" value="${escape(columnFilters.activityFrom)}"></label>
          <span class="filter-range-separator">to</span>
          <label class="filter-range-field"><span>To</span><input type="date" data-filter-field="activityTo" value="${escape(columnFilters.activityTo)}"></label>
        </div>
        <p class="filter-popover-note">Inclusive dates in local time.</p>`
    }
  }

  function markInvalid(field: keyof SessionFilterInput, invalid: boolean): void {
    const input = popoverBody.querySelector<HTMLInputElement>(`[data-filter-field="${field}"]`)
    if (!input) return
    if (invalid) input.setAttribute("aria-invalid", "true")
    else input.removeAttribute("aria-invalid")
  }

  function updateFilterHint(): void {
    const key = openFilterKey
    if (!key) {
      popoverHint.hidden = true
      return
    }
    let message = ""
    if (key === "requests" || key === "original" || key === "uploaded" || key === "reduction") {
      const minField = `${key}Min` as keyof SessionFilterInput
      const maxField = `${key}Max` as keyof SessionFilterInput
      const parse = key === "original" || key === "uploaded" ? parseByteSize : parseFilterNumber
      const minRaw = columnFilters[minField].trim()
      const maxRaw = columnFilters[maxField].trim()
      const min = minRaw ? parse(minRaw) : null
      const max = maxRaw ? parse(maxRaw) : null
      const invalidMin = minRaw !== "" && (min === null || (key === "requests" && min < 0))
      const invalidMax = maxRaw !== "" && (max === null || (key === "requests" && max < 0))
      markInvalid(minField, invalidMin)
      markInvalid(maxField, invalidMax)
      if (invalidMin || invalidMax) message = key === "requests" ? "Enter a non-negative number." : key === "reduction" ? "Enter a valid percentage." : "Enter sizes like 1 MiB or 500 KB."
      else if (min !== null && max !== null && min > max) {
        message = "Minimum is greater than maximum."
        markInvalid(minField, true)
        markInvalid(maxField, true)
      }
    } else if (key === "activity") {
      const fromRaw = columnFilters.activityFrom.trim()
      const toRaw = columnFilters.activityTo.trim()
      const from = fromRaw ? parseDateBound(fromRaw) : null
      const to = toRaw ? parseDateBound(toRaw, true) : null
      const invalidFrom = fromRaw !== "" && from === null
      const invalidTo = toRaw !== "" && to === null
      markInvalid("activityFrom", invalidFrom)
      markInvalid("activityTo", invalidTo)
      if (invalidFrom || invalidTo) message = "Enter valid dates."
      else if (from !== null && to !== null && from > to) {
        message = "The start date is after the end date."
        markInvalid("activityFrom", true)
        markInvalid("activityTo", true)
      }
    }
    popoverHint.textContent = message
    popoverHint.hidden = !message
  }

  function renderFilterBody(): void {
    const key = openFilterKey
    if (!key) return
    popoverBody.innerHTML = filterBody(key)
    popoverHint.hidden = true
    popoverHint.textContent = ""
    for (const input of popoverBody.querySelectorAll<HTMLInputElement>("input[data-filter-field]")) {
      input.addEventListener("input", () => onFilterInput(input))
    }
    for (const radio of popoverBody.querySelectorAll<HTMLInputElement>("input[data-filter-option]")) {
      radio.addEventListener("change", () => onFilterOption(radio))
    }
    updateFilterHint()
  }

  function focusFilterControl(): void {
    const target = popoverBody.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? popoverBody.querySelector<HTMLElement>("input, select, button")
    if (!target) return
    target.focus({ preventScroll: true })
    if (target instanceof HTMLInputElement && (target.type === "search" || target.type === "text")) {
      const length = target.value.length
      target.setSelectionRange?.(length, length)
    }
  }

  function positionPopover(trigger: HTMLButtonElement): void {
    const view = doc.defaultView
    popover.hidden = false
    const rect = trigger.getBoundingClientRect()
    const box = popover.getBoundingClientRect()
    const margin = 12
    const width = box.width || 296
    const height = box.height
    const viewportWidth = view?.innerWidth ?? 1024
    const viewportHeight = view?.innerHeight ?? 768
    const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin))
    let top = rect.bottom + 8
    let placement = "bottom"
    if (height > 0 && top + height > viewportHeight - margin && rect.top - height - 8 >= margin) {
      top = rect.top - height - 8
      placement = "top"
    }
    popover.style.top = `${Math.round(top)}px`
    popover.style.left = `${Math.round(left)}px`
    popover.dataset.placement = placement
    const caret = Math.max(14, Math.min(width - 14, rect.left + rect.width / 2 - left))
    popoverCaret.style.left = `${Math.round(caret)}px`
  }

  function openFilterPanel(key: SessionSortKey, trigger: HTMLButtonElement): void {
    if (openFilterKey === key) {
      closeFilterPanel(true)
      return
    }
    if (openFilterKey) closeFilterPanel(false)
    openFilterKey = key
    filterTrigger = trigger
    popoverTitle.textContent = `Filter by ${sortLabels[key]}`
    renderFilterBody()
    for (const button of filterButtons) button.setAttribute("aria-expanded", String(button === trigger))
    positionPopover(trigger)
    focusFilterControl()
  }

  function closeFilterPanel(returnFocus: boolean): void {
    if (!openFilterKey) return
    const hadFocus = popover.contains(doc.activeElement)
    const trigger = filterTrigger
    openFilterKey = null
    filterTrigger = null
    popover.hidden = true
    popoverBody.replaceChildren()
    popoverHint.hidden = true
    popoverHint.textContent = ""
    for (const button of filterButtons) button.setAttribute("aria-expanded", "false")
    if (returnFocus && hadFocus && trigger) trigger.focus({ preventScroll: true })
  }

  function onFilterInput(input: HTMLInputElement): void {
    const field = input.dataset.filterField as keyof SessionFilterInput | undefined
    if (!field) return
    columnFilters = { ...columnFilters, [field]: input.value }
    page = 1
    updateFilterHint()
    renderSessions()
  }

  function onFilterOption(radio: HTMLInputElement): void {
    const option = radio.dataset.filterOption
    if (!option) return
    for (const label of popoverBody.querySelectorAll(".filter-option")) {
      label.classList.toggle("selected", label.contains(radio))
    }
    page = 1
    if (option === "host") {
      options.onHostChange(radio.value)
      return
    }
    if (option === "state") setFilter(radio.value)
  }

  function clearCurrentFilter(): void {
    const key = openFilterKey
    if (!key) return
    page = 1
    switch (key) {
      case "session": columnFilters = { ...columnFilters, session: "" }; break
      case "host": options.onHostChange(""); break
      case "state": filterValue = "all"; break
      case "requests": columnFilters = { ...columnFilters, requestsMin: "", requestsMax: "" }; break
      case "original": columnFilters = { ...columnFilters, originalMin: "", originalMax: "" }; break
      case "uploaded": columnFilters = { ...columnFilters, uploadedMin: "", uploadedMax: "" }; break
      case "reduction": columnFilters = { ...columnFilters, reductionMin: "", reductionMax: "" }; break
      case "activity": columnFilters = { ...columnFilters, activityFrom: "", activityTo: "" }; break
    }
    renderFilterBody()
    renderSessions()
    focusFilterControl()
  }

  function clearAllFilters(): void {
    if (openFilterKey) closeFilterPanel(false)
    columnFilters = emptySessionFilters()
    filterValue = "all"
    search.value = ""
    page = 1
    if ((state?.host ?? "") !== "") options.onHostChange("")
    renderSessions()
  }

  function renderPending(phase: "loading" | "unavailable") {
    const loading = phase === "loading"
    pendingPhase = phase
    empty.hidden = false
    empty.classList.toggle("loading", loading)
    emptyIcon.innerHTML = loading ? '<span class="loading-spinner large" aria-hidden="true"></span>' : emptyIconMarkup
    required(empty, "h3").textContent = loading ? "Loading sessions…" : "Sessions unavailable"
    required(empty, "p").textContent = loading
      ? "Waiting for the local gateway to return retained sessions."
      : "The local gateway did not respond. Retrying automatically."
    clearFiltersEmpty.hidden = true
    tableScroll.hidden = true
    exportButton.disabled = true
    previous.disabled = true
    next.disabled = true
    setText("session-count", "—")
    setText("page-label", "Page 1 of 1")
    summary.textContent = loading ? "Loading sessions…" : "Sessions unavailable"
    root.setAttribute("aria-busy", String(loading))
    root.dataset.phase = phase
  }

  function renderSessions() {
    updateSortControls()
    if (!state?.snapshot) {
      renderPending(state && dataPhase(state) === "unavailable" ? "unavailable" : "loading")
      return
    }
    if (pendingPhase) {
      pendingPhase = null
      empty.classList.remove("loading")
      emptyIcon.innerHTML = emptyIconMarkup
      root.setAttribute("aria-busy", "false")
      root.dataset.phase = "ready"
    }
    const allSessions = displaySessions(state?.snapshot ?? null, state?.host ?? "")
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
      const label = session.id || "Unattributed requests"
      return `<tr><td><button class="session-name" type="button" data-session-id="${escape(session.id)}" title="${escape(label)}" translate="no">${escape(label)}</button></td><td><span class="session-host" translate="no" title="${escape(session.hosts.join(", ") || "local")}">${escape(session.hosts.join(", ") || "local")}</span></td><td>${pill(current === "active" ? `${session.active} active` : current === "attention" ? "Attention" : "Idle", current)}</td><td class="number">${integer(session.requests)}</td><td class="number">${escape(bytes(session.body_bytes))}</td><td class="number">${escape(bytes(session.encoded_upload_bytes))}</td><td class="number"><span class="reduction-cell ${reduction !== null && reduction < 0 ? "negative" : ""}">${escape(percentage(reduction))}<span class="reduction-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, reduction ?? 0))}%"></span></span></span></td><td title="${escape(new Date(session.updated_at).toLocaleString())}">${escape(relativeTime(session.updated_at))}</td><td><button class="row-detail" type="button" data-session-id="${escape(session.id)}" aria-label="Inspect ${escape(label)}">${iconMarkup("arrow", 16)}</button></td></tr>`
    }).join("")
    if (focusedSession !== undefined) {
      const replacement = [...rowsBody.querySelectorAll<HTMLButtonElement>(`button.${focusedClass}[data-session-id]`)].find((button) => button.dataset.sessionId === focusedSession)
      replacement?.focus({ preventScroll: true })
    }
    empty.hidden = sessions.length > 0
    // Keep the header visible when filters exclude every row so the column
    // filter buttons remain reachable. Hide the table only when there is no
    // retained data at all.
    tableScroll.hidden = allSessions.length === 0
    if (allSessions.length) {
      required(empty, "h3").textContent = "No matching sessions"
      required(empty, "p").textContent = "Change the search, state, host, or column filters."
    } else {
      required(empty, "h3").textContent = "No sessions recorded"
      required(empty, "p").textContent = "Requests routed through the gateway will appear here."
    }
    const totalSessions = allSessions.length
    const activeFilters = activeFilterCount()
    const filterNote = activeFilters ? ` · <span class="active-filter-note">${activeFilters} filter${activeFilters === 1 ? "" : "s"} active</span>` : ""
    const sortNote = ` · sorted by ${sortLabels[sortState.key]} ${sortWord(sortState.direction)}`
    const summaryHtml = sessions.length
      ? `${dataValue(`${start + 1}–${Math.min(start + pageSize, sessions.length)}`)} of ${dataValue(sessions.length)}${sessions.length !== totalSessions ? ` matching (${dataValue(`${integer(totalSessions)} total`)})` : ""} sessions${filterNote}${sortNote}`
      : totalSessions ? `${dataValue(0)} of ${dataValue(integer(totalSessions))} sessions match this filter${filterNote}${sortNote}` : `${dataValue(0)} sessions`
    if (summary.innerHTML !== summaryHtml) summary.innerHTML = summaryHtml
    setText("page-label", `Page ${page} of ${totalPages}`)
    pageSizeSelect.value = String(pageSize)
    previous.disabled = page <= 1
    next.disabled = page >= totalPages
    exportButton.disabled = sessions.length === 0
    setText("session-count", totalSessions)
    updateFilterControls()
    syncUrl()
    if (pendingOpen && state?.snapshot) {
      const sessionId = pendingOpen
      pendingOpen = null
      if (allSessions.some((session) => session.id === sessionId)) openDetail(sessionId)
      else syncUrl()
    }
  }

  function setFilter(value: string): void {
    filterValue = validStates.includes(value) ? value : "all"
    page = 1
    renderSessions()
  }

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
  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      const key = asSortKey(button.dataset.filterKey)
      if (key) openFilterPanel(key, button)
    })
  }
  clearFiltersButton.addEventListener("click", clearAllFilters)
  clearFiltersEmpty.addEventListener("click", clearAllFilters)
  closeFilterButton.addEventListener("click", () => closeFilterPanel(true))
  doneFilterButton.addEventListener("click", () => closeFilterPanel(true))
  clearFilterButton.addEventListener("click", clearCurrentFilter)
  doc.addEventListener("pointerdown", (event) => {
    if (!openFilterKey) return
    const target = event.target
    if (target && popover.contains(target as Node)) return
    if (target instanceof Node && filterTrigger?.contains(target)) return
    if (target instanceof Element && target.closest("button[data-filter-key]")) return
    closeFilterPanel(false)
  })
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openFilterKey) return
    event.preventDefault()
    closeFilterPanel(true)
  })
  const closeOnScroll = (event: Event) => {
    if (!openFilterKey) return
    if (event.target instanceof Node && popover.contains(event.target)) return
    closeFilterPanel(false)
  }
  doc.defaultView?.addEventListener("scroll", closeOnScroll, true)
  doc.defaultView?.addEventListener("resize", () => closeFilterPanel(false))
  search.addEventListener("input", () => { page = 1; renderSessions() })
  previous.addEventListener("click", () => { page--; renderSessions() })
  next.addEventListener("click", () => { page++; renderSessions() })
  pageSizeSelect.addEventListener("change", () => {
    const selected = pageSizes.find((size) => String(size) === pageSizeSelect.value)
    if (!selected || selected === pageSize) return
    pageSize = selected
    page = 1
    renderSessions()
  })
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
  updateFilterControls()

  return {
    render(nextState) {
      state = nextState
      renderSessions()
      if (dialog.open) renderDetail()
    },
  }
}
