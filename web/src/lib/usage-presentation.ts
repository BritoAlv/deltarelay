import { escapeHtml as escape } from "./html.js"
import { duration } from "./metrics.js"
import type { RelayRequest } from "./types.js"
import { compactTokens, tokenNumber } from "./usage.js"

function fact(label: string, value: string): string {
  return `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`
}

export function requestUsageDetails(request: RelayRequest): string {
  const m = request.usage
  const state = request.state === "running" ? "Pending" : m?.state === "complete" ? "Complete" : m?.state === "partial" ? "Partial" : "Unavailable"
  const explanation = request.state === "running" ? "Measurements are saved when the local request finishes." :
    !m ? "This request predates local usage tracking." :
    m.state === "unavailable" ? "No supported token-usage report was received on this computer." :
    m.state === "partial" ? "Some measurements arrived, but a complete final usage report was not observed." :
    "Provider-reported counters, observed locally. Cached input and reasoning may already be included in the totals."
  return `<section class="request-model-usage" aria-label="Local model usage"><div class="usage-detail-heading"><h4>Model usage</h4><span class="usage-quality">${state}</span></div>
    <dl class="usage-facts">
    ${fact("Credential label", request.api_key?.name ?? "Unknown credential")}
    ${fact("Requested model", m?.model || "Unavailable")}
    ${fact("Response model", m?.response_model || "Unavailable")}
    ${fact("Input / context tokens", tokenNumber(m?.input_tokens))}
    ${fact("Output tokens", tokenNumber(m?.output_tokens))}
    ${fact("Total tokens", tokenNumber(m?.total_tokens))}
    ${fact("Provider cache read", tokenNumber(m?.cache_read_tokens))}
    ${fact("Provider cache write", tokenNumber(m?.cache_write_tokens))}
    ${fact("Reasoning tokens", tokenNumber(m?.reasoning_tokens))}
    ${fact("Messages / tools", `${tokenNumber(m?.messages)} / ${tokenNumber(m?.tools)}`)}
    ${fact("Output token limit", tokenNumber(m?.max_output_tokens))}
    ${fact("First response (local)", m?.first_response_ms == null ? "—" : duration(m.first_response_ms))}
    ${m?.input_audio_tokens !== undefined ? fact("Input audio tokens", tokenNumber(m.input_audio_tokens)) : ""}
    ${m?.output_audio_tokens !== undefined ? fact("Output audio tokens", tokenNumber(m.output_audio_tokens)) : ""}
    ${m?.source ? fact("Measurement source", m.source) : ""}
    </dl><p class="usage-detail-note">${explanation} No conversation content is stored by usage tracking.</p></section>`
}

// A single series, with a real zero baseline and gaps for absent counters.
// Every plotted value is also present in the request ledger directly below.
export function contextChart(requests: RelayRequest[], availableWidth = 760): string {
  const ordered = [...requests].sort((a,b) => Date.parse(a.started_at) - Date.parse(b.started_at))
  const known = ordered.filter((r) => r.usage?.input_tokens !== undefined)
  if (!known.length) return `<div class="usage-context-empty">Context sizes will appear when an input-token measurement is received.</div>`
  // Keep SVG text at a legible size: use the rendered width as the viewBox
  // instead of shrinking a wide desktop chart into a narrow dialog.
  const width = Math.max(300, Math.min(760, availableWidth)), height = 164, left = width < 500 ? 44 : 54, right = width < 500 ? 16 : 22, top = 16, bottom = 30
  const max = Math.max(1, ...known.map((r) => r.usage!.input_tokens!)) * 1.1
  const x = (i: number) => ordered.length === 1 ? (left + width - right) / 2 : left + i / (ordered.length - 1) * (width - left - right)
  const y = (n: number) => height - bottom - n / max * (height - top - bottom)
  let pen = false, path = ""
  for (const [i, r] of ordered.entries()) {
    if (r.usage?.input_tokens === undefined) { pen = false; continue }
    path += `${pen ? " L" : " M"}${x(i).toFixed(2)},${y(r.usage.input_tokens).toFixed(2)}`
    pen = true
  }
  const time = (r: RelayRequest) => new Date(r.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  return `<div class="usage-context-plot"><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Input context tokens for requests on this page, oldest to newest. Missing measurements leave gaps.">
    ${[0, .5, 1].map((p) => `<line class="usage-context-grid" x1="${left}" x2="${width-right}" y1="${y(max*p)}" y2="${y(max*p)}"/><text class="usage-context-axis" x="${left-10}" y="${y(max*p)+4}" text-anchor="end">${escape(compactTokens(Math.round(max*p)))}</text>`).join("")}
    <path class="usage-context-line" d="${path}"/>
    ${ordered.map((r,i) => r.usage?.input_tokens === undefined ? "" : `<g class="usage-context-point" tabindex="0" role="img" data-context-point="${i}" aria-label="${escape(`${time(r)}, ${tokenNumber(r.usage.input_tokens)} input tokens, ${r.api_key?.name ?? "Unknown credential"}`)}"><circle class="usage-context-hit" cx="${x(i)}" cy="${y(r.usage.input_tokens)}" r="12"/><circle class="usage-context-dot" cx="${x(i)}" cy="${y(r.usage.input_tokens)}" r="4"/></g>`).join("")}
    <text class="usage-context-axis" x="${left}" y="${height-6}">${escape(time(ordered[0]!))}</text><text class="usage-context-axis" x="${width-right}" y="${height-6}" text-anchor="end">${escape(time(ordered[ordered.length-1]!))}</text>
    <line id="usage-context-crosshair" class="usage-context-crosshair" x1="${left}" x2="${left}" y1="${top}" y2="${height-bottom}" visibility="hidden"/>
    </svg><output class="usage-context-readout" id="usage-context-readout" aria-live="polite">Hover or focus a point to inspect its context size.</output></div>`
}
