import { controlError, countdown, fetchSystem, sendControl, type SystemStatus } from "../lib/system.js"

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (id: string, value: string) => { element(id).textContent = value }
let system: SystemStatus | null = null
let stale = true
let pending = false
let polling = false
let demo = false
let lastMessage = ""
let receivedAt = 0

function badge(id: string, value: string, good: boolean) {
  text(id, value)
  element(id).className = `status-pill ${good ? "good" : "warning"}`
}

function renderAuth() {
  const auth = system?.auth
  if (!auth) return
  if (demo) {
    badge("auth-state", "Sample data", false)
    text("auth-countdown", "—")
    text("auth-deadline", "Sample mode never includes your ChatGPT credential or expiry.")
    return
  }
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
  const disabled = stale || pending || demo || !system?.managed || Boolean(system?.recovery.busy)
  const configuredCodespace = Boolean(system && system.codespace_state !== "not_configured")
  for (const id of ["recover-all", "restart-all", "auto-reconnect"]) element<HTMLButtonElement>(id).disabled = disabled
  for (const id of ["auto-wake", "wake-codespace"]) element<HTMLButtonElement>(id).disabled = disabled || !configuredCodespace
  if (system) {
    element<HTMLInputElement>("auto-reconnect").checked = system.settings.auto_reconnect
    element<HTMLInputElement>("auto-wake").checked = system.settings.auto_wake
    badge("control-connection", demo ? "Sample data" : stale ? "Stale" : system.relay_state === "connected" ? "Connected" : system.recovery.busy ? "Recovering" : "Disconnected", !demo && !stale && system.relay_state === "connected")
    text("recovery-status", demo ? "Sample mode hides live recovery status and disables real controls." : system.error ? controlError(system.error) : system.recovery.busy ? `In progress: ${system.recovery.phase.replaceAll("_", " ")}` : system.recovery.last_error ? controlError(system.recovery.last_error) : system.relay_state === "connected" ? "Authenticated relay is reachable. VPN changes are monitored in the background." : "Monitoring relay connectivity.")
    text("recovery-detail", demo ? "" : `${system.recovery.attempts} automatic recovery attempts${system.recovery.next_retry_at ? ` · next retry ${new Date(system.recovery.next_retry_at).toLocaleTimeString()}` : ""}${system.recovery.last_connected_at ? ` · last connected ${new Date(system.recovery.last_connected_at).toLocaleTimeString()}` : ""}`)
    text("codespace-state", demo ? "Sample data" : configuredCodespace ? `Codespace: ${system.codespace_state}` : "Regular VPS / no Codespace configured")
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
  notice.hidden = !lastMessage && !demo && !stale
  notice.textContent = demo ? "Sample data is enabled. Live service controls are disabled; no sample action can affect your system." : lastMessage || (stale ? "System status is stale. Controls are disabled until a fresh connection is available." : "")
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
  if (!system || stale || pending || demo || system.recovery.busy) return
  if (action === "restart" && !window.confirm(`Restart ${component === "all" ? "all configured services" : component}? Active requests may be interrupted; provider work may already be billed. Cache, tokens, sessions, and saved responses will NOT be erased.`)) return
  if (action === "wake" && !window.confirm("Wake the existing Codespace? GitHub compute usage/billing will resume.")) return
  pending = true
  lastMessage = "Submitting service operation…"
  render()
  try {
    await sendControl("action", { component, action, confirmed: action === "restart" }, system.csrf_token)
    lastMessage = "Operation accepted. Progress is shown above; no model generation was submitted."
  } catch (error) {
    lastMessage = error instanceof Error ? error.message : "The action could not be confirmed. Refresh status before trying again."
  } finally {
    pending = false
    await refresh()
  }
}

async function settings() {
  if (!system || stale || pending || demo) return
  const autoWake = element<HTMLInputElement>("auto-wake").checked
  if (autoWake && !system.settings.auto_wake && !window.confirm("Allow automatic wake of a stopped Codespace? GitHub compute usage/billing will resume whenever recovery wakes it, even with this tab closed.")) { render(); return }
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
element("restart-all").addEventListener("click", () => void actionRequest("all", "restart"))
element("wake-codespace").addEventListener("click", () => void actionRequest("codespace", "wake"))
element("auto-reconnect").addEventListener("change", () => void settings())
element("auto-wake").addEventListener("change", () => void settings())
document.addEventListener("deltarelay:demo", (event) => { demo = Boolean((event as CustomEvent).detail); render() })
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh() })
element("refresh-button").addEventListener("click", () => void refresh())
window.setInterval(() => { if (!document.hidden) void refresh() }, 5000)
window.setInterval(() => { if (!document.hidden) renderAuth() }, 1000)
void refresh()
