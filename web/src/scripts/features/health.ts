import { escapeHtml as escape } from "../../lib/html.js"
import { facts } from "../../lib/presentation.js"
import { bytes, duration } from "../../lib/metrics.js"
import { observationConnection, type DashboardViewState } from "../../lib/state.js"
import { countdown, type AllowanceMeter, type AuthStatus, type GoAllowance } from "../../lib/system.js"
import type { Snapshot } from "../../lib/types.js"
import { requiredById } from "../dom.js"

export interface HealthFeature {
  render(state: DashboardViewState): void
}

interface ProviderView {
  name: string
  label: string
  origin?: string
  pathPrefix?: string
  issue: boolean
  status: "active" | "warning" | "neutral" | "good"
  statusLabel: string
}

const pill = (label: string, status: string) => `<span class="status-pill ${status}">${escape(label)}</span>`

function providerLabel(name: string, names: string[]): string {
  return name === "opencode" && !names.includes("opencode-go") ? "opencode-go" : name
}

function providerView(provider: Snapshot["providers"][number], label: string): ProviderView {
  const cancelled = provider.last_status === 499
  const issue = !cancelled && (provider.last_status >= 400 || Boolean(provider.last_error))
  const status = provider.active > 0 ? "active" : issue ? "warning" : cancelled ? "neutral" : provider.last_seen ? "good" : "neutral"
  const statusLabel = provider.active > 0 ? `${provider.active} running` : cancelled ? "cancelled" : provider.last_seen ? provider.last_error || `HTTP ${provider.last_status}` : "Unobserved"
  return {
    name: provider.name,
    label,
    origin: provider.origin,
    pathPrefix: provider.path_prefix,
    issue,
    status,
    statusLabel,
  }
}

function providerSortRank(provider: ProviderView): number {
  if (provider.label === "opencode-go") return 0
  if (provider.name === "openai") return 1
  return 2
}

function authNeedsAttention(auth: AuthStatus | null): boolean {
  return Boolean(auth && (auth.stale || auth.state !== "valid"))
}

function goLimited(go: GoAllowance | null): boolean {
  return Boolean(go && [go.rolling, go.weekly, go.monthly].some((meter) => meter.limited || meter.percent >= 100))
}

function goStale(go: GoAllowance | null, systemStale: boolean): boolean {
  return Boolean(go && (go.stale || systemStale))
}

function tabTone(provider: ProviderView, auth: AuthStatus | null, go: GoAllowance | null): "ok" | "warning" | "neutral" {
  if (provider.name === "openai" && authNeedsAttention(auth)) return "warning"
  if (provider.label === "opencode-go" && (goLimited(go) || goStale(go, false))) return "warning"
  if (provider.issue) return "warning"
  return provider.status === "active" || provider.status === "good" ? "ok" : "neutral"
}

function resetLabel(resetsAt: string): string {
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return "reset time unknown"
  if (at <= Date.now()) return "resetting…"
  return `resets in ${countdown(resetsAt)}`
}

function meterDisplay(meter: AllowanceMeter): { percent: number; value: string; limited: boolean } {
  const percent = Math.min(100, Math.max(0, meter.percent))
  const rounded = Math.round(percent * 10) / 10
  return { percent, value: Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1), limited: meter.limited || meter.percent >= 100 }
}

function usageRow(label: string, meter: AllowanceMeter): string {
  const { percent, value, limited } = meterDisplay(meter)
  const tone = limited ? " warning" : ""
  return `<div class="provider-usage-row${tone}"><span class="provider-usage-label">${escape(label)}</span><span class="provider-usage-track" role="progressbar" aria-label="${escape(label)} Go allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i style="width:${percent}%"></i></span><span class="provider-usage-percent">${value}%</span><span class="provider-usage-reset" title="${escape(new Date(meter.resets_at).toLocaleString())}">${escape(resetLabel(meter.resets_at))}</span></div>`
}

function usagePanel(go: GoAllowance | null, systemStale: boolean): string {
  if (!go) return `<div class="provider-usage-empty"><span class="status-pill neutral">Unavailable</span><p>Go usage is unavailable for this OpenCode profile.</p></div>`
  const stale = goStale(go, systemStale)
  const limited = goLimited(go)
  const state = stale ? "Stale" : limited ? "Limit reached" : "Within limits"
  return `<div class="provider-usage"><div class="provider-usage-head"><span>Go allowance</span>${pill(state, stale || limited ? "warning" : "good")}</div>${usageRow("5-hour", go.rolling)}${usageRow("Week", go.weekly)}${usageRow("Month", go.monthly)}</div>`
}

export function mountHealth(root: HTMLElement): HealthFeature {
  const cards = requiredById(root, "system-cards")
  const auth = requiredById(root, "provider-auth")
  const initialCards = cards.innerHTML
  const icons = [...cards.querySelectorAll(".system-icon")].map((icon) => icon.innerHTML)
  const setText = (id: string, value: string | number) => {
    const element = requiredById(root, id)
    const nextValue = String(value)
    if (element.textContent !== nextValue) element.textContent = nextValue
  }
  const summaryElement = requiredById<HTMLElement>(root, "system-summary")
  let activeProvider: string | null = null

  cards.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-provider-tab]") : null
    if (!button) return
    const name = button.dataset.providerTab
    if (!name) return
    activeProvider = name
    for (const tab of cards.querySelectorAll<HTMLButtonElement>("[data-provider-tab]")) {
      tab.setAttribute("aria-selected", String(tab === button))
    }
    for (const panel of cards.querySelectorAll<HTMLElement>("[data-provider-panel]")) {
      panel.hidden = panel.dataset.providerPanel !== name
    }
  })

  cards.addEventListener("keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key
    if (key !== "ArrowLeft" && key !== "ArrowRight") return
    const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-provider-tab]") : null
    if (!current) return
    const tabs = [...cards.querySelectorAll<HTMLButtonElement>("[data-provider-tab]")]
    const index = tabs.indexOf(current)
    if (index < 0 || tabs.length < 2) return
    event.preventDefault()
    const next = tabs[(index + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
    next?.focus()
    next?.click()
  })

  function renderSystem(state: DashboardViewState) {
    if (!state.snapshot) {
      setText("system-summary", "Waiting for diagnostics…")
      summaryElement.classList.remove("good", "warning")
      cards.innerHTML = initialCards
      cards.querySelector("#provider-auth")?.replaceWith(auth)
      return
    }
    const data = state.snapshot
    const { gateway, relay, history } = data
    const health = relay.health
    const stale = state.stale
    const networkConnection = observationConnection(state.system)
    const authStatus = state.system?.auth ?? null
    const go = state.system?.go ?? null
    const controlIssue = gateway.pending_cancellations > 0 || Boolean(gateway.control_error)
    const cacheRatio = health.max_cache_bytes > 0 ? health.cache_bytes / health.max_cache_bytes : 0
    const responseRatio = health.max_response_storage_bytes > 0 ? health.response_storage_bytes / health.max_response_storage_bytes : 0
    const storageIssue = Math.max(cacheRatio, responseRatio) >= .85
    const storagePercent = relay.reachable ? Math.round(Math.min(1, Math.max(cacheRatio, responseRatio)) * 100) : 0
    const providerIssue = data.providers.some((provider) => provider.last_status !== 499 && (provider.last_status >= 400 || provider.last_error)) || goLimited(go)
    const remoteStopped = !relay.reachable && networkConnection === "remote_stopped"
    const noInternet = !relay.reachable && networkConnection === "no_internet"
    const vpsUnreachable = !relay.reachable && networkConnection === "vps_unreachable"
    const remoteHost = data.history.host || "Unknown"
    const summary = stale ? "Stale · last observed states below" : remoteStopped ? "Remote host stopped" : noInternet ? "No internet" : !relay.reachable ? "Remote host needs attention" : !health.forwarding ? "Forwarding is disabled" : controlIssue || storageIssue ? "Attention needed" : "Relay checks passed"
    setText("system-summary", summary)
    summaryElement.classList.toggle("good", !stale && summary === "Relay checks passed")
    summaryElement.classList.toggle("warning", stale || summary !== "Relay checks passed")
    const statePill = (label: string, status: string) => pill(stale ? "Stale" : label, stale ? "warning" : status)

    const names = data.providers.map((provider) => provider.name)
    const providers = data.providers.map((provider) => providerView(provider, providerLabel(provider.name, names)))
    if (!providers.some((provider) => provider.name === "openai") && authStatus) {
      providers.push({ name: "openai", label: "openai", issue: false, status: "neutral", statusLabel: "Unobserved" })
    }
    if (!providers.some((provider) => provider.label === "opencode-go") && go) {
      providers.unshift({ name: "opencode", label: "opencode-go", issue: false, status: "neutral", statusLabel: "Unobserved" })
    }
    providers.sort((a, b) => providerSortRank(a) - providerSortRank(b) || a.label.localeCompare(b.label))
    if (activeProvider && !providers.some((provider) => provider.label === activeProvider)) activeProvider = null
    const selected = activeProvider ?? providers[0]?.label ?? null
    activeProvider = selected

    const tabs = providers.length > 1 ? `<div class="provider-tabs" role="tablist" aria-label="Providers">${providers.map((provider, index) => `<button type="button" class="provider-tab" role="tab" id="provider-tab-${index}" aria-controls="provider-panel-${index}" aria-selected="${provider.label === selected}" data-provider-tab="${escape(provider.label)}"><span class="provider-tab-dot ${tabTone(provider, authStatus, go)}"></span><span>${escape(provider.label)}</span></button>`).join("")}</div>` : ""
    const panels = providers.length > 0 ? `<div class="provider-panels">${providers.map((provider, index) => {
      const origin = provider.origin ? provider.origin.replace(/^https?:\/\//, "") + (provider.pathPrefix ? ` · ${provider.pathPrefix}` : "") : ""
      return `<section class="provider-panel" id="provider-panel-${index}" role="tabpanel" aria-labelledby="provider-tab-${index}" data-provider-panel="${escape(provider.label)}"${provider.label === selected ? "" : " hidden"}><div class="provider-panel-head"><div class="provider-name"><span class="provider-dot ${tabTone(provider, authStatus, go)}"></span><span>${escape(provider.label)}</span>${provider.label === "opencode-go" ? '<span class="provider-go">GO</span>' : ""}</div>${pill(stale ? "Stale" : provider.statusLabel, stale ? "warning" : provider.status)}</div>${origin ? `<div class="provider-origin">${escape(origin)}</div>` : ""}${provider.label === "opencode-go" ? usagePanel(go, Boolean(state.system?.stale)) : ""}${provider.name === "openai" ? '<div id="provider-auth"></div>' : ""}</section>`
    }).join("")}<div class="provider-foot"><span>${providers.length > 1 ? "Switch tabs to inspect each provider" : "Latest retained result"}</span><span>${providers.length} upstream${providers.length === 1 ? "" : "s"}</span></div></div>` : '<div class="provider-list-empty"><span class="section-meta">No upstream observations</span></div>'

    cards.innerHTML = `
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[0]}</span>${statePill(controlIssue ? "Attention" : "Online", controlIssue ? "warning" : "good")}</div><h3>Local gateway</h3>${facts([["Request slots in use", `${gateway.active} of ${gateway.concurrency}`], ["Pending cancellations", gateway.pending_cancellations], ["Uptime", duration(Math.max(0, Date.parse(data.collected_at) - Date.parse(gateway.started_at)))]])}${gateway.control_error ? '<p class="warning">Control error</p>' : ""}</article>
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[1]}</span>${statePill(remoteStopped ? "Stopped" : noInternet ? "No internet" : relay.reachable ? "Connected" : "Unreachable", remoteStopped ? "neutral" : noInternet ? "warning" : relay.reachable ? "good" : "bad")}</div><h3>Remote host connection</h3>${relay.reachable ? `${facts([["Host", remoteHost], ["Protocol", `v${health.version}`], ["Health check", `${relay.latency_ms} ms`], ["State ID", `${health.state_id.slice(0, 14)}…`]])}<p>Authenticated relay identity</p>` : `<p>${remoteStopped ? "Remote shutdown confirmed.<br />Resume using System controls or your hosting provider." : noInternet ? "Internet connectivity from this computer failed.<br />The remote host has not been contacted." : vpsUnreachable ? "Internet is reachable, but the relay did not respond.<br />Check the relay, VPN split routes, or SSH tunnel." : "Health check failed or timed out.<br />Check relay, VPN, or SSH tunnel."}</p><p class="system-meta">HOST ${escape(remoteHost.toUpperCase())} · ${remoteStopped ? "AUTOMATIC RECOVERY OFF" : noInternet ? "CHECK LOCAL NETWORK" : "NO DIRECT FALLBACK"}</p>`}</article>
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[2]}</span>${statePill(!relay.reachable ? "Unknown" : storageIssue ? "Near capacity" : "Available", !relay.reachable ? "neutral" : storageIssue ? "warning" : "good")}</div><h3>Storage &amp; mailbox</h3>${relay.reachable ? facts([["Cache used / limit", `${bytes(health.cache_bytes)} / ${bytes(health.max_cache_bytes)}`], ["Responses used / limit", `${bytes(health.response_storage_bytes)} / ${bytes(health.max_response_storage_bytes)}`]]) : `<p>${noInternet ? "Storage usage is unavailable.<br />Restore internet connectivity." : "Storage usage is unavailable.<br />Restore the remote host connection."}</p>`}<div class="storage-meter" role="progressbar" aria-label="Highest of cache and response-storage usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${storagePercent}" title="Highest of cache and response-storage usage"><span style="width:${relay.reachable ? Math.min(100, Math.max(cacheRatio, responseRatio) * 100) : 0}%"></span></div><p class="system-meta">${history.persistence_error ? "HISTORY SAVE FAILED" : history.persistent ? "SESSION HISTORY SAVED LOCALLY" : "SESSION HISTORY IN MEMORY"}</p></article>
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[3]}</span>${statePill(!relay.reachable ? "Unknown" : health.forwarding ? providerIssue ? "Check results" : "Enabled" : "Disabled", !relay.reachable ? "neutral" : !health.forwarding || providerIssue ? "warning" : "good")}</div><h3>Provider forwarding</h3><p>Latest retained results, not live probes</p>${tabs}${panels}</article>`
    cards.querySelector("#provider-auth")?.replaceWith(auth)
  }

  return { render: renderSystem }
}
