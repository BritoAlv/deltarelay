import { connectionState, controlError, countdown, desktopLaunchState, recoveryStatus, sendControl, supportsRemote, type SystemStatus } from "../../lib/system.js"
import { requiredById } from "../dom.js"

export interface ControlsOptions {
  root: HTMLElement
  onRefresh: () => void
  onAction?: () => void
}

export interface ControlsFeature {
  update(status: SystemStatus | null, stale: boolean, receivedAt?: number): void
  renderAuth(): void
}

export function mountControls({ root, onRefresh, onAction }: ControlsOptions): ControlsFeature {
  const recoverAll = requiredById<HTMLButtonElement>(root, "recover-all")
  const restartAll = requiredById<HTMLButtonElement>(root, "restart-all")
  const autoReconnect = requiredById<HTMLInputElement>(root, "auto-reconnect")
  const autoWake = requiredById<HTMLInputElement>(root, "auto-wake")
  const autoWakeSetting = requiredById<HTMLElement>(root, "auto-wake-setting")
  const remotePowerNotice = requiredById<HTMLElement>(root, "remote-power-notice")
  const wakeRemote = requiredById<HTMLButtonElement>(root, "wake-remote")
  const stopRemote = requiredById<HTMLButtonElement>(root, "stop-remote")
  const openDesktop = requiredById<HTMLButtonElement>(root, "open-desktop")
  const desktopStatus = requiredById(root, "desktop-status")
  const controlNotice = requiredById<HTMLElement>(root, "control-notice")
  const serviceControls = requiredById(root, "service-controls")
  const setText = (id: string, value: string) => {
    const element = requiredById(root, id)
    if (element.textContent !== value) element.textContent = value
  }

  let system: SystemStatus | null = null
  let stale = true
  let receivedAt = 0
  let pending = false
  let lastMessage = ""
  let desktopRequested = false
  let desktopError = ""
  let serviceSignature = ""

  const badge = (id: string, value: string, good: boolean) => {
    setText(id, value)
    requiredById(root, id).className = `status-pill ${good ? "good" : "warning"}`
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
    setText("auth-countdown", auth.expires_at ? `${auth.stale || stale ? "Last known: " : ""}${countdown(auth.expires_at, serverNow)}` : labels[auth.state] ?? "Unknown")
    setText("auth-deadline", auth.expires_at ? `Access token expiry: ${new Date(auth.expires_at).toLocaleString()}${auth.checked_at ? ` · checked ${new Date(auth.checked_at).toLocaleTimeString()}` : ""}` : "Configure the dashboard’s private OpenCode service registration to read expiry metadata. No credentials are shown.")
  }

  function render() {
    const disabled = stale || pending || !system?.managed || Boolean(system?.recovery.busy)
    const desktop = desktopLaunchState(system, stale, pending)
    openDesktop.disabled = desktop.disabled
    openDesktop.title = desktop.detail
    if (desktopRequested && !stale && !pending && system && !system.recovery.busy) {
      desktopRequested = false
      desktopError = system.recovery.last_error ? controlError(system.recovery.last_error) : ""
    }
    const desktopDetail = !desktop.disabled && desktopError ? desktopError : desktop.detail
    const nextDesktopStatus = desktopRequested && !stale ? "Opening OpenCode Desktop…" : desktopDetail
    if (desktopStatus.textContent !== nextDesktopStatus) desktopStatus.textContent = nextDesktopStatus
    for (const element of [recoverAll, restartAll, autoReconnect]) element.disabled = disabled
    const canWake = supportsRemote(system, "host.wake"), canStop = supportsRemote(system, "host.stop")
    autoWakeSetting.hidden = !canWake
    remotePowerNotice.hidden = !canWake && !canStop
    autoWake.disabled = disabled || !canWake
    wakeRemote.hidden = !canWake
    wakeRemote.disabled = disabled || !canWake
    stopRemote.hidden = !canStop
    stopRemote.disabled = disabled || !canStop || Boolean(system?.remote.host_state === "stopped" && system.relay_state !== "connected")
    if (system) {
      const connection = connectionState(system)
      autoReconnect.checked = system.settings.auto_reconnect
      autoWake.checked = system.settings.auto_wake
      badge("control-connection", stale ? "Stale" : connection === "connected" ? "Connected" : system.recovery.busy ? "Recovering" : connection === "remote_stopped" ? "Stopped" : connection === "no_internet" ? "No internet" : connection === "vps_unreachable" ? "VPS unreachable" : "Disconnected", !stale && connection === "connected")
      const internetDetail = system.internet_checked_at ? ` · checked ${new Date(system.internet_checked_at).toLocaleTimeString()}` : ""
      setText("recovery-status", recoveryStatus(system))
      setText("network-detail", connection === "remote_stopped" ? "Remote shutdown confirmed. Automatic reconnect and wake are off." : connection === "no_internet" ? `Internet: no connection detected${internetDetail}. The VPS is not the problem yet.` : connection === "vps_unreachable" ? `Internet: reachable${internetDetail}. VPS/relay: no response.` : connection === "connected" ? `Internet: reachable · VPS: reachable${internetDetail}` : `Internet: unknown · VPS: not confirmed${internetDetail}`)
      setText("recovery-detail", `${system.recovery.attempts} automatic recovery attempts${system.recovery.next_retry_at ? ` · next retry ${new Date(system.recovery.next_retry_at).toLocaleTimeString()}` : ""}${system.recovery.last_connected_at ? ` · last connected ${new Date(system.recovery.last_connected_at).toLocaleTimeString()}` : ""}`)
      setText("remote-state", `${system.remote.label}: ${system.remote.host_state}${!canWake && !canStop ? " · power management unavailable" : ""}`)
      const nextSignature = JSON.stringify({
        disabled,
        stale,
        components: system.components.map((service) => [service.id, service.label, service.state, service.can_start, service.can_restart]),
      })
      if (nextSignature !== serviceSignature) {
        serviceSignature = nextSignature
        const active = root.ownerDocument.activeElement as HTMLElement | null
        const focusedLabel = active && serviceControls.contains(active) && active.matches("button[aria-label]") ? active.getAttribute("aria-label") : null
        serviceControls.replaceChildren()
        for (const service of system.components) {
          const row = document.createElement("div")
          row.className = "service-control"
          const title = document.createElement("strong")
          title.textContent = service.label
          const serviceState = document.createElement("span")
          serviceState.className = "section-meta"
          serviceState.textContent = stale ? "Stale" : service.state === "unmanaged" ? "Not configured" : service.state.replaceAll("_", " ")
          row.append(title, serviceState)
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
          serviceControls.append(row)
        }
        if (focusedLabel) {
          const replacement = [...serviceControls.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find((button) => button.getAttribute("aria-label") === focusedLabel)
          replacement?.focus({ preventScroll: true })
        }
      }
    }
    const noticeText = lastMessage || (stale ? "System status is stale. Controls are disabled until a fresh connection is available." : "")
    const noticeWasHidden = controlNotice.hidden
    controlNotice.hidden = !noticeText
    if (noticeText && (noticeWasHidden || controlNotice.textContent !== noticeText)) controlNotice.textContent = noticeText
    renderAuth()
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
      await sendControl("action", { component, action, confirmed: ["restart", "stop", "wake"].includes(action) }, system.csrf_token)
      lastMessage = "Operation accepted. Follow its actual execution in System activity above; no model generation was submitted."
      onAction?.()
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "The action could not be confirmed. Refresh status before trying again."
      if (openingDesktop) {
        desktopRequested = false
        desktopError = lastMessage
      }
    } finally {
      pending = false
      onRefresh()
      render()
    }
  }

  async function settings() {
    if (!system || stale || pending) return
    const nextAutoWake = supportsRemote(system, "host.wake") && autoWake.checked
    if (nextAutoWake && !system.settings.auto_wake && !window.confirm("Allow automatic wake of a stopped remote host? Compute usage/billing may resume whenever recovery wakes it, even with this tab closed.")) { render(); return }
    const next = { auto_reconnect: autoReconnect.checked, auto_wake: nextAutoWake }
    pending = true
    render()
    try {
      await sendControl("settings", next, system.csrf_token)
      lastMessage = "Recovery settings saved for this profile."
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "Could not save settings."
    } finally {
      pending = false
      onRefresh()
      render()
    }
  }

  recoverAll.addEventListener("click", () => void actionRequest("all", "recover"))
  openDesktop.addEventListener("click", () => void actionRequest("desktop", "start"))
  restartAll.addEventListener("click", () => void actionRequest("all", "restart"))
  wakeRemote.addEventListener("click", () => void actionRequest("remote", "wake"))
  stopRemote.addEventListener("click", () => void actionRequest("remote", "stop"))
  autoReconnect.addEventListener("change", () => void settings())
  autoWake.addEventListener("change", () => void settings())

  return {
    update(status, nextStale, nextReceivedAt) {
      if (status) system = status
      stale = nextStale
      if (nextReceivedAt) receivedAt = nextReceivedAt
      render()
    },
    renderAuth,
  }
}
