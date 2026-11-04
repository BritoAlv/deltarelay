import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, duration, percentage, relativeTime, savings, sessionState } from "../../lib/metrics.js"
import { barComparison, requestMeasurement, sessionMeasurement } from "../../lib/measurement.js"
import type { DashboardViewState } from "../../lib/state.js"
import type { RelayRequest, Session, Snapshot } from "../../lib/types.js"
import { requiredById } from "../dom.js"
import { mountInspection } from "./inspection.js"
import type { InspectionStage } from "../../lib/inspection.js"

export interface MeasurementFeature {
  render(state: DashboardViewState): void
  destroy(): void
}

const requestPageSize = 8
const integer = (value: number) => value.toLocaleString()
const pill = (label: string, state: string) => `<span class="status-pill ${state}">${escape(label)}</span>`

function stat(label: string, value: string, detail: string, tone = ""): string {
  return `<div class="trace-stat"><span>${escape(label)}</span><strong class="${tone}">${escape(value)}</strong><small>${escape(detail)}</small></div>`
}

function barRow(label: string, value: string, width: number, tone: string): string {
  return `<div class="trace-bar-row"><span>${escape(label)}</span><div class="trace-bar-track"><span class="trace-bar-fill ${tone}" style="width:${Math.max(0, Math.min(100, width)).toFixed(2)}%"></span></div><strong>${escape(value)}</strong></div>`
}

function detail(label: string, value: string, tone = ""): string {
  return `<div class="trace-request-detail"><span>${escape(label)}</span><strong class="${tone}">${escape(value)}</strong></div>`
}

export function mountMeasurement(root: HTMLElement): MeasurementFeature {
  const select = requiredById<HTMLSelectElement>(root, "measurement-session")
  const trace = requiredById(root, "measurement-trace")
  const retention = requiredById(root, "retention-note")
  const doc = root.ownerDocument
  const inspectorRoot = requiredById<HTMLElement>(root, "request-inspector")
  const inspector = mountInspection(inspectorRoot, {
    onStageChange: (next) => trace.querySelectorAll<HTMLElement>("[data-pipeline-stage]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.pipelineStage === next))),
  })
  let state: DashboardViewState | null = null
  let selectedSession: string | null = null
  let selectedRequest: number | null = null
  let showAll = false
  let optionsSignature = ""
  const openRequests = new Set<string>()

  function selected(snapshot: Snapshot): Session | undefined {
    return snapshot.history.sessions.find((session) => session.id === selectedSession)
  }

  function sessionRequests(snapshot: Snapshot, session: Session): RelayRequest[] {
    return snapshot.history.recent_requests
      .filter((request) => request.session_id === session.id)
      .sort((a, b) => b.sequence - a.sequence)
  }

  function retentionText(snapshot: Snapshot): string {
    const history = snapshot.history
    const traffic = history.traffic
    const trafficText = traffic
      ? ` Traffic charts keep hourly aggregates for ${Math.round(traffic.hourly.retention_seconds / 86_400)} days and daily aggregates for ${Math.round(traffic.daily.retention_seconds / 86_400)} days.`
      : ""
    return `History since ${new Date(history.since).toLocaleString()}. Keeps up to ${history.session_limit} sessions and ${integer(history.request_limit)} requests.${trafficText} ${integer(history.evicted_sessions)} older sessions and ${integer(history.dropped_requests)} request entries trimmed; global totals are preserved. Session totals restart if an evicted session reappears. Earlier history is not imported from logs. ${history.persistent ? "History is saved privately on the gateway." : "History is in memory only."}`
  }

  function updateOptions(sessions: Session[]): void {
    if (sessions.length === 0) {
      optionsSignature = ""
      const option = doc.createElement("option")
      option.textContent = "No retained sessions"
      select.replaceChildren(option)
      select.disabled = true
      return
    }
    const signature = sessions.map((session) => {
      const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
      return [session.id, session.upstream, sessionState(session), reduction ?? "none", session.requests, session.active, session.failed, session.cancelled, session.updated_at].join("\u0000")
    }).join("\u0001")
    if (signature !== optionsSignature) {
      optionsSignature = signature
      const options = sessions.map((session) => {
        const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
        const option = doc.createElement("option")
        option.value = session.id
        option.textContent = [
          session.id || "Unattributed requests",
          session.upstream || "Unknown upstream",
          sessionState(session),
          reduction === null ? "reduction unavailable" : `${percentage(reduction)} reduction`,
        ].join(" · ")
        return option
      })
      select.replaceChildren(...options)
    }
    select.disabled = false
  }

  function empty(message: string): void {
    trace.innerHTML = `<div class="empty-state"><h3>No retained sessions</h3><p>${escape(message)}</p></div>`
    select.disabled = true
    inspector.update(null, state?.snapshot?.inspection, state?.snapshot?.collected_at ?? "")
  }

  function renderUnavailable(): void {
    selectedSession = null
    optionsSignature = ""
    const option = doc.createElement("option")
    option.textContent = "Waiting for local gateway…"
    select.replaceChildren(option)
    select.disabled = true
    retention.textContent = "History retains up to 256 sessions and 1,000 requests. Global totals survive retention trimming. Earlier history is not imported from logs."
    trace.innerHTML = `<div class="empty-state"><h3>Waiting for local gateway</h3><p>Start the local gateway and dashboard server to trace retained sessions. No provider requests are sent by this page.</p></div>`
    inspector.update(null, undefined, "")
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
      ? `<div class="trace-request-body"><p class="trace-request-note">Transfer totals are written when this request finishes. Elapsed time comes from the latest local gateway observation.</p><button class="text-button" type="button" data-inspect-request="${request.sequence}">Inspect request evidence</button></div>`
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
          <p class="trace-formula"><code>${escape(formula)}</code></p>
          <p class="trace-request-note">Response bytes are shown for context but never subtracted from upload savings. Failed and cancelled attempts remain included in session totals. Uploaded-chunk counters follow logical batches; after recovery, inspect attempt evidence for actual retransmissions.</p>
          ${request.error_code ? `<p class="request-error">${escape(request.error_code)}</p>` : ""}
          <button class="text-button" type="button" data-inspect-request="${request.sequence}">Inspect request evidence</button>
        </div>`
    return `<details class="trace-request${selectedRequest === request.sequence ? " selected" : ""}" data-request-id="${escape(request.id)}"${open}>
      <summary>
        <div class="trace-request-heading">
          <code>${escape(request.id)}</code>
          <span class="trace-request-meta">${escape(request.kind)} · ${escape(relativeTime(request.started_at))} · ${escape(duration(measured.elapsedMs))}${escape(status)}</span>
          ${request.error_code ? `<span class="trace-request-error">${escape(request.error_code)}</span>` : ""}
        </div>
        <div class="trace-request-values">
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
        if (request.open) openRequests.add(id)
        else openRequests.delete(id)
      })
    })
  }

  function renderTrace(): void {
    if (!state?.snapshot) return
    const snapshot = state.snapshot
    const session = selected(snapshot)
    if (!session) {
      const fallback = snapshot.history.sessions[0]
      if (!fallback) {
        selectedSession = null
        retention.textContent = retentionText(snapshot)
        empty("Requests routed through the gateway will appear here. Global totals remain available.")
        return
      }
      selectedSession = fallback.id
      showAll = false
      select.value = selectedSession
    }
    const current = selected(snapshot)
    if (!current) return
    const requests = sessionRequests(snapshot, current)
    if (!requests.some((request) => request.sequence === selectedRequest)) selectedRequest = requests[0]?.sequence ?? null
    const inspected = requests.find((request) => request.sequence === selectedRequest) ?? null
    const measured = inspected ? requestMeasurement(inspected, snapshot.collected_at) : null
    const pipeline = [
      ["body", "Original body", "Decoded source, before chunking. Inspect bytes or JSON.", measured ? bytes(measured.original) : "—"],
      ["inventory", "Relay inventory", "Inspect actual chunk availability at an observed inventory.", measured ? bytes(measured.reused) : "—"],
      ["upload", "Raw chunks uploaded", "Prepared batches and validated acknowledgments; recovery may re-inventory instead of retransmitting.", measured ? bytes(measured.uploaded) : "—"],
      ["encoded", "Encoded upload", "Inspect counted transport attempts, encoding and payloads.", measured ? bytes(measured.encoded) : "—"],
      ["savings", measured && measured.saved < 0 ? "Extra upload" : "Saved", "Calculated original minus encoded; not another byte stream.", measured ? bytes(Math.abs(measured.saved)) : "—"],
    ] as const
    const summary = sessionMeasurement(current, requests)
    const bars = barComparison(summary.original, summary.encoded)
    const visible = showAll ? requests : requests.slice(0, requestPageSize)
    const reductionTone = summary.reduction !== null && summary.reduction < 0 ? "negative" : "accent"
    const savedTone = summary.saved < 0 ? "negative" : ""
    const stateTone = sessionState(current)
    const reduced = summary.reduction === null ? "No finished body bytes yet; reduction is unavailable." : `1 − ${bytes(summary.encoded)} ÷ ${bytes(summary.original)} = ${percentage(summary.reduction)}`
    const coverage = summary.missingRequests > 0
      ? `<p class="trace-coverage">Session totals include ${integer(summary.missingRequests)} request${summary.missingRequests === 1 ? "" : "s"} no longer retained. The ledger below covers ${integer(summary.retainedRequests)} retained entr${summary.retainedRequests === 1 ? "y" : "ies"}.</p>`
      : ""
    const more = requests.length > requestPageSize
      ? `<button class="text-button trace-more" type="button" data-trace-more>${showAll ? `Show latest ${requestPageSize}` : `Show all ${integer(requests.length)} retained requests`}</button>`
      : ""
    const ledger = requests.length === 0
      ? `<div class="empty-state trace-requests-empty"><h3>No retained request entries</h3><p>Session totals still include ${integer(summary.totalRequests)} request${summary.totalRequests === 1 ? "" : "s"}; their request-level entries were trimmed from history.</p></div>`
      : `${coverage}${visible.map((request) => renderRequest(request, snapshot)).join("")}${more}`

    trace.innerHTML = `<div class="trace-session-head">
        <div>
          <div class="trace-session-title"><code>${escape(current.id || "Unattributed requests")}</code>${pill(stateTone === "active" ? `${current.active} active` : stateTone === "attention" ? "Attention" : "Idle", stateTone)}</div>
          <p>${escape(current.upstream || "Unknown upstream")} · ${integer(summary.totalRequests)} model requests · ${integer(current.failed)} failed · ${integer(current.cancelled)} cancelled · last activity ${escape(relativeTime(current.updated_at))}</p>
        </div>
        <div class="trace-session-formula"><span>Upload reduction for this session</span><code>${escape(reduced)}</code></div>
      </div>
      <div class="trace-summary-grid">
        ${stat("Upload reduction", percentage(summary.reduction), "of original body bytes", reductionTone)}
        ${stat(summary.saved < 0 ? "Extra upload" : "Bandwidth saved", bytes(Math.abs(summary.saved)), summary.saved < 0 ? "encoded − original" : "original − encoded", savedTone)}
        ${stat("Original body", bytes(summary.original), "100% baseline")}
        ${stat("Encoded upload", bytes(summary.encoded), "manifests, framing, compression, retries")}
      </div>
      <div class="trace-visual">
        <div class="trace-bars" role="img" aria-label="Original body ${escape(bytes(summary.original))}, encoded upload ${escape(bytes(summary.encoded))}, saved ${escape(bytes(summary.saved))}">
          <h3 class="trace-scope">Session upload totals</h3>
          ${barRow("Original", bytes(summary.original), bars.originalPercent, "original")}
          ${barRow("Sent", bytes(summary.encoded), bars.encodedPercent, "accent")}
          ${barRow(bars.negative ? "Extra sent" : "Saved", bytes(Math.abs(summary.saved)), bars.savedPercent, bars.negative ? "danger" : "saved")}
        </div>
        <div class="trace-pipeline">
          <h3>From body to wire</h3>
          <label class="trace-request-picker">Selected request <select data-measurement-request aria-label="Selected request for body-to-wire inspection"${requests.length ? "" : " disabled"}>${requests.length ? requests.map((request) => `<option value="${request.sequence}"${request.sequence === selectedRequest ? " selected" : ""}>${escape(request.id)} · ${escape(request.kind)} · ${escape(request.state)}${request.capture_id ? "" : " · not captured"}</option>`).join("") : "<option>No retained request entries</option>"}</select></label>
          <p class="trace-request-note">Request-level application payload, not packet capture. Select a stage to inspect evidence below.</p>
          <ol>
            ${pipeline.map(([id, label, note, value], i) => `<li><span>${i+1}</span><div><button type="button" data-pipeline-stage="${id}" aria-pressed="${inspector.stage === id}"${inspected ? "" : " disabled"}>${label}</button><p>${note}</p></div><code>${escape(measured?.pending ? "Pending" : value)}</code></li>`).join("")}
          </ol>
        </div>
      </div>
      <p class="trace-caveat">The comparison bars show session totals; the clickable stages show the selected request. Content reuse and encoded upload are separate views, not an additive stack.</p>
      <div class="trace-requests">
        <div class="trace-requests-head"><div><h3>Request ledger</h3><p>Retained request entries, newest first. Expand one to see its full byte accounting.</p></div><span class="section-meta">${integer(requests.length)} retained${summary.missingRequests ? ` · ${integer(summary.missingRequests)} trimmed` : ""}</span></div>
        ${ledger}
      </div>`
    bindOpenState()
    inspector.update(inspected, snapshot.inspection, snapshot.collected_at)
  }

  select.addEventListener("change", () => {
    selectedSession = select.value
    selectedRequest = null
    showAll = false
    renderTrace()
  })
  trace.addEventListener("change", (event) => {
    const picker = event.target as HTMLSelectElement
    if (!picker.matches("[data-measurement-request]")) return
    selectedRequest = Number(picker.value)
    renderTrace()
  })
  root.addEventListener("click", (event) => {
    const inspect = (event.target as Element).closest<HTMLButtonElement>("[data-inspect-request], [data-pipeline-stage]")
    if (inspect?.dataset.inspectRequest) {
      selectedRequest = Number(inspect.dataset.inspectRequest)
      renderTrace()
      inspectorRoot.scrollIntoView?.({ block: "start" })
      return
    }
    if (inspect?.dataset.pipelineStage) {
      inspector.open(inspect.dataset.pipelineStage as InspectionStage)
      trace.querySelectorAll<HTMLElement>("[data-pipeline-stage]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.pipelineStage === inspector.stage)))
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
      if (!snapshot) {
        renderUnavailable()
        return
      }
      const sessions = snapshot.history.sessions
      updateOptions(sessions)
      retention.textContent = retentionText(snapshot)
      if (sessions.length === 0) {
        selectedSession = null
        empty("Requests routed through the gateway will appear here. Global totals remain available.")
        return
      }
      if (selectedSession === null || !sessions.some((session) => session.id === selectedSession)) {
        selectedSession = sessions[0]!.id
        showAll = false
      }
      select.value = selectedSession
      renderTrace()
    },
  }
}
