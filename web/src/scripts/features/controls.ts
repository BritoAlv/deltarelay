import { connectionState, controlError, countdown, recoveryStatus, sendControl, supportsRemote, type SystemStatus } from "../../lib/system.js"
import { nodePresentation, observationStale, type ComponentAction, type NodeID, type TopologyNode } from "../../lib/topology.js"
import { edgePath } from "../../lib/topology-layout.js"
import { escapeHtml as escape } from "../../lib/html.js"
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

const actionLabels: Record<ComponentAction, string> = { start: "Start", recover: "Recover", restart: "Restart…", wake: "Wake…", stop: "Shut down…" }

export function mountControls({ root, onRefresh, onAction }: ControlsOptions): ControlsFeature {
  const startSystem = requiredById<HTMLButtonElement>(root, "start-system")
  const stopSystem = requiredById<HTMLButtonElement>(root, "stop-system")
  const stopRemote = requiredById<HTMLButtonElement>(root, "stop-remote")
  const autoReconnect = requiredById<HTMLInputElement>(root, "auto-reconnect")
  const autoWake = requiredById<HTMLInputElement>(root, "auto-wake")
  const autoWakeSetting = requiredById<HTMLElement>(root, "auto-wake-setting")
  const notice = requiredById<HTMLElement>(root, "control-notice")
  const nodeActions = requiredById(root, "node-actions")
  const edges = requiredById(root, "map-edges")
  const management = requiredById<HTMLInputElement>(root, "map-management")
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-node-id]")]
  const setText = (id: string, value: string) => {
    const element = requiredById(root, id)
    if (element.textContent !== value) element.textContent = value
  }
  let system: SystemStatus | null = null
  let stale = true
  let receivedAt = 0
  let pending = false
  let message = ""
  let selected: NodeID = "gateway"
  let userSelected = false
  let actionSignature = ""
  let edgeSignature = ""
  let stepSignature = ""

  function renderAuth() {
    if (!system) return
    const auth = system.auth
    const labels: Record<string, string> = { valid: "Current token", expires_soon: "Expires soon", expired_pending_refresh: "Refresh pending", needs_auth: "Sign-in required", not_configured: "Not configured", not_connected: "Not connected", not_oauth: "Not OAuth", expiry_unknown: "Expiry unknown", unavailable: "Unavailable" }
    const state = requiredById(root, "auth-state")
    state.textContent = auth.stale || stale ? "Stale metadata" : labels[auth.state] ?? "Unknown"
    state.className = `status-pill ${!stale && !auth.stale && auth.state === "valid" ? "good" : "warning"}`
    const observed = Date.parse(auth.checked_at ?? system.collected_at)
    const serverNow = Number.isFinite(observed) && receivedAt ? observed + Date.now() - receivedAt : Date.now()
    setText("auth-countdown", auth.expires_at ? `${auth.stale || stale ? "Last known: " : ""}${countdown(auth.expires_at, serverNow)}` : labels[auth.state] ?? "Unknown")
    setText("auth-deadline", auth.expires_at ? `Access token expiry: ${new Date(auth.expires_at).toLocaleString()}${auth.checked_at ? ` · checked ${new Date(auth.checked_at).toLocaleTimeString()}` : ""}` : "Configure the correct private OpenCode service registration to read expiry metadata. No credentials are shown.")
  }

  function renderInspector(node: TopologyNode | undefined, disabled: boolean) {
    setText("node-inspector-title", node?.label ?? "Waiting for component contracts")
    setText("node-inspector-status", node ? `Process: ${node.lifecycle.replaceAll("_", " ")} · Readiness: ${node.readiness.replaceAll("_", " ")}` : "An updated supervisor publishes the complete topology and supported actions.")
    setText("node-inspector-detail", node?.detail ?? "No component state or connectivity will be invented while the supervisor is unavailable.")
    const meta = requiredById(root, "node-inspector-meta")
    meta.innerHTML = node ? `<dt>Owner</dt><dd>${escape(node.owner.replaceAll("_", " "))}</dd><dt>Desired state</dt><dd>${escape(node.desired)}</dd><dt>Last checked</dt><dd>${escape(node.checked_at ? new Date(node.checked_at).toLocaleTimeString() : "Not independently checked")}</dd>` : ""
    const actions = node?.actions ?? []
    const stopped = system?.topology?.intent.system === "stopped"
    const signature = JSON.stringify([selected, actions, disabled, stopped, node?.lifecycle])
    if (signature !== actionSignature) {
      actionSignature = signature
      const focused = root.ownerDocument.activeElement as HTMLElement | null
      const focusedAction = focused && nodeActions.contains(focused) ? focused.dataset.componentAction : null
      nodeActions.replaceChildren()
      for (const action of actions) {
        const button = root.ownerDocument.createElement("button")
        button.type = "button"
        button.className = `button ${action === "stop" ? "button-danger" : ""}`
        button.textContent = actionLabels[action]
        button.dataset.componentAction = action
        button.setAttribute("aria-label", `${action} ${node!.label}`)
        const alreadyStarted = action === "start" && ["running", "starting", "started"].includes(node!.lifecycle)
        button.disabled = disabled || alreadyStarted || stopped
        if (stopped) button.title = "Use Start system to resume the intentionally stopped stack."
        button.addEventListener("click", () => void actionRequest(selected, action))
        nodeActions.append(button)
      }
      if (!actions.length) {
        const text = root.ownerDocument.createElement("p")
        text.className = "control-detail"
        text.textContent = selected === "supervisor" ? "Managed by startup.sh. This controller stays running after system shutdown." : "Read-only component. No supported lifecycle action is advertised."
        nodeActions.append(text)
      }
      if (focusedAction) nodeActions.querySelector<HTMLButtonElement>(`[data-component-action="${focusedAction}"]`)?.focus({ preventScroll: true })
    }
    const connections = requiredById(root, "node-connections")
    const related = system?.topology?.edges.filter((edge) => edge.source === selected || edge.target === selected) ?? []
    connections.innerHTML = related.length ? `<h4>Connections</h4>${related.map((edge) => `<p><strong>${escape(edge.source.replaceAll("_", " "))} → ${escape(edge.target.replaceAll("_", " "))}</strong><span>${escape(edge.protocol)} · ${stale ? "stale" : escape(edge.state.replaceAll("_", " "))}</span></p>`).join("")}` : ""
  }

  function render() {
    const topology = system?.topology
    const disabled = stale || pending || !system?.managed || Boolean(system?.recovery.busy) || topology?.run?.status === "running"
    const stopped = topology?.intent.system === "stopped"
    const canWake = supportsRemote(system, "host.wake")
    const canStop = supportsRemote(system, "host.stop")
    startSystem.disabled = disabled || !topology
    stopRemote.disabled = disabled || !canStop || Boolean(system?.remote.host_state === "stopped" && system?.relay_state !== "connected")
    stopRemote.title = canStop ? "Stop the remote host; automatic wake and reconnect remain off." : "This remote-host provider does not support power-off. Use its hosting controls."
    stopSystem.disabled = disabled || !topology || Boolean(topology.shutdown_blockers.length)
    stopSystem.title = topology?.shutdown_blockers.length ? `Configure stop_command for: ${topology.shutdown_blockers.join(", ")}` : "Stop the managed applications; keep this dashboard and its supervisor running."
    autoReconnect.disabled = disabled || Boolean(stopped)
    autoWakeSetting.hidden = !canWake
    autoWake.disabled = disabled || !canWake || Boolean(stopped)
    autoReconnect.checked = system?.settings.auto_reconnect ?? false
    autoWake.checked = system?.settings.auto_wake ?? false

    if (system) {
      const connection = connectionState(system)
      const badge = requiredById(root, "control-connection")
      badge.textContent = stale ? "Stale" : stopped ? "System stopped" : system.recovery.busy ? "Recovering" : connection === "connected" ? "Relay connected" : connection === "remote_stopped" ? "VPS stopped" : connection === "no_internet" ? "Waiting for network" : "Connection unavailable"
      badge.className = `status-pill ${!stale && !stopped && connection === "connected" ? "good" : "neutral"}`
      const run = topology?.run
      const current = topology?.nodes.find((node) => node.id === run?.current_component)
      if (!userSelected && current) selected = current.id
      setText("recovery-status", stopped ? "System intentionally stopped. The dashboard and supervisor remain available. Use Start system to resume automatic operation." : run?.status === "running" && current ? `${current.label}: ${run.current_action}…` : recoveryStatus(system))
      setText("network-detail", `Automatic recovery ${system.settings.auto_reconnect ? "enabled" : "paused"} · ${topology ? `${topology.network.generation} network changes observed` : "Waiting for topology-capable supervisor"}${topology?.network.changed_at ? ` · last change ${new Date(topology.network.changed_at).toLocaleTimeString()}` : ""}. Ethernet, Wi-Fi and VPN paths are monitored without changing them.`)
      setText("recovery-detail", `${system.recovery.attempts} automatic connection attempts${system.recovery.next_retry_at ? ` · next retry ${new Date(system.recovery.next_retry_at).toLocaleTimeString()}` : ""}${system.recovery.last_connected_at ? ` · last connected ${new Date(system.recovery.last_connected_at).toLocaleTimeString()}` : ""}`)
      setText("shutdown-detail", topology?.shutdown_blockers.length ? `System shutdown needs an explicit stop_command for: ${topology.shutdown_blockers.join(", ")}. No broad process matching or machine shutdown is used.` : `System shutdown keeps the dashboard and supervisor running.${canStop ? " The VPS is also stopped." : " Remote power-off is unsupported by this provider; stop it through your hosting controls to avoid continued billing."} Your PC is never powered off.`)
      const nextSteps = JSON.stringify(run)
      if (nextSteps !== stepSignature) {
        stepSignature = nextSteps
        const list = requiredById(root, "recovery-steps")
        list.replaceChildren()
        if (run) {
          const summary = root.ownerDocument.createElement("li")
          summary.textContent = `${run.trigger} ${run.action} ${run.target} · ${run.status}${run.error ? ` · ${controlError(run.error)}` : ""}`
          list.append(summary)
          for (const step of run.steps) {
            const item = root.ownerDocument.createElement("li")
            item.dataset.stepState = step.status
            item.textContent = `${topology?.nodes.find((node) => node.id === step.component)?.label ?? step.component}: ${step.action} · ${step.status}${step.error ? ` · ${controlError(step.error)}` : ""}`
            list.append(item)
          }
        } else {
          const item = root.ownerDocument.createElement("li")
          item.textContent = "No recovery operation has been observed yet."
          list.append(item)
        }
      }
    }

    for (const button of buttons) {
      const node = topology?.nodes.find((item) => item.id === button.dataset.nodeId)
      const isBrowser = node?.id === "dashboard_ui"
      const observed = node && isBrowser && !stale ? { ...node, lifecycle: "running", readiness: "ready" as const } : node
      const presentation = observed ? nodePresentation(observed, stale || observationStale(observed, system!.collected_at)) : { label: "Not verified", tone: "neutral" }
      button.dataset.tone = presentation.tone
      button.classList.toggle("is-working", presentation.tone === "working")
      button.setAttribute("aria-pressed", String(button.dataset.nodeId === selected))
      const label = button.querySelector<HTMLElement>("[data-node-label]")!
      if (node && label.textContent !== node.label) label.textContent = node.label
      button.querySelector<HTMLElement>("[data-node-status]")!.textContent = presentation.label
      button.setAttribute("aria-label", `${label.textContent}: ${presentation.label}`)
    }
    const nextEdges = JSON.stringify([topology?.edges, stale, selected, management.checked])
    if (nextEdges !== edgeSignature) {
      edgeSignature = nextEdges
      edges.replaceChildren()
      for (const edge of topology?.edges ?? []) {
        if (edge.relation === "manages" && !management.checked && ![edge.source, edge.target].includes(selected)) continue
        // This page fetching fresh status is direct evidence for its own edge.
        const state = !stale && edge.id === "dashboard_ui_dashboard" ? "ready" : stale ? "unknown" : edge.state
        const path = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path")
        path.setAttribute("d", edgePath(edge.source, edge.target))
        path.setAttribute("class", `map-edge ${edge.relation} ${state}${[edge.source, edge.target].includes(selected) ? " selected" : ""}`)
        path.setAttribute("marker-end", "url(#map-arrow)")
        const title = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "title")
        title.textContent = `${edge.source} → ${edge.target}: ${edge.protocol} · ${state.replaceAll("_", " ")}`
        path.append(title)
        edges.append(path)
      }
    }
    renderInspector(topology?.nodes.find((node) => node.id === selected), disabled)
    const text = message || (stale ? "System status is stale. Lifecycle actions are disabled until fresh status is available." : !topology ? "The supervisor needs the topology update before map controls are available. No running services were changed." : "")
    notice.hidden = !text
    if (notice.textContent !== text) notice.textContent = text
    renderAuth()
  }

  async function actionRequest(component: string, action: ComponentAction) {
    if (!system || stale || pending || system.recovery.busy || !system.topology) return
    const systemAction = component === "all"
    const needsConfirmation = ["restart", "stop", "wake"].includes(action) || systemAction && action === "start"
    if (needsConfirmation) {
      const explanation = systemAction && action === "start" ? "Start the configured local applications and resume automatic recovery? The existing VPS may be woken and compute billing may resume. Automatic wake permission is not enabled." : systemAction && action === "stop" ? `Shut down the managed local applications${supportsRemote(system, "host.stop") ? " and VPS" : " (VPS power-off is unsupported and compute billing may continue)"}? The dashboard and supervisor stay running. Your PC stays on. Automatic recovery is paused before stopping anything.` : component === "remote" && action === "stop" ? "Shut down the VPS? Active requests will be interrupted. Automatic reconnect and wake will be disabled until explicitly resumed." : action === "wake" ? "Wake the existing VPS and recover its connection? Compute billing may resume. This does not enable automatic wake." : `Restart ${system.topology.nodes.find((node) => node.id === component)?.label ?? component}? Active requests may be interrupted and provider work may already be billed.`
      if (!window.confirm(`${explanation} Saved files, tokens, cache, sessions and responses are preserved.`)) return
    }
    pending = true
    message = "Submitting operation…"
    render()
    try {
      const requestID = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      await sendControl("action", { component, action, confirmed: needsConfirmation, request_id: requestID }, system.csrf_token)
      message = "Operation accepted. Its actual component steps appear on the map; no model generation was submitted."
      onAction?.()
    } catch (error) {
      message = error instanceof Error ? error.message : "The outcome is uncertain. Refresh status before submitting another operation."
    } finally {
      pending = false
      onRefresh()
      render()
    }
  }

  async function settings() {
    if (!system || stale || pending || system.recovery.busy) return
    const wake = supportsRemote(system, "host.wake") && autoWake.checked
    if (wake && !system.settings.auto_wake && !window.confirm("Allow automatic wake of the existing VPS, even with this page closed? Compute billing may resume.")) { render(); return }
    pending = true
    render()
    try {
      await sendControl("settings", { auto_reconnect: autoReconnect.checked, auto_wake: wake }, system.csrf_token)
      message = "Automatic recovery settings saved. Intentional shutdown remains in force until Start system or an explicit wake."
    } catch (error) {
      message = error instanceof Error ? error.message : "Settings could not be saved."
    } finally { pending = false; onRefresh(); render() }
  }

  for (const button of buttons) button.addEventListener("click", () => { selected = button.dataset.nodeId as NodeID; userSelected = true; render() })
  management.addEventListener("change", render)
  startSystem.addEventListener("click", () => void actionRequest("all", "start"))
  stopSystem.addEventListener("click", () => void actionRequest("all", "stop"))
  stopRemote.addEventListener("click", () => void actionRequest("remote", "stop"))
  autoReconnect.addEventListener("change", () => void settings())
  autoWake.addEventListener("change", () => void settings())

  return {
    update(status, nextStale, nextReceivedAt) { if (status) system = status; stale = nextStale; receivedAt = nextReceivedAt ?? receivedAt; render() },
    renderAuth,
  }
}
