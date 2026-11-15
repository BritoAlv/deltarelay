import { countdown, type SystemStatus } from "../../lib/system.js"
import { requiredById } from "../dom.js"
import { facts } from "../../lib/presentation.js"

export function mountAuth(root: HTMLElement) {
  const badge = requiredById(root, "auth-state")
  const timer = requiredById(root, "auth-countdown")
  const deadline = requiredById(root, "auth-deadline")
  let system: SystemStatus | null = null
  let stale = true
  let receivedAt = 0
  let attempted = false

  function render() {
    if (!system) {
      if (!attempted) return
      badge.textContent = "Unavailable"
      badge.className = "status-pill neutral"
      timer.textContent = "No supervisor data"
      timer.className = "auth-countdown"
      deadline.textContent = "The local supervisor did not return authentication metadata."
      return
    }
    const auth = system.auth
    const labels: Record<string, string> = { valid: "Current token", expires_soon: "Expires soon", expired_pending_refresh: "Refresh pending", needs_auth: "Sign-in required", not_configured: "Not configured", not_connected: "Not connected", not_oauth: "Not OAuth", expiry_unknown: "Expiry unknown", unavailable: "Unavailable" }
    const isStale = auth.stale || stale
    const tone = !isStale && auth.state === "valid" ? "good" : "warning"
    badge.textContent = isStale ? "Stale metadata" : labels[auth.state] ?? "Unknown"
    badge.className = `status-pill ${tone}`
    const observed = Date.parse(auth.checked_at ?? system.collected_at)
    const serverNow = Number.isFinite(observed) && receivedAt ? observed + Date.now() - receivedAt : Date.now()
    timer.textContent = auth.expires_at ? `${isStale ? "Last known: " : ""}${countdown(auth.expires_at, serverNow)}` : labels[auth.state] ?? "Unknown"
    timer.className = `auth-countdown ${tone}`
    deadline.innerHTML = auth.expires_at ? facts([["Access token expiry", new Date(auth.expires_at).toLocaleString()], ...(auth.checked_at ? [["Checked", new Date(auth.checked_at).toLocaleTimeString()] as const] : [])]) : "Configure the correct private OpenCode service registration to read expiry metadata. No credentials are shown."
  }

  return {
    render,
    update(status: SystemStatus | null, isStale: boolean, received: number, attemptedPoll = false) {
      system = status
      stale = isStale
      receivedAt = received
      attempted = attemptedPoll
      render()
    },
  }
}
