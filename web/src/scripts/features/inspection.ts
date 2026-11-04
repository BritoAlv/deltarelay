import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, percentage, savings } from "../../lib/metrics.js"
import {
  artifactURL, decodeBytes, fetchArtifact, fetchAttempt, fetchCapture, fetchChunks, formatJSON, hexDump,
  type Artifact, type ArtifactPage, type CapturedChunk, type CaptureStatus, type ChunkPage,
  type InspectionStage, type RequestCapture, type UploadAttempt,
} from "../../lib/inspection.js"
import type { RelayRequest } from "../../lib/types.js"

const stages: [InspectionStage, string][] = [["body", "Original body"], ["inventory", "Relay inventory"], ["upload", "Raw chunks uploaded"], ["encoded", "Encoded upload"], ["savings", "Saved / extra upload"]]
const exact = (n: number) => `${n.toLocaleString()}\u00A0B (${bytes(n)})`
const field = (label: string, value: string) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`
const button = (label: string, action: string, disabled = false) => `<button type="button" class="text-button" data-inspect-action="${action}"${disabled ? " disabled" : ""}>${escape(label)}</button>`

export interface InspectionFeature {
  readonly stage: InspectionStage
  update(request: RelayRequest | null, status: CaptureStatus | undefined, collectedAt: string): void
  open(stage: InspectionStage): void
  destroy(): void
}

export function mountInspection(root: HTMLElement): InspectionFeature {
  let request: RelayRequest | null = null
  let status: CaptureStatus | undefined
  let capture: RequestCapture | null = null
  let stage: InspectionStage = "body"
  let key = "", observedAt = "", requestState = ""
  let chunkStart = 0, inventoryIndex = 0, attemptIndex = 0, payloadOffset = 0
  let chunks: ChunkPage | null = null, selectedChunk: CapturedChunk | null = null
  let selectedAttempt: UploadAttempt | null = null, page: ArtifactPage | null = null
  let mode: "hex" | "text" | "json" = "text", decoded = false, jsonPreview = ""
  let busy = false, failure = "", viewNote = "", transferMismatch = false, generation = 0, destroyed = false
  let controller: AbortController | null = null
  const view = root.ownerDocument.defaultView ?? globalThis

  function notice(): string {
    if (!status) return `<p class="inspect-notice">Payload capture is off or not reported by this gateway. Rebuild and restart the gateway to use the default capture directory. Existing counters cannot reconstruct request content.</p>`
    if (!status.enabled) return `<p class="inspect-notice">Payload capture is off. Restart the gateway with its default capture directory to capture future requests. This stores sensitive prompts/code on private disk; older requests cannot be reconstructed.</p>`
    return `<p class="inspect-notice${status.storage_error ? " warning" : ""}">Private disk capture enabled · ${status.captures.toLocaleString()}/${status.max_captures.toLocaleString()} requests retained · ${escape(bytes(status.used_bytes))} of ${escape(bytes(status.max_bytes))} used · ${escape(bytes(status.max_capture_bytes))} per capture · ${(status.max_age_seconds/3600).toLocaleString()} h retention. ${status.storage_error ? "Capture storage/admission errors observed; evidence may be incomplete. " : ""}Captured bodies may contain secrets. Capture retention is independent of statistics.</p>`
  }

  function artifactState(a: Artifact): string {
    const states = [a.representation === "redacted" ? "Redacted representation — not the original payload" : "Captured bytes"]
    if (!a.complete) states.push("source not read to EOF (running, failed, or rejected)")
    if (a.truncated) states.push("capture limit reached — prefix only; recorded SHA-256 still covers all observed source bytes")
    if (a.write_error) states.push("storage error — prefix only; recorded SHA-256 still covers all observed source bytes")
    return states.join(" · ")
  }

  function payload(): Artifact | null {
    return stage === "body" || stage === "inventory" ? capture?.body ?? null : selectedAttempt?.payload ?? null
  }

  function viewer(): string {
    const a = payload()
    if (!a || !capture) return `<p class="inspect-empty">No payload artifact was captured for this operation.</p>`
    const content = page ? decodeBytes(page.data) : null
    let rendered = ""
    if (mode === "json") rendered = jsonPreview
    else if (content) {
      if (mode === "hex") rendered = hexDump(content, page!.offset)
      else {
        try { rendered = new TextDecoder("utf-8", { fatal: true }).decode(content) }
        catch { rendered = hexDump(content, page!.offset); viewNote = "This byte window is not independently valid UTF-8 (it may cut a character). Showing hex without replacement characters." }
      }
    }
    const total = page?.total ?? a.captured_bytes
    const end = page ? page.offset+content!.length : 0
    const sourceLabel = a.representation === "redacted" ? "Representation bytes" : "Observed source bytes"
    const downloadable = a.captured_bytes > 0 || a.complete && a.source_bytes === 0
    const placeholder = mode === "json" ? "JSON presentation unavailable for this artifact; use the byte viewer." : busy ? "Loading byte window…" : total === 0 && a.source_bytes === 0 && a.complete ? "Empty body (0 bytes)." : "No byte window loaded."
    return `<section class="inspect-viewer" aria-label="Payload byte viewer">
      <div class="inspect-viewer-head"><div><h4>${stage === "body" || stage === "inventory" ? "Body bytes" : "Attempt payload"}</h4><p>${escape(artifactState(a))}</p></div>
        ${downloadable ? `<a class="text-button" href="${escape(artifactURL(capture.id, a.id, true, decoded))}" download>${a.representation === "redacted" ? "Download Redacted Representation" : decoded ? "Download Decoded Bytes (Not Stored Bytes)" : a.truncated || a.write_error || !a.complete ? "Download Captured Prefix" : "Download Captured Bytes"}</a>` : ""}
      </div>
      <dl class="inspect-fields">${field(sourceLabel, exact(a.source_bytes))}${field("Retained bytes", exact(a.captured_bytes))}${field("Content type (declared)", a.content_type || "Not declared")}${field("Stored encoding", a.encoding)}${field(a.representation === "redacted" ? "Retained representation SHA-256" : "Observed source SHA-256", a.sha256 || "Unavailable: source not read to EOF")}</dl>
      ${selectedChunk && (stage === "body" || stage === "inventory") ? `<p class="inspect-selection">Selected chunk #${selectedChunk.index} · byte range [${selectedChunk.offset.toLocaleString()}, ${(selectedChunk.offset+selectedChunk.size).toLocaleString()}) · ${escape(selectedChunk.availability)} at the selected inventory · ${escape(selectedChunk.hash)}</p>` : ""}
      <div class="inspect-view-tools" role="group" aria-label="Payload representation">
        ${(["text", "hex", "json"] as const).map((m) => `<button class="text-button" type="button" data-inspect-mode="${m}" aria-pressed="${mode === m}">${m === "json" ? "JSON (lossless formatting)" : m === "hex" ? "Hex + ASCII" : "UTF-8 text"}</button>`).join("")}
        ${a.encoding === "gzip" ? `<label><input type="checkbox" name="decode-gzip" data-inspect-decode${decoded ? " checked" : ""}${a.truncated || a.write_error || !a.complete ? " disabled" : ""}> Decode gzip (not stored bytes)</label>` : ""}
      </div>
      ${viewNote ? `<p class="inspect-notice">${escape(viewNote)}</p>` : ""}
      <p class="inspect-range">${jsonPreview ? "Complete JSON presentation; original tokens preserved. Formatting is not the captured byte layout." : `Byte range [${(page?.offset ?? 0).toLocaleString()}, ${end.toLocaleString()}) of ${total.toLocaleString()} ${page?.decoded ? "decoded" : "retained"} bytes. Offsets are bytes, not characters.`}</p>
      <pre class="inspect-code" tabindex="0" aria-label="${mode === "json" ? "JSON presentation" : page?.decoded ? "Decoded byte window" : "Captured byte window"}"><code translate="no">${escape(rendered || placeholder)}</code></pre>
      <form class="inspect-pagination" data-inspect-offset-form>${button("Previous Bytes", "payload-prev", busy || payloadOffset === 0 || mode === "json")}
        <label>Byte offset <input name="offset" type="number" inputmode="numeric" autocomplete="off" min="0" max="${Math.max(0, total)}" value="${payloadOffset}" step="1" aria-label="Payload byte offset"></label><button type="submit" class="text-button"${busy || mode === "json" ? " disabled" : ""}>Go to Offset</button>
        ${button("Next Bytes", "payload-next", busy || end >= total || mode === "json")}</form>
    </section>`
  }

  function inventoryView(): string {
    if (!capture) return ""
    const observations = capture.inventories
    const observed = observations.find((i) => i.index === inventoryIndex)
    const current = chunks?.chunks ?? []
    const first = current[0]?.offset ?? 0, last = current.at(-1)
    const crossCheck = observed?.kind === "initial" && capture.state === "completed" && !capture.dropped_events
      ? observed.present_body_bytes === capture.transfer.reused_body_bytes && observed.missing_bytes === capture.transfer.missing_chunk_bytes
        ? "Matches transfer reused/missing counters"
        : `Mismatch: inventory present ${observed.present_body_bytes.toLocaleString()} B / unique missing ${observed.missing_bytes.toLocaleString()} B; transfer reused ${capture.transfer.reused_body_bytes.toLocaleString()} B / unique missing ${capture.transfer.missing_chunk_bytes.toLocaleString()} B`
      : "Not compared (not an initial inventory or transfer accounting is incomplete)"
    return `<p class="inspect-explanation">Actual hash-based chunk availability, not a text diff. A missing chunk does not mean every byte in it is new. Repeated hashes occupy each original body range but need only one unique upload. Byte totals below are manifest-occurrence bytes: unique missing chunk bytes count each missing hash once, so repeated missing hashes can make missing body occurrences larger.</p>
      <div class="inspect-view-tools"><label>Inventory observation <select name="inventory-observation" data-inspect-inventory${observations.length ? "" : " disabled"}>${observations.length ? observations.map((i) => `<option value="${i.index}"${i.index === inventoryIndex ? " selected" : ""}>${i.index+1}. ${escape(i.kind)} · ${escape(i.observed_at)} · ${i.missing_chunks} unique missing</option>`).join("") : "<option>No validated inventory captured</option>"}</select></label></div>
      ${observed ? `<dl class="inspect-fields">${field("Observed at", observed.observed_at)}${field("Relay state ID", observed.state_id || "Not available")}${field("Scope", `${observed.scope_chunks} chunk references`)}${field("Present in captured manifest", exact(observed.present_body_bytes))}${field("Missing in captured manifest", exact(observed.missing_body_bytes))}${field("Unknown outside observation scope", exact(observed.unknown_body_bytes))}${field("Unique missing chunk bytes", exact(observed.missing_bytes))}${field("Transfer counter cross-check", crossCheck)}</dl>` : `<p class="inspect-notice">No validated inventory observation: all ranges remain unknown.</p>`}
      <div class="inspect-legend"><span class="present">Present at observation</span><span class="missing">Missing chunk</span><span class="unknown">Unknown / outside observation scope</span></div>
      <div class="inspect-map-scroll"><div class="inspect-chunk-map" role="group" aria-label="Ordered chunk availability map">${current.map((c) => `<button type="button" class="inspect-chunk ${c.availability}${selectedChunk?.index === c.index ? " selected" : ""}" style="flex-grow:${c.size}" data-inspect-chunk="${c.index}" aria-label="Chunk ${c.index}, bytes ${c.offset} to ${c.offset+c.size}, ${c.availability}, ${c.occurrences} occurrences" title="#${c.index} · [${c.offset}, ${c.offset+c.size}) · ${c.size} B · ${c.availability}"></button>`).join("")}</div></div>
      <p class="inspect-range">${current.length ? `This page: chunks ${chunkStart}–${chunkStart+current.length-1}, body bytes [${first.toLocaleString()}, ${(last!.offset+last!.size).toLocaleString()}). Widths proportional to raw chunk lengths within this page.` : "No chunk ranges captured."} ${capture.dropped_events ? "Capture event limits were reached; this is not a complete manifest." : ""}</p>
      <div class="inspect-table-scroll"><table class="inspect-table"><thead><tr><th>Chunk</th><th>Body byte range [start, end)</th><th>Length</th><th>Inventory</th><th>Occurrences</th><th>SHA-256</th></tr></thead><tbody>${current.map((c) => `<tr class="${selectedChunk?.index === c.index ? "selected" : ""}"><td><button type="button" class="text-button" data-inspect-chunk="${c.index}">#${c.index}</button></td><td>${c.offset.toLocaleString()}–${(c.offset+c.size).toLocaleString()}</td><td>${c.size.toLocaleString()} B</td><td><span class="inspect-availability ${c.availability}">${c.availability}</span></td><td>${c.occurrences}</td><td><code>${escape(c.hash)}</code></td></tr>`).join("")}</tbody></table></div>
      <div class="inspect-pagination">${button("Previous Chunks", "chunks-prev", busy || chunkStart === 0)}<span>${capture.chunk_count.toLocaleString()} captured chunk ranges</span>${button("Next Chunks", "chunks-next", busy || chunkStart+current.length >= (chunks?.total ?? 0))}</div>
      ${selectedChunk ? viewer() : `<p class="inspect-empty">Select a rectangle or chunk row to inspect its original body bytes.</p>`}`
  }

  function attemptsView(): string {
    if (!capture) return ""
    const attempts = capture.attempts.filter((a) => stage === "encoded" || a.operation === "chunks")
    const a = selectedAttempt
    let frameOffset = 12
    return `<p class="inspect-explanation">${stage === "upload" ? "Prepared batches contain unique chunks, not every repeated body occurrence. A validated upload acknowledgment confirms the listed chunk count and raw length; a lost acknowledgment may instead be resolved by a later recovery inventory." : "Recorded attempts use the same scope as request_body_bytes_sent. Health/status/response polling and background controls are excluded. Attempt HTTP statuses are relay RPC statuses, not the provider's response status. Payload consumption is an observation at the Go HTTP transport boundary, not packet capture or proof of remote receipt."}</p>
      <div class="inspect-table-scroll"><table class="inspect-table"><thead><tr><th>Attempt</th><th>Endpoint</th><th>Encoding</th><th>Before encoding</th><th>Prepared body</th><th>Transport consumed</th><th>Outcome</th></tr></thead><tbody>${attempts.map((x) => `<tr class="${x.index === a?.index ? "selected" : ""}"><td><button type="button" class="text-button" data-inspect-attempt="${x.index}">#${x.index+1}</button></td><td><code>${escape(x.method)} ${escape(x.path)}</code><br><span class="inspect-availability">${escape(x.operation)}</span></td><td>${escape(x.encoding)}</td><td>${x.decoded_bytes.toLocaleString()} B</td><td>${x.prepared_bytes.toLocaleString()} B</td><td>${x.consumed_bytes.toLocaleString()} B</td><td>${x.status ? `HTTP ${x.status} · ` : ""}${escape(x.outcome)}${x.acknowledgment_ok ? " · count/length-validated chunk ACK" : ""}</td></tr>`).join("")}</tbody></table></div>
      ${!attempts.length ? `<p class="inspect-empty">No ${stage === "upload" ? "chunk upload" : "counted HTTP"} attempts captured. This does not by itself prove a cache hit.</p>` : ""}
      ${a ? `<dl class="inspect-fields">${field("Attempt started", a.started_at)}${field("Attempt finished", a.finished_at || "Pending / interrupted")}${field("Before content encoding", exact(a.decoded_bytes))}${field("Prepared encoded body", exact(a.prepared_bytes))}${field("Consumed by transport", exact(a.consumed_bytes))}${field("Relay chunk acknowledgment", a.acknowledgment_ok ? "Count and raw byte length validated; not an independent persistence proof" : "Not validated for this attempt")}</dl>
        ${a.operation === "dispatch" ? `<p class="inspect-notice warning">The dispatch body embeds provider credentials. Only an allowlisted redacted representation is retained. Its byte length and hash describe that representation; the measured attempt lengths above describe the original payload.</p>` : ""}
        ${stage === "upload" && a.chunks?.length ? `<h4>Prepared frame layout (before gzip)</h4><p class="inspect-explanation">12-byte batch header: DRLY0001 + uint32 chunk count. Each frame: 32-byte SHA-256 + uint32 raw length (big endian) + chunk bytes. Gzip covers the whole batch; no per-chunk compressed size is claimed.</p><div class="inspect-table-scroll"><table class="inspect-table"><thead><tr><th>Frame offset</th><th>Data offset</th><th>Raw bytes</th><th>SHA-256</th></tr></thead><tbody>${a.chunks.map((c) => { const start = frameOffset; frameOffset += 36+c.size; return `<tr><td>${start.toLocaleString()}</td><td>${(start+36).toLocaleString()}</td><td>${c.size.toLocaleString()}</td><td><code>${escape(c.hash)}</code></td></tr>` }).join("")}</tbody></table></div>` : ""}
        ${viewer()}` : ""}`
  }

  function savingsView(): string {
    if (!capture) return ""
    if (!capture.finished_at || capture.state === "interrupted") return `<p class="inspect-notice">Final transfer accounting is ${capture.state === "interrupted" ? "unavailable after interruption" : "pending"}. No savings percentage is inferred from placeholder zeros.</p>`
    const t = capture.transfer, saved = t.body_bytes-t.request_body_bytes_sent
    const counted = capture.attempts.filter((a) => a.counted)
    const consumed = counted.reduce((sum, a) => sum+a.consumed_bytes, 0)
    const hashCheck = !t.hash ? "Transfer hash unavailable" : !capture.body.sha256 ? "Source hash unavailable; body was not read to EOF" : capture.body.sha256 === t.hash ? "Match" : "MISMATCH"
    const byteCheck = capture.body.complete && capture.body.source_bytes === t.body_bytes ? "Match" : `Mismatch: source ${capture.body.source_bytes.toLocaleString()} B, transfer ${t.body_bytes.toLocaleString()} B`
    const chunkCheck = Number(capture.chunk_count) === t.chunks ? "Match" : `Mismatch: ${capture.chunk_count} captured ranges, ${t.chunks.toLocaleString()} transfer chunks`
    const attemptCheck = !capture.dropped_events && consumed === t.request_body_bytes_sent && counted.length === t.requests ? "Retained attempts reconcile to transfer counter" : "Does not reconcile — evidence incomplete or transfer counter includes uncaptured attempts"
    return `<dl class="inspect-fields">${field("Original body", exact(t.body_bytes))}${field("Counted encoded upload", exact(t.request_body_bytes_sent))}${field(saved < 0 ? "Extra upload" : "Saved", exact(Math.abs(saved)))}${field("Reduction", percentage(savings(t.body_bytes, t.request_body_bytes_sent)))}${field("Body SHA-256 vs transfer hash", hashCheck)}${field("Body source bytes vs transfer", byteCheck)}${field("Manifest ranges vs transfer chunks", chunkCheck)}${field("Retained attempt consumption", exact(consumed))}${field("Attempt accounting", attemptCheck)}</dl><p class="trace-formula"><code>${t.body_bytes.toLocaleString()} − ${t.request_body_bytes_sent.toLocaleString()} = ${saved.toLocaleString()} bytes</code></p><p class="inspect-explanation">Calculated comparison against the uncompressed body, not a measured direct-provider baseline. Responses, HTTP headers, TLS/TCP/IP overhead and retransmissions are excluded. This is not provider token-cache reuse or a billing discount.</p>`
  }

  function render() {
    if (destroyed) return
    const scrolls = [...root.querySelectorAll<HTMLElement>(".inspect-code, .inspect-table-scroll, .inspect-map-scroll")].map((el) => [el.scrollTop, el.scrollLeft])
    root.innerHTML = `${notice()}<div class="inspect-heading"><div><h3>Request evidence inspector</h3><p>${request ? `<code>${escape(request.id)}</code> · observation #${request.sequence} · ${escape(request.state)}${request.status ? ` · HTTP ${request.status}` : ""}${request.error_code ? ` · ${escape(request.error_code)}` : ""}` : "Select a retained request to inspect its evidence."}</p></div>${request?.capture_id ? button(busy ? "Loading…" : "Refresh Evidence", "refresh", busy) : ""}</div>
      <div class="inspect-stages" role="group" aria-label="Request evidence stage">${stages.map(([id, label], i) => `<button type="button" data-inspect-stage="${id}" aria-pressed="${stage === id}"${request ? "" : " disabled"}><span>${i+1}</span>${label}</button>`).join("")}</div>
      ${failure ? `<p class="inspect-notice warning" role="alert">${escape(failure)}</p>` : ""}
      ${!request ? "" : !request.capture_id ? `<div class="inspect-empty"><h4>Not captured</h4><p>This request has aggregate measurements only. Its body, chunk positions, inventory history and encoded payloads were not retained. No approximation is shown.</p></div>` : !capture ? `<p class="inspect-empty" aria-live="polite">${busy ? "Loading captured evidence…" : "No capture evidence available."}</p>` : `<div class="inspect-provenance"><span>Capture <code>${escape(capture.id)}</code></span><span>${escape(capture.started_at)}</span><span>${escape(capture.state)}</span></div>
        ${capture.dropped_events || capture.storage_error || capture.state === "interrupted" ? `<p class="inspect-notice warning">Evidence incomplete: ${capture.dropped_events} events omitted${capture.storage_error ? "; storage errors" : ""}${capture.state === "interrupted" ? "; gateway interrupted — only checkpointed evidence is available" : ""}. Unknown information is not filled in.</p>` : ""}
        ${transferMismatch ? `<p class="inspect-notice warning">The capture’s transfer counters differ from the retained request ledger. The views below use the capture’s recorded counters; do not assume they reconcile to the ledger.</p>` : ""}
        <div class="inspect-stage-content" aria-busy="${busy}">${stage === "body" ? `<p class="inspect-explanation">The actual body read by the chunker, after gateway gzip decoding and before chunking. It is not the full incoming HTTP request or a reconstruction from JSON. The source hash is recorded at EOF; truncation may mean only its prefix is retained.</p>${viewer()}` : stage === "inventory" ? inventoryView() : stage === "savings" ? savingsView() : attemptsView()}</div>`}`
    root.querySelectorAll<HTMLElement>(".inspect-code, .inspect-table-scroll, .inspect-map-scroll").forEach((el, i) => { const position = scrolls[i]; if (position) { el.scrollTop = position[0] ?? 0; el.scrollLeft = position[1] ?? 0 } })
  }

  async function loadPayload(signal: AbortSignal) {
    const a = payload()
    if (!capture || !a) { page = null; return }
    if (a.encoding !== "gzip") decoded = false
    if (payloadOffset > a.captured_bytes && !decoded) { page = null; viewNote = "The selected byte range was not retained. No replacement content is shown."; return }
    if (mode === "json") {
      if (a.encoding === "gzip" && !decoded) {
        page = null
        viewNote = "This artifact is stored gzip-encoded. Enable “Decode gzip” to inspect the decoded payload; the stored bytes are not JSON."
        return
      }
      const first = await fetchArtifact(capture.id, a.id, 0, signal, decoded, 65536)
      page = first
      if (!a.complete || a.truncated || a.write_error) { page = null; viewNote = "JSON presentation requires a complete captured representation. Use the byte viewer for this partial capture."; return }
      if (first.total > 1<<20) { page = null; viewNote = "JSON preview is limited to 1 MiB. Use the paged text/hex views or download the captured file; content has not been shortened into a fake JSON document."; return }
      const parts = [decodeBytes(first.data)]
      for (let offset = parts[0]!.length; offset < first.total; offset += 65536) parts.push(decodeBytes((await fetchArtifact(capture.id, a.id, offset, signal, decoded, 65536)).data))
      const all = new Uint8Array(first.total)
      let offset = 0
      for (const part of parts) { all.set(part, offset); offset += part.length }
      try { jsonPreview = formatJSON(new TextDecoder("utf-8", { fatal: true }).decode(all)) }
      catch { page = null; viewNote = "The complete representation is not valid UTF-8 JSON. No parsed structure is invented; use text or hex." }
      return
    }
    page = await fetchArtifact(capture.id, a.id, payloadOffset, signal, decoded)
  }

  async function load(refresh = false) {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal, current = ++generation
    const timeout = view.setTimeout(() => controller?.signal === signal && controller.abort(), 20_000)
    busy = true; failure = ""; viewNote = ""; jsonPreview = ""; transferMismatch = false
    render()
    try {
      if (!request?.capture_id) return
      if (!capture || refresh) {
        const next = await fetchCapture(request.capture_id, signal)
        if (signal.aborted || current !== generation) return
        if (next.request_id !== request.id || next.sequence !== request.sequence) throw new Error("Capture identity mismatch. No evidence from a different request is shown.")
        transferMismatch = next.transfer.body_bytes !== request.transfer.body_bytes || next.transfer.request_body_bytes_sent !== request.transfer.request_body_bytes_sent || next.transfer.requests !== request.transfer.requests
        capture = next
      }
      if (stage === "inventory") {
        // Never render old rectangles under a new inventory observation or page.
        chunks = null
        if (!capture.inventories.length) {
          selectedChunk = null
          return
        }
        if (inventoryIndex >= capture.inventories.length) inventoryIndex = 0
        chunks = await fetchChunks(capture.id, chunkStart, inventoryIndex, signal)
        if (selectedChunk && !chunks.chunks.some((chunk) => chunk.index === selectedChunk?.index)) selectedChunk = null
        if (selectedChunk) await loadPayload(signal)
      } else if (stage === "body") await loadPayload(signal)
      else if (stage === "upload" || stage === "encoded") {
        selectedAttempt = null
        page = null
        jsonPreview = ""
        const attempts = capture.attempts.filter((a) => stage !== "upload" || a.operation === "chunks")
        const chosen = attempts.find((a) => a.index === attemptIndex) ?? attempts[0]
        selectedAttempt = chosen ? await fetchAttempt(capture.id, chosen.index, signal) : null
        if (selectedAttempt) { attemptIndex = selectedAttempt.index; mode = selectedAttempt.content_type.includes("deltarelay.chunks") ? "hex" : "text"; await loadPayload(signal) }
      }
    } catch (error) {
      if (signal.aborted || current !== generation) return
      failure = error instanceof Error ? error.message : "Capture evidence could not be loaded."
      page = null; jsonPreview = ""
      if (refresh || !capture) capture = null
    } finally {
      view.clearTimeout(timeout)
      if (!destroyed && current === generation) { busy = false; render() }
    }
  }

  function open(next: InspectionStage) {
    controller?.abort(); generation++
    stage = next; page = null; selectedAttempt = null; selectedChunk = null; chunks = null; payloadOffset = 0; decoded = false; jsonPreview = ""; viewNote = ""; busy = false; mode = next === "upload" ? "hex" : "text"
    if (request?.capture_id) void load()
    else render()
  }

  function click(event: Event) {
    const target = (event.target as Element).closest<HTMLElement>("[data-inspect-stage], [data-inspect-action], [data-inspect-mode], [data-inspect-chunk], [data-inspect-attempt]")
    if (!target || (target as HTMLButtonElement).disabled) return
    if (target.dataset.inspectStage) { open(target.dataset.inspectStage as InspectionStage); return }
    if (target.dataset.inspectMode) { mode = target.dataset.inspectMode as typeof mode; payloadOffset = 0; void load(); return }
    if (target.dataset.inspectChunk) {
      selectedChunk = chunks?.chunks.find((c) => c.index === Number(target.dataset.inspectChunk)) ?? null
      payloadOffset = selectedChunk?.offset ?? 0; mode = "hex"; decoded = false; page = null
      void load(); return
    }
    if (target.dataset.inspectAttempt) { attemptIndex = Number(target.dataset.inspectAttempt); payloadOffset = 0; decoded = false; page = null; void load(); return }
    switch (target.dataset.inspectAction) {
      case "refresh": void load(true); break
      case "chunks-prev": chunkStart = Math.max(0, chunkStart-128); selectedChunk = null; void load(); break
      case "chunks-next": chunkStart += 128; selectedChunk = null; void load(); break
      case "payload-prev": payloadOffset = Math.max(0, payloadOffset-4096); void load(); break
      case "payload-next": payloadOffset += 4096; void load(); break
    }
  }
  function change(event: Event) {
    const input = event.target as HTMLInputElement
    if (input.matches("[data-inspect-inventory]")) { inventoryIndex = Number(input.value); selectedChunk = null; void load() }
    if (input.matches("[data-inspect-decode]")) { decoded = input.checked; payloadOffset = 0; page = null; void load() }
  }
  function submit(event: Event) {
    const form = event.target as HTMLFormElement
    if (!form.matches("[data-inspect-offset-form]")) return
    event.preventDefault()
    const input = form.querySelector<HTMLInputElement>("[name=offset]")
    const offset = Number(input?.value)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (page?.total ?? 0)) return
    payloadOffset = offset; void load()
  }
  root.addEventListener("click", click)
  root.addEventListener("change", change)
  root.addEventListener("submit", submit)
  render()
  return {
    get stage() { return stage },
    open,
    update(next, nextStatus, collectedAt) {
      status = nextStatus
      const nextKey = next ? `${next.sequence}:${next.capture_id ?? "none"}` : ""
      const refresh = key === nextKey && (next?.state === "running" || requestState === "running") && observedAt !== collectedAt
      request = next
      requestState = next?.state ?? ""
      observedAt = collectedAt
      if (nextKey !== key) {
        controller?.abort(); generation++; key = nextKey
        capture = null; chunks = null; page = null; selectedChunk = null; selectedAttempt = null; failure = ""; viewNote = ""; jsonPreview = ""; transferMismatch = false
        chunkStart = 0; inventoryIndex = 0; attemptIndex = 0; payloadOffset = 0; decoded = false; mode = stage === "upload" ? "hex" : "text"; busy = false
        if (next?.capture_id) { void load(); return }
      } else if (refresh && next?.capture_id) { void load(true); return }
      // Polling metadata does not replace the viewer DOM or reset selection.
      if (!capture && !busy || !next) render()
    },
    destroy() { destroyed = true; generation++; controller?.abort(); root.removeEventListener("click", click); root.removeEventListener("change", change); root.removeEventListener("submit", submit); root.replaceChildren() },
  }
}
