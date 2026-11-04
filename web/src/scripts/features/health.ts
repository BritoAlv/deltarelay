import { escapeHtml as escape } from "../../lib/html.js"
import { bytes, duration } from "../../lib/metrics.js"
import { observationConnection, type DashboardViewState } from "../../lib/state.js"
import { requiredById } from "../dom.js"

export interface HealthFeature {
  render(state: DashboardViewState): void
}

const pill = (label: string, status: string) => `<span class="status-pill ${status}">${escape(label)}</span>`

export function mountHealth(root: HTMLElement): HealthFeature {
  const cards = requiredById(root, "system-cards")
  const initialCards = cards.innerHTML
  const icons = [...cards.querySelectorAll(".system-icon")].map((icon) => icon.innerHTML)
  const setText = (id: string, value: string | number) => { requiredById(root, id).textContent = String(value) }

  function renderSystem(state: DashboardViewState) {
    if (!state.snapshot) {
      setText("system-summary", "Waiting for diagnostics")
      cards.innerHTML = initialCards
      return
    }
    const data = state.snapshot
    const { gateway, relay, history } = data
    const health = relay.health
    const stale = state.stale
    const networkConnection = observationConnection(state.system)
    const controlIssue = gateway.pending_cancellations > 0 || Boolean(gateway.control_error)
    const cacheRatio = health.max_cache_bytes > 0 ? health.cache_bytes / health.max_cache_bytes : 0
    const responseRatio = health.max_response_storage_bytes > 0 ? health.response_storage_bytes / health.max_response_storage_bytes : 0
    const storageIssue = Math.max(cacheRatio, responseRatio) >= .85
    const providerIssue = data.providers.some((provider) => provider.last_status !== 499 && (provider.last_status >= 400 || provider.last_error))
    const remoteStopped = !relay.reachable && networkConnection === "remote_stopped"
    const noInternet = !relay.reachable && networkConnection === "no_internet"
    const vpsUnreachable = !relay.reachable && networkConnection === "vps_unreachable"
    setText("system-summary", stale ? "Stale · last observed states below" : remoteStopped ? "Remote host stopped" : noInternet ? "No internet" : vpsUnreachable ? "VPS needs attention" : !relay.reachable ? "VPS needs attention" : !health.forwarding ? "Forwarding is disabled" : controlIssue || storageIssue ? "Attention needed" : "Relay checks passed")
    const statePill = (label: string, status: string) => pill(stale ? "Stale" : label, stale ? "warning" : status)
    const providers = data.providers.map((provider) => {
      const cancelled = provider.last_status === 499
      const issue = !cancelled && (provider.last_status >= 400 || Boolean(provider.last_error))
      const status = provider.active > 0 ? "active" : issue ? "warning" : cancelled ? "neutral" : provider.last_seen ? "good" : "neutral"
      const label = provider.active > 0 ? `${provider.active} running` : cancelled ? "cancelled" : provider.last_seen ? provider.last_error || `HTTP ${provider.last_status}` : "Unobserved"
      return `<div class="provider-item"><span title="${escape(provider.last_seen ? `Last result ${new Date(provider.last_seen).toLocaleString()}` : "No retained requests")}">${escape(provider.name)}</span>${pill(label, status)}</div>`
    }).join("")
    cards.innerHTML = `
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[0]}</span>${statePill(controlIssue ? "Attention" : "Online", controlIssue ? "warning" : "good")}</div><h3>Local gateway</h3><p>${gateway.active} of ${gateway.concurrency} request slots in use<br />${gateway.pending_cancellations} pending cancellations${gateway.control_error ? " · control error" : ""}</p><p class="system-meta">Uptime ${escape(duration(Math.max(0, Date.parse(data.collected_at) - Date.parse(gateway.started_at))))}</p></article>
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[1]}</span>${statePill(remoteStopped ? "Stopped" : noInternet ? "No internet" : relay.reachable ? "Connected" : "Unreachable", remoteStopped ? "neutral" : noInternet ? "warning" : relay.reachable ? "good" : "bad")}</div><h3>VPS connection</h3><p>${relay.reachable ? `Protocol v${health.version} · ${relay.latency_ms} ms health check<br />Authenticated relay identity` : remoteStopped ? "Remote shutdown confirmed.<br />Resume using System controls or your hosting provider." : noInternet ? "Internet connectivity from this computer failed.<br />The VPS has not been contacted." : vpsUnreachable ? "Internet is reachable, but the relay did not respond.<br />Check the relay, VPN split routes, or SSH tunnel." : "Health check failed or timed out.<br />Check relay, VPN, or SSH tunnel."}</p><p class="system-meta">${relay.reachable ? `STATE ${escape(health.state_id.slice(0, 14))}…` : remoteStopped ? "AUTOMATIC RECOVERY OFF" : noInternet ? "CHECK LOCAL NETWORK" : "NO DIRECT FALLBACK"}</p></article>
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[2]}</span>${statePill(!relay.reachable ? "Unknown" : storageIssue ? "Near capacity" : "Available", !relay.reachable ? "neutral" : storageIssue ? "warning" : "good")}</div><h3>Storage &amp; mailbox</h3><p>${relay.reachable ? `Cache ${escape(bytes(health.cache_bytes))} / ${escape(bytes(health.max_cache_bytes))}<br />Responses ${escape(bytes(health.response_storage_bytes))} / ${escape(bytes(health.max_response_storage_bytes))}` : noInternet ? "Storage usage is unavailable.<br />Restore internet connectivity." : "Storage usage is unavailable.<br />Restore the VPS connection."}</p><div class="storage-meter" title="Highest of cache and response-storage usage"><span style="width:${relay.reachable ? Math.min(100, Math.max(cacheRatio, responseRatio) * 100) : 0}%"></span></div><p class="system-meta">${history.persistence_error ? "HISTORY SAVE FAILED" : history.persistent ? "SESSION HISTORY SAVED LOCALLY" : "SESSION HISTORY IN MEMORY"}</p></article>
      <article class="system-card"><div class="system-card-top"><span class="system-icon">${icons[3]}</span>${statePill(!relay.reachable ? "Unknown" : health.forwarding ? providerIssue ? "Check results" : "Enabled" : "Disabled", !relay.reachable ? "neutral" : !health.forwarding || providerIssue ? "warning" : "good")}</div><h3>Provider forwarding</h3><p>Latest retained results, not live probes</p><div class="provider-list">${providers || '<span class="section-meta">No upstream observations</span>'}</div></article>`
  }

  return { render: renderSystem }
}
