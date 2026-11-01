import { connectionState, controlError, countdown, desktopLaunchState, fetchSystem, recoveryStatus, remoteActionTarget, sendControl, supportsRemote, type SystemStatus } from "../lib/system.js"

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (id: string, value: string) => { element(id).textContent = value }
let system: SystemStatus | null = null
let stale = true
let pending = false
let polling = false
let lastMessage = ""
let receivedAt = 0
let desktopRequested = false
let desktopError = ""

function badge(id: string, value: string, good: boolean) {
  text(id, value)
  element(id).className = `status-pill ${good ? "good" : "warning"}`
}

function renderAuth() {
  const auth = system?.auth
  if (!auth) return
  const labels: Record<string, string> = { valid: "Current token", expires_soon: "Expires soon", expired_pending_refresh: "Refresh pending", needs_auth: "Sign-in required", not_configured: "Not configured", not_connected: "Not connected", not_oauth: "Not OAuth", expiry_unknown: "Expiry unknown", unavailable: "Unavailable" }
  badge("auth-state", auth.stale || stale ? "Stale metadata" : labels[auth.state] ?? "Unknown", !stale && !auth.stale && auth.state === "valid")
  // Use the server's observation time plus locally elapsed time, so a wrong
  // browser clock cannot invent a sign-in deadline.
  const observed = Date.parse(auth.checked_at ?? system?.collected_at ?? "")
  const serverNow = Number.isFinite(observed) && receivedAt ? observed + Date.now() - receivedAt : Date.now()
  text("auth-countdown", auth.expires_at ? `${auth.stale || stale ? "Last known: " : ""}${countdown(auth.expires_at, serverNow)}` : labels[auth.state] ?? "Unknown")
  text("auth-deadline", auth.expires_at ? `Access token expiry: ${new Date(auth.expires_at).toLocaleString()}${auth.checked_at ? ` · checked ${new Date(auth.checked_at).toLocaleTimeString()}` : ""}` : "Configure the dashboard’s private OpenCode service registration to read expiry metadata. No credentials are shown.")
}

function render() {
  const disabled = stale || pending || !system?.managed || Boolean(system?.recovery.busy)
  const desktop = desktopLaunchState(system, stale, pending)
  element<HTMLButtonElement>("open-desktop").disabled = desktop.disabled
  element("open-desktop").title = desktop.detail
  if (desktopRequested && !stale && !pending && system && !system.recovery.busy) {
    desktopRequested = false
    desktopError = system.recovery.last_error ? controlError(system.recovery.last_error) : ""
  }
  const desktopDetail = !desktop.disabled && desktopError ? desktopError : desktop.detail
  text("desktop-status", desktopRequested && !stale ? "Opening OpenCode Desktop…" : desktopDetail)
  for (const id of ["recover-all", "restart-all", "auto-reconnect"]) element<HTMLButtonElement>(id).disabled = disabled
  const canWake = supportsRemote(system, "host.wake"), canStop = supportsRemote(system, "host.stop")
  element("auto-wake-setting").hidden = !canWake
  element("remote-power-notice").hidden = !canWake && !canStop
  element<HTMLButtonElement>("auto-wake").disabled = disabled || !canWake
  element<HTMLButtonElement>("wake-remote").hidden = !canWake
  element<HTMLButtonElement>("wake-remote").disabled = disabled || !canWake
  element<HTMLButtonElement>("stop-remote").hidden = !canStop
  element<HTMLButtonElement>("stop-remote").disabled = disabled || !canStop || system?.remote.host_state === "stopped" && system.relay_state !== "connected"
  if (system) {
    const connection = connectionState(system)
    element<HTMLInputElement>("auto-reconnect").checked = system.settings.auto_reconnect
    element<HTMLInputElement>("auto-wake").checked = system.settings.auto_wake
    badge("control-connection", stale ? "Stale" : connection === "connected" ? "Connected" : system.recovery.busy ? "Recovering" : connection === "remote_stopped" ? "Stopped" : connection === "no_internet" ? "No internet" : connection === "vps_unreachable" ? "VPS unreachable" : "Disconnected", !stale && connection === "connected")
    const internetDetail = system.internet_checked_at ? ` · checked ${new Date(system.internet_checked_at).toLocaleTimeString()}` : ""
    text("recovery-status", recoveryStatus(system))
    text("network-detail", connection === "remote_stopped" ? "Remote shutdown confirmed. Automatic reconnect and wake are off." : connection === "no_internet" ? `Internet: no connection detected${internetDetail}. The VPS is not the problem yet.` : connection === "vps_unreachable" ? `Internet: reachable${internetDetail}. VPS/relay: no response.` : connection === "connected" ? `Internet: reachable · VPS: reachable${internetDetail}` : `Internet: unknown · VPS: not confirmed${internetDetail}`)
    text("recovery-detail", `${system.recovery.attempts} automatic recovery attempts${system.recovery.next_retry_at ? ` · next retry ${new Date(system.recovery.next_retry_at).toLocaleTimeString()}` : ""}${system.recovery.last_connected_at ? ` · last connected ${new Date(system.recovery.last_connected_at).toLocaleTimeString()}` : ""}`)
    document.dispatchEvent(new CustomEvent("deltarelay:system", { detail: { connection } }))
    text("remote-state", `${system.remote.label}: ${system.remote.host_state}${!canWake && !canStop ? " · power management unavailable" : ""}`)
    const container = element("service-controls")
    container.replaceChildren()
    for (const service of system.components) {
      const row = document.createElement("div")
      row.className = "service-control"
      const title = document.createElement("strong")
      title.textContent = service.label
      const state = document.createElement("span")
      state.className = "section-meta"
      state.textContent = stale ? "Stale" : service.state === "unmanaged" ? "Not configured" : service.state.replaceAll("_", " ")
      row.append(title, state)
      for (const action of ["start", "restart"] as const) {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "text-button"
        button.textContent = action === "start" ? "Start" : "Restart…"
        button.disabled = disabled || !(action === "start" ? service.can_start : service.can_restart)
        button.setAttribute("aria-label", `${action} ${service.label}`)
        button.addEventListener("click", () => void actionRequest(service.id, action))
        row.append(button)
      }
      container.append(row)
    }
  }
  const notice = element("control-notice")
  notice.hidden = !lastMessage && !stale
  notice.textContent = lastMessage || (stale ? "System status is stale. Controls are disabled until a fresh connection is available." : "")
  renderAuth()
}

async function refresh() {
  if (polling) return
  polling = true
  try {
    system = await fetchSystem(AbortSignal.timeout(6000))
    receivedAt = Date.now()
    stale = false
  } catch {
    stale = true
  } finally {
    polling = false
    render()
  }
}

async function actionRequest(component: string, action: string) {
  if (!system || stale || pending || system.recovery.busy) return
  const openingDesktop = component === "desktop" && action === "start"
  if (openingDesktop && desktopLaunchState(system, stale, pending).disabled) return
  if (action === "restart" && !window.confirm(`Restart ${component === "all" ? "all configured services" : component}? Active requests may be interrupted; provider work may already be billed. Cache, tokens, sessions, and saved responses will NOT be erased.`)) return
  if (action === "wake" && (!supportsRemote(system, "host.wake") || !window.confirm("Wake the existing remote host? Compute usage/billing may resume."))) return
  if (action === "stop" && (!supportsRemote(system, "host.stop") || !window.confirm("Stop the remote host? Active requests will be interrupted; provider work may already be billed. Automatic reconnect and wake will be disabled until you re-enable them. Saved files, tokens, cached chunks, and saved responses will NOT be erased."))) return
  pending = true
  if (openingDesktop) {
    desktopRequested = true
    desktopError = ""
  }
  lastMessage = "Submitting service operation…"
  render()
  try {
    await sendControl("action", { component: component === "remote" ? remoteActionTarget(system) : component, action, confirmed: ["restart", "stop", "wake"].includes(action) }, system.csrf_token)
    lastMessage = action === "stop" ? "Stop requested. Shutdown progress and recovery settings are shown above." : "Operation accepted. Progress is shown above; no model generation was submitted."
  } catch (error) {
    lastMessage = error instanceof Error ? error.message : "The action could not be confirmed. Refresh status before trying again."
    if (openingDesktop) {
      desktopRequested = false
      desktopError = lastMessage
    }
  } finally {
    pending = false
    await refresh()
  }
}

async function settings() {
  if (!system || stale || pending) return
  const autoWake = supportsRemote(system, "host.wake") && element<HTMLInputElement>("auto-wake").checked
  if (autoWake && !system.settings.auto_wake && !window.confirm("Allow automatic wake of a stopped remote host? Compute usage/billing may resume whenever recovery wakes it, even with this tab closed.")) { render(); return }
  const next = { auto_reconnect: element<HTMLInputElement>("auto-reconnect").checked, auto_wake: autoWake }
  pending = true
  render()
  try {
    await sendControl("settings", next, system.csrf_token)
    lastMessage = "Recovery settings saved for this profile."
  } catch (error) {
    lastMessage = error instanceof Error ? error.message : "Could not save settings."
  } finally {
    pending = false
    await refresh()
  }
}

element("recover-all").addEventListener("click", () => void actionRequest("all", "recover"))
element("open-desktop").addEventListener("click", () => void actionRequest("desktop", "start"))
element("restart-all").addEventListener("click", () => void actionRequest("all", "restart"))
element("wake-remote").addEventListener("click", () => void actionRequest("remote", "wake"))
element("stop-remote").addEventListener("click", () => void actionRequest("remote", "stop"))
element("auto-reconnect").addEventListener("change", () => void settings())
element("auto-wake").addEventListener("change", () => void settings())
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh() })
element("refresh-button").addEventListener("click", () => void refresh())
window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
window.setInterval(() => { if (!document.hidden) renderAuth() }, 1000)
void refresh()
