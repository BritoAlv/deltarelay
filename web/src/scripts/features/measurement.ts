import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, duration, percentage, relativeTime, sessionState } from "../../lib/metrics.js"
import { barComparison, requestMeasurement, sessionMeasurement } from "../../lib/measurement.js"
import {
  catalogDays,
  catalogEntry,
  catalogReduction,
  catalogSessions,
  catalogState,
  filterCatalogSessions,
  sessionDayLabel,
  type CatalogAvailability,
  type CatalogDay,
  type CatalogSession,
} from "../../lib/session-catalog.js"
import type { DashboardViewState } from "../../lib/state.js"
import type { RelayRequest, Session, Snapshot } from "../../lib/types.js"
import { readParams, replaceParams } from "../../lib/url-state.js"
import { requiredById } from "../dom.js"
import { mountInspection } from "./inspection.js"

export interface MeasurementFeature {
  render(state: DashboardViewState): void
  destroy(): void
}

const requestPageSize = 8
const sessionPageSize = 8
const integer = (value: number) => value.toLocaleString()
const pill = (label: string, state: string) => `<span class="status-pill ${state}">${escape(label)}</span>`

function stat(label: string, value: string, detail: string, tone = ""): string {
  return `<div class="trace-stat"><span>${escape(label)}</span><strong class="${tone}">${escape(value)}</strong><small>${escape(detail)}</small></div>`
}

function barRow(label: string, value: string, width: number, tone: string): string {
  const fill = Math.max(0, Math.min(100, width)) / 100
  return `<div class="trace-bar-row"><span>${escape(label)}</span><div class="trace-bar-track"><span class="trace-bar-fill ${tone}" style="transform:scaleX(${fill.toFixed(4)})"></span></div><strong>${escape(value)}</strong></div>`
}

function detail(label: string, value: string, tone = ""): string {
  return `<div class="trace-request-detail"><span>${escape(label)}</span><strong class="${tone}">${escape(value)}</strong></div>`
}

function positivePage(value: string | null): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function validDay(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""
}

export function mountMeasurement(root: HTMLElement): MeasurementFeature {
  const trigger = requiredById<HTMLButtonElement>(root, "measurement-session-trigger")
  const triggerTitle = requiredById(root, "measurement-session-trigger-title")
  const triggerMeta = requiredById(root, "measurement-session-trigger-meta")
  const dialog = requiredById<HTMLDialogElement>(root, "measurement-session-dialog")
  const closeDialog = requiredById<HTMLButtonElement>(root, "close-measurement-session")
  const search = requiredById<HTMLInputElement>(root, "measurement-session-search")
  const daySelect = requiredById<HTMLSelectElement>(root, "measurement-session-day")
  const availabilitySelect = requiredById<HTMLSelectElement>(root, "measurement-session-availability")
  const rowsBody = requiredById(root, "measurement-session-rows")
  const tableScroll = requiredById<HTMLElement>(root, "measurement-session-scroll")
  const emptyBrowser = requiredById<HTMLElement>(root, "measurement-session-empty")
  const summary = requiredById(root, "measurement-session-summary")
  const previous = requiredById<HTMLButtonElement>(root, "measurement-session-previous")
  const next = requiredById<HTMLButtonElement>(root, "measurement-session-next")
  const pageLabel = requiredById(root, "measurement-session-page")
  const notice = requiredById<HTMLElement>(root, "measurement-session-notice")
  const dialogSummary = requiredById(root, "measurement-session-dialog-summary")
  const trace = requiredById(root, "measurement-trace")
  const retention = requiredById(root, "retention-note")
  const doc = root.ownerDocument
  const inspectorRoot = requiredById<HTMLElement>(root, "request-inspector")
  const inspector = mountInspection(inspectorRoot)
  const initial = readParams(doc)
  const requestParam = Number(initial.get("request"))
  let state: DashboardViewState | null = null
  let catalogEntries: CatalogSession[] = []
  let selectedSession: string | null = initial.get("session")
  let selectedRequest: number | null = Number.isSafeInteger(requestParam) && requestParam > 0 ? requestParam : null
  let showAll = false
  let sessionQuery = initial.get("q") ?? ""
  let sessionDay = validDay(initial.get("day"))
  let sessionAvailability: CatalogAvailability = initial.get("show") === "measured" ? "measured" : "all"
  let sessionPage = positivePage(initial.get("page"))
  let daySignature = ""
  let browserNotice = ""
  const openRequests = new Set<string>()

  function syncTraceUrl(): void {
    replaceParams(doc, {
      session: selectedSession === null ? null : selectedSession,
      request: selectedRequest !== null ? String(selectedRequest) : null,
      day: sessionDay || null,
      q: sessionQuery.trim() || null,
      show: sessionAvailability === "measured" ? "measured" : null,
      page: sessionPage > 1 ? String(sessionPage) : null,
    })
  }

  function selected(snapshot: Snapshot): Session | undefined {
    return snapshot.history.sessions.find((session) => session.id === selectedSession)
  }

  function sessionRequests(snapshot: Snapshot, session: Session): RelayRequest[] {
    return snapshot.history.recent_requests
      .filter((request) => request.session_id === session.id)
      .sort((a, b) => b.sequence - a.sequence)
  }

  function measuredEntries(): CatalogSession[] {
    return catalogEntries.filter((entry) => Boolean(entry.gateway))
  }

  function retentionText(snapshot: Snapshot): string {
    const history = snapshot.history
    const traffic = history.traffic
    const trafficText = traffic
      ? ` Traffic charts keep hourly aggregates for ${Math.round(traffic.hourly.retention_seconds / 86_400)} days and daily aggregates for ${Math.round(traffic.daily.retention_seconds / 86_400)} days.`
      : ""
    const catalogText = state?.catalog ? " The session browser also lists sessions stored by OpenCode; only sessions with gateway measurements can be traced." : ""
    return `History since ${new Date(history.since).toLocaleString()}. Keeps up to ${history.session_limit} gateway sessions and ${integer(history.request_limit)} requests.${trafficText} ${integer(history.evicted_sessions)} older sessions and ${integer(history.dropped_requests)} request entries trimmed; global totals are preserved. Session totals restart if an evicted session reappears. Earlier gateway history is not imported from logs. ${history.persistent ? "History is saved privately on the gateway." : "History is in memory only."}${catalogText}`
  }

  function stateLabel(entry: CatalogSession): string {
    const current = catalogState(entry)
    if (current === "unmeasured") return "Not measured"
    if (current === "active") return `${entry.gateway?.active ?? 0} active`
    if (current === "attention") return "Attention"
    return "Idle"
  }

  function stateTone(entry: CatalogSession): string {
    const current = catalogState(entry)
    return current === "unmeasured" ? "neutral" : current
  }

  function providerLabel(entry: CatalogSession): string {
    if (entry.gateway?.upstream) return entry.gateway.upstream
    if (entry.model) return entry.model
    return entry.project || "OpenCode session"
  }

  function providerDetail(entry: CatalogSession): string {
    const parts: string[] = []
    if (entry.model && entry.model !== providerLabel(entry)) parts.push(entry.model)
    if (entry.agent) parts.push(entry.agent)
    return parts.join(" · ")
  }

  function renderTrigger(): void {
    const snapshot = state?.snapshot
    const entry = catalogEntry(catalogEntries, selectedSession)
    if (!snapshot) {
      triggerTitle.textContent = "Waiting for local gateway…"
      triggerMeta.textContent = ""
      trigger.disabled = true
      return
    }
    if (catalogEntries.length === 0) {
      triggerTitle.textContent = "No stored sessions"
      triggerMeta.textContent = ""
      trigger.disabled = true
      return
    }
    if (entry) {
      triggerTitle.textContent = entry.title || (entry.id || "Unattributed requests")
      const parts = [entry.id || "Unattributed requests"]
      if (entry.gateway?.upstream) parts.push(entry.gateway.upstream)
      else if (entry.model) parts.push(entry.model)
      if (entry.gateway) parts.push(`${integer(entry.gateway.requests)} requests`)
      const reduction = catalogReduction(entry)
      if (reduction !== null) parts.push(`${percentage(reduction)} reduction`)
      if (!entry.gateway) parts.push("no gateway measurements")
      triggerMeta.textContent = parts.join(" · ")
    } else {
      triggerTitle.textContent = "Choose a session"
      triggerMeta.textContent = `${integer(catalogEntries.length)} stored · ${integer(measuredEntries().length)} measured`
    }
    trigger.disabled = false
  }

  function updateDayOptions(days: CatalogDay[]): void {
    const signature = days.map((day) => `${day.key}:${day.count}:${day.measured}`).join("|")
    if (signature !== daySignature) {
      daySignature = signature
      const options = [doc.createElement("option")]
      options[0]!.value = ""
      options[0]!.textContent = "All days"
      for (const day of days) {
        const option = doc.createElement("option")
        option.value = day.key
        option.textContent = `${day.label} · ${integer(day.count)} stored · ${integer(day.measured)} measured`
        options.push(option)
      }
      daySelect.replaceChildren(...options)
    }
    if (sessionDay && !days.some((day) => day.key === sessionDay)) sessionDay = ""
    daySelect.value = sessionDay
  }

  function renderBrowserNotice(): void {
    let message = browserNotice
    if (!message && state?.catalogError) message = state.catalog
      ? "OpenCode session titles may be stale; gateway measurements remain current."
      : "OpenCode session metadata is unavailable. Showing gateway-retained sessions by ID."
    else if (!message && state?.catalog?.stale) message = "OpenCode session titles may be stale; gateway measurements remain current."
    else if (!message && state?.catalog?.truncated) message = "Showing the first 2,000 sessions stored by OpenCode. Use search or the day filter to narrow the list."
    notice.hidden = !message
    if (message) notice.textContent = message
  }

  function renderSessionBrowser(): void {
    const days = catalogDays(catalogEntries)
    updateDayOptions(days)
    search.value = sessionQuery
    availabilitySelect.value = sessionAvailability
    const filtered = filterCatalogSessions(catalogEntries, sessionQuery, sessionDay, sessionAvailability)
    const totalPages = Math.max(1, Math.ceil(filtered.length / sessionPageSize))
    sessionPage = Math.min(Math.max(1, sessionPage), totalPages)
    const start = (sessionPage - 1) * sessionPageSize
    const visible = filtered.slice(start, start + sessionPageSize)
    const active = doc.activeElement as HTMLElement | null
    const focusedChoice = active && rowsBody.contains(active) ? active.closest<HTMLButtonElement>("[data-session-choice]")?.dataset.sessionChoice : undefined
    rowsBody.innerHTML = visible.map((entry) => {
      const measured = Boolean(entry.gateway)
      const reduction = catalogReduction(entry)
      const title = entry.title || (entry.id ? "Untitled session" : "Unattributed requests")
      const provider = providerLabel(entry)
      const providerNote = providerDetail(entry)
      return `<tr class="session-browser-row${measured ? " measured" : " unmeasured"}${entry.id === selectedSession ? " selected" : ""}">
        <td><button class="session-browser-choice" type="button" data-session-choice="${escape(entry.id)}" aria-pressed="${entry.id === selectedSession}"${measured ? "" : ' aria-disabled="true"'} title="${escape(entry.title || entry.id || "Unattributed requests")}"><span class="session-browser-title">${escape(title)}</span><span class="session-browser-meta"><code translate="no">${escape(entry.id || "Unattributed requests")}</code>${entry.project ? ` · ${escape(entry.project)}` : ""}</span></button></td>
        <td><span class="session-browser-time">${escape(sessionDayLabel(entry.created_at))}</span><span class="session-browser-sub">last ${escape(relativeTime(entry.updated_at))}</span></td>
        <td><span class="session-browser-provider">${escape(provider)}</span>${providerNote ? `<span class="session-browser-sub">${escape(providerNote)}</span>` : ""}</td>
        <td class="number">${measured ? integer(entry.gateway?.requests ?? 0) : "—"}</td>
        <td class="number">${measured ? escape(percentage(reduction)) : "—"}</td>
        <td><div class="session-browser-status">${pill(stateLabel(entry), stateTone(entry))}<span class="session-browser-badge ${measured ? "measured" : "unmeasured"}">${measured ? "Measured" : "No gateway data"}</span></div></td>
      </tr>`
    }).join("")
    if (focusedChoice !== undefined) {
      [...rowsBody.querySelectorAll<HTMLButtonElement>("[data-session-choice]")].find((button) => button.dataset.sessionChoice === focusedChoice)?.focus({ preventScroll: true })
    }
    emptyBrowser.hidden = filtered.length > 0
    tableScroll.hidden = filtered.length === 0
    const total = catalogEntries.length
    const measured = measuredEntries().length
    if (filtered.length === 0) {
      summary.textContent = total ? `0 of ${integer(total)} stored sessions match` : "No stored sessions"
    } else {
      summary.textContent = `${integer(start + 1)}–${integer(Math.min(start + sessionPageSize, filtered.length))} of ${integer(filtered.length)}${filtered.length !== total ? ` matching (${integer(total)} stored)` : ""} session${filtered.length === 1 ? "" : "s"} · ${integer(measured)} measured`
    }
    pageLabel.textContent = `Page ${sessionPage} of ${totalPages}`
    previous.disabled = sessionPage <= 1
    next.disabled = sessionPage >= totalPages
    const catalogCount = state?.catalog?.sessions.length ?? 0
    dialogSummary.textContent = catalogCount > 0
      ? `All sessions stored by OpenCode${state?.catalog?.truncated ? " (first 2,000)" : ""}. Only sessions with gateway measurements can be traced.`
      : state?.catalog
        ? "OpenCode returned no stored sessions. Showing sessions retained by the gateway."
        : "OpenCode session metadata is unavailable. Showing sessions retained by the gateway."
    renderBrowserNotice()
    syncTraceUrl()
  }

  function openSessionBrowser(): void {
    if (trigger.disabled) return
    browserNotice = ""
    if (!dialog.open) dialog.showModal()
    renderSessionBrowser()
    search.focus()
  }

  function chooseSession(id: string): void {
    const entry = catalogEntry(catalogEntries, id)
    if (!entry?.gateway) {
      browserNotice = entry
        ? "This session is stored by OpenCode but has no retained gateway measurements, so it cannot be traced."
        : "This session is no longer available."
      renderSessionBrowser()
      return
    }
    selectedSession = id
    selectedRequest = null
    showAll = false
    browserNotice = ""
    const filtered = filterCatalogSessions(catalogEntries, sessionQuery, sessionDay, sessionAvailability)
    const index = filtered.findIndex((candidate) => candidate.id === id)
    if (index >= 0) sessionPage = Math.floor(index / sessionPageSize) + 1
    syncTraceUrl()
    renderTrigger()
    renderTrace()
    if (dialog.open) dialog.close()
  }

  function empty(message: string, heading = "No retained sessions"): void {
    trace.innerHTML = `<div class="empty-state"><h3>${escape(heading)}</h3><p>${escape(message)}</p></div>`
    renderTrigger()
    inspector.update(null, state?.snapshot?.inspection, state?.snapshot?.collected_at ?? "")
  }

  function renderUnavailable(): void {
    triggerTitle.textContent = "Waiting for local gateway…"
    triggerMeta.textContent = ""
    trigger.disabled = true
    retention.textContent = "History retains up to 256 gateway sessions and 1,000 requests. Global totals survive retention trimming. Earlier gateway history is not imported from logs."
    trace.innerHTML = `<div class="empty-state"><h3>Waiting for local gateway…</h3><p>Start the local gateway and dashboard server to trace retained sessions. No provider requests are sent by this page.</p></div>`
    inspector.update(null, undefined, "")
    if (dialog.open) renderSessionBrowser()
  }

  function renderRequest(request: RelayRequest, snapshot: Snapshot): string {
    const measured = requestMeasurement(request, snapshot.collected_at)
    const bars = barComparison(measured.original, measured.encoded)
    const tone = request.state === "completed" ? "good" : request.state === "running" ? "active" : request.state === "cancelled" ? "neutral" : "warning"
    const reductionTone = measured.reduction !== null && measured.reduction < 0 ? "negative" : "accent"
    const status = request.status ? ` · HTTP ${request.status}` : ""
    const open = openRequests.has(request.id) ? " open" : ""
    const formula = measured.pending
      ? "No finished transfer accounting yet."
      : measured.original > 0
        ? `1 − ${bytes(measured.encoded)} ÷ ${bytes(measured.original)} = ${percentage(measured.reduction)}`
        : "Original body is zero; reduction is unavailable."
    const body = measured.pending
      ? `<div class="trace-request-body"><p class="trace-request-note">Transfer totals are written when this request finishes. Elapsed time comes from the latest local gateway observation.</p><button class="text-button" type="button" data-inspect-request="${request.sequence}">Inspect Request Evidence</button></div>`
      : `<div class="trace-request-body">
          <div class="trace-request-bar" role="img" aria-label="Original body ${escape(bytes(measured.original))}, encoded upload ${escape(bytes(measured.encoded))}, saved ${escape(bytes(measured.saved))}">
            ${barRow("Original", bytes(measured.original), bars.originalPercent, "original")}
            ${barRow("Sent", bytes(measured.encoded), bars.encodedPercent, "accent")}
            ${barRow(bars.negative ? "Extra" : "Saved", bytes(Math.abs(measured.saved)), bars.savedPercent, bars.negative ? "danger" : "saved")}
          </div>
          <div class="trace-request-grid">
            ${detail("Original body", bytes(measured.original))}
            ${detail("Encoded upload", bytes(measured.encoded))}
            ${detail(measured.saved < 0 ? "Extra upload" : "Saved", bytes(Math.abs(measured.saved)), measured.saved < 0 ? "negative" : "accent")}
            ${detail("Reduction", percentage(measured.reduction), reductionTone)}
            ${detail("Reused content", bytes(measured.reused))}
            ${detail("Missing content", bytes(measured.missing))}
            ${detail("Raw chunks uploaded", bytes(measured.uploaded))}
            ${detail("HTTP attempts", integer(measured.httpRequests))}
            ${detail("Chunks", integer(request.transfer.chunks))}
            ${detail("Unique chunks", integer(request.transfer.unique_chunks))}
            ${detail("Uploaded chunks", integer(request.transfer.uploaded_chunks))}
            ${detail("Response download", bytes(request.response_bytes))}
          </div>
          <p class="trace-formula"><code translate="no">${escape(formula)}</code></p>
          <p class="trace-request-note">Response bytes are shown for context but never subtracted from upload savings. Failed and cancelled attempts remain included in session totals. Uploaded-chunk counters follow logical batches; after recovery, inspect attempt evidence for actual retransmissions.</p>
          ${request.error_code ? `<p class="request-error">${escape(request.error_code)}</p>` : ""}
          <button class="text-button" type="button" data-inspect-request="${request.sequence}">Inspect Request Evidence</button>
        </div>`
    return `<details class="trace-request${selectedRequest === request.sequence ? " selected" : ""}" data-request-id="${escape(request.id)}" data-request-sequence="${request.sequence}"${open}>
      <summary>
        <div class="trace-request-heading">
          <code translate="no">${escape(request.id)}</code>
          <span class="trace-request-meta">${escape(request.kind)} · ${escape(relativeTime(request.started_at))} · ${escape(duration(measured.elapsedMs))}${escape(status)}</span>
          ${request.error_code ? `<span class="trace-request-error">${escape(request.error_code)}</span>` : ""}
        </div>
        <div class="trace-request-values">
          ${selectedRequest === request.sequence ? '<span class="trace-request-selected">Selected</span>' : ""}
          ${pill(request.state, tone)}
          <strong class="${measured.reduction !== null && measured.reduction < 0 ? "negative" : "accent"}">${escape(measured.pending ? "Pending" : percentage(measured.reduction))}</strong>
          <span>${measured.pending ? "Transfer totals pending" : `${escape(bytes(measured.original))} → ${escape(bytes(measured.encoded))}`}</span>
        </div>
      </summary>
      ${body}
    </details>`
  }

  function bindOpenState(): void {
    trace.querySelectorAll<HTMLDetailsElement>("details[data-request-id]").forEach((request) => {
      request.addEventListener("toggle", () => {
        const id = request.dataset.requestId ?? ""
        if (!request.open) {
          openRequests.delete(id)
          return
        }
        openRequests.add(id)
        const sequence = Number(request.dataset.requestSequence)
        if (Number.isSafeInteger(sequence) && sequence > 0 && sequence !== selectedRequest) {
          selectedRequest = sequence
          renderTrace()
        }
      })
    })
  }

  interface TraceFocus {
    inspect?: string
    more: boolean
    requestId?: string
    summary: boolean
  }

  function traceFocus(): TraceFocus | null {
    const active = doc.activeElement as HTMLElement | null
    if (!active || !trace.contains(active)) return null
    return {
      inspect: active.closest<HTMLElement>("[data-inspect-request]")?.dataset.inspectRequest,
      more: Boolean(active.closest("[data-trace-more]")),
      requestId: active.closest<HTMLDetailsElement>("details[data-request-id]")?.dataset.requestId,
      summary: Boolean(active.closest("summary")),
    }
  }

  function restoreTraceFocus(focus: TraceFocus | null): void {
    if (!focus) return
    let target: HTMLElement | null = null
    if (focus.inspect) target = [...trace.querySelectorAll<HTMLElement>("[data-inspect-request]")].find((element) => element.dataset.inspectRequest === focus.inspect) ?? null
    else if (focus.more) target = trace.querySelector<HTMLElement>("[data-trace-more]")
    else if (focus.requestId) {
      const details = [...trace.querySelectorAll<HTMLDetailsElement>("details[data-request-id]")].find((element) => element.dataset.requestId === focus.requestId)
      target = focus.summary ? details?.querySelector("summary") ?? null : details ?? null
    }
    target?.focus({ preventScroll: true })
  }

  function renderTrace(): void {
    if (!state?.snapshot) return
    const snapshot = state.snapshot
    const session = selected(snapshot)
    if (!session) {
      const fallback = measuredEntries()[0]
      if (!fallback) {
        selectedSession = null
        retention.textContent = retentionText(snapshot)
        syncTraceUrl()
        const message = catalogEntries.length
          ? `${integer(catalogEntries.length)} session${catalogEntries.length === 1 ? "" : "s"} are stored by OpenCode, but none have retained gateway measurements. DeltaRelay only measures requests routed through its gateway.`
          : "Requests routed through the gateway will appear here. Global totals remain available."
        empty(message, catalogEntries.length ? "No gateway measurements" : "No retained sessions")
        return
      }
      selectedSession = fallback.id
      showAll = false
      syncTraceUrl()
      renderTrigger()
    }
    const current = selected(snapshot)
    if (!current) return
    const entry = catalogEntry(catalogEntries, current.id)
    const requests = sessionRequests(snapshot, current)
    if (!requests.some((request) => request.sequence === selectedRequest)) selectedRequest = requests[0]?.sequence ?? null
    const inspected = requests.find((request) => request.sequence === selectedRequest) ?? null
    const measured = inspected ? requestMeasurement(inspected, snapshot.collected_at) : null
    const pipeline = [
      ["Original body", "Decoded source, before chunking. Inspect bytes or JSON.", measured ? bytes(measured.original) : "—"],
      ["Relay inventory", "Actual chunk availability at an observed inventory.", measured ? bytes(measured.reused) : "—"],
      ["Raw chunks uploaded", "Prepared batches and validated acknowledgments; recovery may re-inventory instead of retransmitting.", measured ? bytes(measured.uploaded) : "—"],
      ["Encoded upload", "Counted transport attempts, encoding and payloads.", measured ? bytes(measured.encoded) : "—"],
      [measured && measured.saved < 0 ? "Extra upload" : "Saved", "Calculated original minus encoded; not another byte stream.", measured ? bytes(Math.abs(measured.saved)) : "—"],
    ] as const
    const sessionSummary = sessionMeasurement(current, requests)
    const bars = barComparison(sessionSummary.original, sessionSummary.encoded)
    const visible = showAll ? requests : requests.slice(0, requestPageSize)
    const reductionTone = sessionSummary.reduction !== null && sessionSummary.reduction < 0 ? "negative" : "accent"
    const savedTone = sessionSummary.saved < 0 ? "negative" : ""
    const stateTone = sessionState(current)
    const reduced = sessionSummary.reduction === null ? "No finished body bytes yet; reduction is unavailable." : `1 − ${bytes(sessionSummary.encoded)} ÷ ${bytes(sessionSummary.original)} = ${percentage(sessionSummary.reduction)}`
    const coverage = sessionSummary.missingRequests > 0
      ? `<p class="trace-coverage">Session totals include ${integer(sessionSummary.missingRequests)} request${sessionSummary.missingRequests === 1 ? "" : "s"} no longer retained. The ledger below covers ${integer(sessionSummary.retainedRequests)} retained entr${sessionSummary.retainedRequests === 1 ? "y" : "ies"}.</p>`
      : ""
    const more = requests.length > requestPageSize
      ? `<button class="text-button trace-more" type="button" data-trace-more>${showAll ? `Show Latest ${requestPageSize}` : `Show All ${integer(requests.length)} Retained Requests`}</button>`
      : ""
    const ledger = requests.length === 0
      ? `<div class="empty-state trace-requests-empty"><h3>No retained request entries</h3><p>Session totals still include ${integer(sessionSummary.totalRequests)} request${sessionSummary.totalRequests === 1 ? "" : "s"}; their request-level entries were trimmed from history.</p></div>`
      : `${coverage}${visible.map((request) => renderRequest(request, snapshot)).join("")}${more}`

    const focus = traceFocus()
    trace.innerHTML = `<div class="trace-session-head">
        <div>
          <div class="trace-session-title">${entry?.title ? `<strong class="trace-session-name">${escape(entry.title)}</strong>` : ""}<code translate="no">${escape(current.id || "Unattributed requests")}</code>${pill(stateTone === "active" ? `${current.active} active` : stateTone === "attention" ? "Attention" : "Idle", stateTone)}</div>
          <p>${escape(current.upstream || "Unknown upstream")}${entry?.model ? ` · ${escape(entry.model)}` : ""}${entry?.agent ? ` · ${escape(entry.agent)}` : ""}${entry?.project ? ` · ${escape(entry.project)}` : ""} · ${integer(sessionSummary.totalRequests)} model requests · ${integer(current.failed)} failed · ${integer(current.cancelled)} cancelled · last activity ${escape(relativeTime(current.updated_at))}</p>
        </div>
        <div class="trace-session-formula"><span>Upload reduction for this session</span><code translate="no">${escape(reduced)}</code></div>
      </div>
      <div class="trace-summary-grid">
        ${stat("Upload reduction", percentage(sessionSummary.reduction), "of original body bytes", reductionTone)}
        ${stat(sessionSummary.saved < 0 ? "Extra upload" : "Bandwidth saved", bytes(Math.abs(sessionSummary.saved)), sessionSummary.saved < 0 ? "encoded − original" : "original − encoded", savedTone)}
        ${stat("Original body", bytes(sessionSummary.original), "100% baseline")}
        ${stat("Encoded upload", bytes(sessionSummary.encoded), "manifests, framing, compression, retries")}
      </div>
      <div class="trace-visual">
        <div class="trace-bars" role="img" aria-label="Original body ${escape(bytes(sessionSummary.original))}, encoded upload ${escape(bytes(sessionSummary.encoded))}, saved ${escape(bytes(sessionSummary.saved))}">
          <h3 class="trace-scope">Session upload totals</h3>
          ${barRow("Original", bytes(sessionSummary.original), bars.originalPercent, "original")}
          ${barRow("Sent", bytes(sessionSummary.encoded), bars.encodedPercent, "accent")}
          ${barRow(bars.negative ? "Extra sent" : "Saved", bytes(Math.abs(sessionSummary.saved)), bars.savedPercent, bars.negative ? "danger" : "saved")}
        </div>
        <div class="trace-pipeline">
          <h3>From body to wire</h3>
          <div class="trace-selected-request">
            <span class="trace-selected-label">Selected request</span>
            ${inspected ? `<code translate="no">${escape(inspected.id)}</code><span class="trace-selected-meta">${escape(inspected.kind)} · ${escape(inspected.state)}${inspected.capture_id ? "" : " · not captured"}</span>` : `<span class="trace-selected-meta">No retained request entries</span>`}
          </div>
          <p class="trace-request-note">Select a request in the list below to update these stages. Request-level application payload, not packet capture; use the evidence inspector for captured payloads.</p>
          <ol>
            ${pipeline.map(([label, note, value], i) => `<li><span>${i+1}</span><div><strong class="trace-pipeline-label">${escape(label)}</strong><p>${escape(note)}</p></div><code>${escape(measured?.pending ? "Pending" : value)}</code></li>`).join("")}
          </ol>
        </div>
      </div>
      <p class="trace-caveat">The comparison bars show session totals; the stages show the selected request. Select a request in the list below to update them. Content reuse and encoded upload are separate views, not an additive stack.</p>
      <div class="trace-requests">
        <div class="trace-requests-head"><div><h3>Requests in this session</h3><p>Retained request entries, newest first. Select one to update the stages above; expand it for full byte accounting.</p></div><span class="section-meta">${integer(requests.length)} retained${sessionSummary.missingRequests ? ` · ${integer(sessionSummary.missingRequests)} trimmed` : ""}</span></div>
        ${ledger}
      </div>`
    bindOpenState()
    restoreTraceFocus(focus)
    inspector.update(inspected, snapshot.inspection, snapshot.collected_at)
    syncTraceUrl()
  }

  trigger.addEventListener("click", () => openSessionBrowser())
  closeDialog.addEventListener("click", () => dialog.close())
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return
    const bounds = dialog.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
  })
  search.addEventListener("input", () => {
    sessionQuery = search.value
    sessionPage = 1
    browserNotice = ""
    renderSessionBrowser()
  })
  daySelect.addEventListener("change", () => {
    sessionDay = daySelect.value
    sessionPage = 1
    browserNotice = ""
    renderSessionBrowser()
  })
  availabilitySelect.addEventListener("change", () => {
    sessionAvailability = availabilitySelect.value === "measured" ? "measured" : "all"
    sessionPage = 1
    browserNotice = ""
    renderSessionBrowser()
  })
  previous.addEventListener("click", () => {
    sessionPage--
    renderSessionBrowser()
  })
  next.addEventListener("click", () => {
    sessionPage++
    renderSessionBrowser()
  })
  rowsBody.addEventListener("click", (event) => {
    const choice = (event.target as Element).closest<HTMLButtonElement>("[data-session-choice]")
    if (!choice) return
    chooseSession(choice.dataset.sessionChoice ?? "")
  })
  root.addEventListener("click", (event) => {
    const inspect = (event.target as Element).closest<HTMLButtonElement>("[data-inspect-request]")
    if (inspect?.dataset.inspectRequest) {
      selectedRequest = Number(inspect.dataset.inspectRequest)
      renderTrace()
      inspectorRoot.scrollIntoView?.({ block: "start" })
      return
    }
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-trace-more]")
    if (!button) return
    showAll = !showAll
    renderTrace()
  })

  return {
    destroy() { inspector.destroy() },
    render(nextState) {
      state = nextState
      const snapshot = nextState.snapshot
      catalogEntries = catalogSessions(snapshot, nextState.catalog ?? null)
      if (!snapshot) {
        renderUnavailable()
        return
      }
      retention.textContent = retentionText(snapshot)
      renderTrigger()
      if (dialog.open) renderSessionBrowser()
      if (catalogEntries.length === 0) {
        selectedSession = null
        empty("Requests routed through the gateway will appear here. Global totals remain available.")
        return
      }
      if (selectedSession === null || !snapshot.history.sessions.some((session) => session.id === selectedSession)) {
        const fallback = measuredEntries()[0]
        selectedSession = fallback?.id ?? null
        showAll = false
      }
      if (selectedSession === null) {
        syncTraceUrl()
        empty(
          `${integer(catalogEntries.length)} session${catalogEntries.length === 1 ? "" : "s"} are stored by OpenCode, but none have retained gateway measurements. DeltaRelay only measures requests routed through its gateway.`,
          "No gateway measurements",
        )
        return
      }
      renderTrigger()
      syncTraceUrl()
      renderTrace()
    },
  }
}
