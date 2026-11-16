import { connectionState, recoveryStatus, sendControl, shutdownInProgress, shutdownStatus, supportsRemote, type SystemStatus } from "../../lib/system.js"
import { iconMarkup, remoteHostIcon } from "../../lib/icons.js"
import { edgeChannel, observationStale, type ComponentAction, type NodeID, type TopologyNode } from "../../lib/topology.js"
import { edgePath, responsePath, mapBoundaries, transportBoundary } from "../../lib/topology-layout.js"
import { escapeHtml as escape } from "../../lib/html.js"
import { dataValue } from "../../lib/presentation.js"
import { controlComponents } from "../../lib/component-controls.js"
import { requiredById } from "../dom.js"
import { mountMapNavigation } from "./map-navigation.js"
import { mountComponentTable } from "./component-table.js"
import { readPreferences, savePreferences } from "../../lib/preferences.js"

export interface ControlsOptions {
  root: HTMLElement
  onRefresh: () => void
  onAction?: () => void
}

export interface ControlsFeature {
  update(status: SystemStatus | null, stale: boolean, receivedAt?: number, loading?: boolean): void
  destroy(): void
}

const readableLabel = (value: string) => {
  const words = value.replaceAll("_", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
const statusTone = (state: string) => state === "completed" || state === "ready" ? "good" : state === "running" ? "active" : ["failed", "blocked", "unreachable"].includes(state) ? "warning" : "neutral"

export function mountControls({ root, onRefresh, onAction }: ControlsOptions): ControlsFeature {
  const navigation = mountMapNavigation(root)
  const startSystem = requiredById<HTMLButtonElement>(root, "start-system")
  const stopSystem = requiredById<HTMLButtonElement>(root, "stop-system")
  const autoReconnect = requiredById<HTMLInputElement>(root, "auto-reconnect")
  const autoWake = requiredById<HTMLInputElement>(root, "auto-wake")
  const autoWakeSetting = requiredById<HTMLElement>(root, "auto-wake-setting")
  const notice = requiredById<HTMLElement>(root, "control-notice")
  const inspector = requiredById<HTMLDialogElement>(root, "node-inspector")
  const closeInspector = requiredById<HTMLButtonElement>(root, "node-inspector-close")
  const controlsTab = requiredById<HTMLButtonElement>(root, "system-controls-tab")
  const architectureTab = requiredById<HTMLButtonElement>(root, "system-architecture-tab")
  const settingsTab = requiredById<HTMLButtonElement>(root, "system-settings-tab")
  const controlsView = requiredById<HTMLElement>(root, "system-controls-view")
  const architectureView = requiredById<HTMLElement>(root, "system-architecture-view")
  const settingsView = requiredById<HTMLElement>(root, "system-settings-view")
  const sections = [
    { tab: controlsTab, panel: controlsView },
    { tab: architectureTab, panel: architectureView },
    { tab: settingsTab, panel: settingsView },
  ]
  const edges = requiredById(root, "map-edges")
  const channelToggles = [...root.querySelectorAll<HTMLButtonElement>("[data-map-channel]")]
  const preferences = readPreferences(root.ownerDocument, "controls")
  const hiddenChannels = new Set((preferences.hidden ?? "").split(",").filter((channel) => ["request", "response", "control"].includes(channel)))
  const transportHeading = requiredById(root, "map-boundary-tunnel")
  const transportOutline = root.querySelector<SVGRectElement>('[data-map-group="tunnel"]')!
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-node-id]")]
  const setText = (id: string, value: string) => {
    const element = requiredById(root, id)
    if (element.textContent !== value) element.textContent = value
  }
  const setBadge = (id: string, label: string, tone: string) => {
    setText(id, label)
    requiredById(root, id).className = `status-pill ${tone}`
  }
  const setTime = (id: string, value: string | null | undefined, empty: string) => {
    const element = requiredById<HTMLTimeElement>(root, id)
    setText(id, value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : empty)
    if (value) {
      element.dateTime = value
      element.title = new Date(value).toLocaleString()
    } else {
      element.removeAttribute("datetime")
      element.removeAttribute("title")
    }
  }
  let system: SystemStatus | null = null
  let stale = true
  let receivedAt = 0
  let loading = true
  let pending = false
  let message = ""
  let selected: NodeID | null = null
  let inspected: NodeID | null = null
  let edgeSignature = ""
  let destroyed = false
  const components = mountComponentTable(root, (id, action) => void actionRequest(id, action), (id) => {
    inspected = id
    renderInspector(system?.topology?.nodes.find((node) => node.id === id))
    if (!inspector.open) inspector.showModal()
  })

  function renderInspector(node: TopologyNode | undefined) {
    setText("node-inspector-title", node?.label ?? "Waiting for component contracts")
    setText("node-inspector-description", controlComponents.find((component) => component.id === inspected)?.description ?? "")
    requiredById(root, "node-inspector-status").innerHTML = node ? `${stale || observationStale(node, system!.collected_at) ? `${dataValue("Stale observation")} ` : ""}${dataValue(`State: ${node.lifecycle.replaceAll("_", " ")}`)} ${dataValue(`Readiness: ${node.readiness.replaceAll("_", " ")}`)}` : "An updated supervisor publishes the complete topology and supported actions."
    setText("node-inspector-detail", node?.detail ?? "No component state or connectivity will be invented while the supervisor is unavailable.")
    const meta = requiredById(root, "node-inspector-meta")
    const boundary = node?.id === "tunnel" ? transportBoundary(node) : mapBoundaries.find((item) => inspected && item.members.includes(inspected))
    const boundaryLabel = boundary ? `${boundary.label} · ${boundary.title}` : "HOST · Remote machine (not a process)"
    meta.innerHTML = node ? `<dt>Boundary</dt><dd>${escape(boundaryLabel)}</dd><dt>Owner</dt><dd>${escape(node.owner.replaceAll("_", " "))}</dd><dt>Desired state</dt><dd>${escape(node.desired)}</dd><dt>Last checked</dt><dd>${escape(node.checked_at ? new Date(node.checked_at).toLocaleTimeString() : "Not independently checked")}</dd>` : ""
    const connections = requiredById(root, "node-connections")
    const related = system?.topology?.edges.filter((edge) => edge.source === inspected || edge.target === inspected) ?? []
    const componentLabel = (id: string) => system?.topology?.nodes.find((item) => item.id === id)?.label ?? readableLabel(id)
    connections.innerHTML = related.length ? `<h4>Connections</h4><ul class="connection-list">${related.map((edge) => `<li class="connection-card"><div class="connection-heading"><strong>${escape(componentLabel(edge.source))} → ${escape(componentLabel(edge.target))}</strong><span class="status-pill ${stale ? "neutral" : statusTone(edge.state)}">${stale ? "Stale" : escape(readableLabel(edge.state))}</span></div><p>${edgeChannel(edge) === "request" ? "Model request flow" : "Checks / recovery / management"}</p><p class="connection-protocol">${escape(edge.protocol)}</p></li>`).join("")}</ul>` : ""
  }

  function render() {
    if (destroyed) return
    const topology = system?.topology
    const transport = transportBoundary(topology?.nodes.find((node) => node.id === "tunnel"))
    for (const element of [transportOutline, transportHeading]) {
      element.classList.remove("map-process", "map-path", "map-transport")
      element.classList.add(`map-${transport.kind}`)
      element.setAttribute("data-boundary-kind", transport.kind)
    }
    transportHeading.setAttribute("aria-label", `${transport.label} · ${transport.title}`)
    transportHeading.querySelector("[data-boundary-label]")!.textContent = transport.label
    transportHeading.querySelector("[data-boundary-title]")!.textContent = transport.title
    setText("map-boundary-tunnel-description", `${transport.label} · ${transport.title}. ${transport.detail}`)
    const unavailable = stale || pending || !system?.managed
    const disabled = unavailable || Boolean(system?.recovery.busy) || topology?.run?.status === "running"
    const stopped = topology?.intent.system === "stopped"
    const remoteStopped = topology?.intent.remote === "stopped"
    const canShutdown = !unavailable && !shutdownInProgress(system)
    const canWake = supportsRemote(system, "host.wake")
    const canStop = supportsRemote(system, "host.stop")
    startSystem.disabled = disabled || !topology
    stopSystem.disabled = !canShutdown || !topology || Boolean(topology.shutdown_blockers.length)
    stopSystem.title = topology?.shutdown_blockers.length ? `Configure stop_command for: ${topology.shutdown_blockers.join(", ")}` : "Stop managed applications and, when supported, the remote host. Recovery is cancelled first; the dashboard and supervisor stay running."
    autoReconnect.disabled = disabled || Boolean(stopped || remoteStopped)
    autoWakeSetting.hidden = !canWake
    autoWake.disabled = disabled || !canWake || Boolean(stopped || remoteStopped)
    if (!pending) {
      autoReconnect.checked = system?.settings.auto_reconnect ?? false
      autoWake.checked = system?.settings.auto_wake ?? false
    }
    const availability = requiredById<HTMLElement>(root, "settings-availability")
    const settingsReason = loading ? "Loading supervisor status…" : stale ? "Settings are unavailable until fresh supervisor status is available." : !system?.managed ? "Settings require a managed supervisor." : pending ? "Saving or submitting an operation…" : disabled ? "Settings are unavailable while a recovery operation is running." : stopped || remoteStopped ? "Explicitly resume the stopped system or wake the remote host in Controls before changing recovery settings." : ""
    availability.hidden = !settingsReason
    availability.textContent = settingsReason

    setBadge("architecture-data-state", loading ? "Loading status…" : !system ? "Waiting for status…" : stale ? "Last known values · stale" : "Live supervisor data", stale || loading ? "neutral" : "good")
    if (system) {
      const connection = connectionState(system)
      const badge = requiredById(root, "control-connection")
      const shutdownActive = shutdownInProgress(system)
      const shutdownLabel = shutdownActive ? "Shutting down"
        : canStop && system.remote.host_state !== "stopped" ? "Shutdown unconfirmed"
          : stopped ? "System stopped" : "Remote host stopped"
      badge.textContent = stale ? "Stale"
        : stopped || remoteStopped ? shutdownLabel
          : system.recovery.busy ? "Recovering"
            : connection === "connected" ? "Relay connected"
              : connection === "remote_stopped" ? "Remote host stopped"
                : connection === "no_internet" ? "Waiting for network" : "Connection unavailable"
      badge.className = `status-pill ${!stale && !stopped && connection === "connected" ? "good" : "neutral"}`
      const run = topology?.run
      const current = topology?.nodes.find((node) => node.id === run?.current_component)
      setText("recovery-status", shutdownStatus(system) ?? (run?.status === "running" && current ? `${current.label}: ${run.current_action}…` : recoveryStatus(system)))
      setText("network-changes", topology ? topology.network.generation.toLocaleString() : "Unavailable")
      setTime("network-changed-at", topology?.network.changed_at, topology ? "None observed" : "Unavailable")
      setBadge("recovery-mode", system.settings.auto_reconnect ? "Enabled" : "Paused", stale ? "neutral" : system.settings.auto_reconnect ? "good" : "neutral")
      setText("recovery-attempts", system.recovery.attempts.toLocaleString())
      setTime("recovery-next-retry", system.recovery.next_retry_at, "Not scheduled")
      setTime("recovery-last-connected", system.recovery.last_connected_at, "Not yet connected")
      const remoteShutdown = !canStop ? "Manage separately"
        : !(stopped || remoteStopped) ? "Also stops"
          : system.remote.host_state === "stopped" ? "Confirmed stopped"
            : shutdownActive ? "Confirming stop" : "Unconfirmed"
      setText("shutdown-remote", remoteShutdown)
      setBadge("shutdown-readiness", !topology ? "Unavailable" : topology.shutdown_blockers.length ? "Configuration needed" : "Configured", stale || !topology ? "neutral" : topology.shutdown_blockers.length ? "warning" : "good")
      const blockers = requiredById<HTMLElement>(root, "shutdown-blockers")
      blockers.hidden = !topology?.shutdown_blockers.length
      setText("shutdown-blockers", topology?.shutdown_blockers.length ? `Configure stop_command for: ${topology.shutdown_blockers.join(", ")}. No services will be stopped until these commands are configured.` : "")
    }

    components.update(system, stale, disabled, canShutdown)
    for (const button of buttons) {
      if (button.dataset.nodeId === "remote") {
        const icon = button.querySelector<HTMLElement>("[data-node-icon]")!
        const name = remoteHostIcon(system?.remote)
        if (icon.dataset.icon !== name) { icon.innerHTML = iconMarkup(name, 22); icon.dataset.icon = name }
      }
      const node = topology?.nodes.find((item) => item.id === button.dataset.nodeId)
      button.setAttribute("aria-pressed", String(button.dataset.nodeId === selected))
      const label = button.querySelector<HTMLElement>("[data-node-label]")!
      if (node && label.textContent !== node.label) label.textContent = node.label
      if (button.dataset.nodeId === "tunnel") {
        if (!node) label.textContent = transport.title
        button.querySelector(".map-node-role")!.textContent = transport.kind === "process" ? "Process" : transport.kind === "path" ? "Path" : "Transport"
      }
      button.setAttribute("aria-label", `${label.textContent} (${button.querySelector(".map-node-role")?.textContent}). Highlight connections.`)
    }
    const nextEdges = JSON.stringify([topology?.edges.map(({ id, source, target, relation, protocol }) => ({ id, source, target, relation, protocol })), selected, [...hiddenChannels].sort()])
    if (nextEdges !== edgeSignature) {
      edgeSignature = nextEdges
      edges.replaceChildren()
      for (const edge of topology?.edges ?? []) {
        const related = selected !== null && [edge.source, edge.target].includes(selected)
        const channel = edgeChannel(edge)
        // Storage is a side effect of request handling, not a response hop back to Desktop.
        const channels = channel === "request" && edge.id !== "relay_storage" ? [channel, "response"] : [channel]
        for (const lane of channels) {
          if (hiddenChannels.has(lane)) continue
          const path = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path")
          path.setAttribute("d", lane === "response" ? responsePath(edge.source, edge.target) : edgePath(edge.source, edge.target))
          path.setAttribute("data-edge-id", lane === "response" ? `${edge.id}_response` : edge.id)
          path.setAttribute("class", `map-edge ${lane} ${edge.relation}${related ? " selected" : ""}`)
          path.setAttribute("marker-end", "url(#map-arrow)")
          const title = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "title")
          title.textContent = lane === "response" ? `Response / stream · ${edge.target} → ${edge.source}: ${edge.protocol}` : `${channel === "request" ? "Model request flow" : "Checks / recovery / management"} · ${edge.source} → ${edge.target}: ${edge.protocol}`
          path.append(title)
          edges.append(path)
        }
      }
    }
    const selectedNode = topology?.nodes.find((node) => node.id === selected)
    requiredById(root, "map-selection").innerHTML = selected
      ? `${escape(selectedNode?.label ?? readableLabel(selected))} · ${dataValue(`${edges.querySelectorAll(".selected").length} visible arrows highlighted`)}`
      : "No component selected"
    if (inspected) renderInspector(topology?.nodes.find((node) => node.id === inspected))
    const text = message || (loading ? "" : stale ? "System status is stale. Lifecycle actions are disabled until fresh status is available." : !topology ? "The supervisor needs the topology update before map controls are available. No running services were changed." : "")
    notice.hidden = !text
    if (notice.textContent !== text) notice.textContent = text
  }

  async function actionRequest(component: string, action: ComponentAction) {
    if (destroyed || !system || stale || pending || !system.managed || !system.topology) return
    const stopping = action === "stop" && (component === "all" || component === "remote")
    if ((system.recovery.busy || system.topology.run?.status === "running") && (!stopping || shutdownInProgress(system))) return
    if (component !== "all") {
      const node = system.topology.nodes.find((node) => node.id === component)
      const remotePaused = system.topology.intent.remote === "stopped" && ["tunnel", "relay"].includes(component) && action !== "stop"
      const stoppedIntent = (system.topology.intent.system === "stopped" || remotePaused) && action !== "open"
        && !(component === "remote" && action === "stop")
      if (!node?.actions.includes(action) || stoppedIntent || action === "start" && ["running", "starting", "started"].includes(node.lifecycle)) return
      if (component === "remote" && (action === "stop" || action === "wake") && !supportsRemote(system, action === "stop" ? "host.stop" : "host.wake")) return
    }
    const systemAction = component === "all"
    const needsConfirmation = ["restart", "stop", "wake"].includes(action) || systemAction && action === "start"
    if (needsConfirmation) {
      const explanation = systemAction && action === "start" ? `Start missing configured local applications, recover the connection and enable automatic recovery?${supportsRemote(system, "host.wake") ? " The existing remote host may be woken and compute billing may resume. Automatic wake permission is not enabled." : " The remote host must already be running; this provider does not support waking it."}` : systemAction && action === "stop" ? `Cancel active recovery, disable automatic reconnect and wake, and shut down the managed local applications${supportsRemote(system, "host.stop") ? " and remote host" : " (remote power-off is unsupported; the remote host stays running)"}? The dashboard and supervisor stay running. This computer stays on.${supportsRemote(system, "host.stop") ? " Remote shutdown is only confirmed after the hosting provider reports the host stopped; compute charges may continue until then." : ""}` : component === "remote" && action === "stop" ? "Shut down the remote host? Active requests will be interrupted. Automatic reconnect and wake will be disabled until explicitly resumed. Compute charges may continue until the hosting provider confirms the host stopped." : action === "wake" ? "Wake the existing remote host and recover its connection? Compute billing may resume. This does not enable automatic wake." : `Restart ${system.topology.nodes.find((node) => node.id === component)?.label ?? component}? Active requests may be interrupted and provider work may already be billed.`
      if (!window.confirm(`${explanation} Saved files, tokens, cache, sessions and responses are preserved.`)) return
    }
    pending = true
    message = "Submitting operation…"
    render()
    try {
      const requestID = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      await sendControl("action", { component, action, confirmed: needsConfirmation, request_id: requestID }, system.csrf_token)
      message = action === "open" ? "Open request sent. The supervisor does not observe the editor window; no model request was submitted." : "Operation accepted. Current status is shown in Controls; no model generation was submitted."
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
    if (destroyed || !system || stale || pending || !system.managed || system.recovery.busy || system.topology?.run?.status === "running" || system.topology?.intent.system === "stopped" || system.topology?.intent.remote === "stopped") return
    const reconnect = autoReconnect.checked
    const wake = supportsRemote(system, "host.wake") && autoWake.checked
    if (wake && !system.settings.auto_wake && !window.confirm("Allow automatic wake of the existing remote host, even with this page closed? Compute billing may resume.")) { render(); return }
    pending = true
    render()
    try {
      await sendControl("settings", { auto_reconnect: reconnect, auto_wake: wake }, system.csrf_token)
      message = "Automatic recovery settings saved. Intentional shutdown remains in force until Start / recover system or an explicit wake."
    } catch (error) {
      message = error instanceof Error ? error.message : "Settings could not be saved."
    } finally { pending = false; onRefresh(); render() }
  }

  function selectView(index: number) {
    inspector.close()
    sections.forEach(({ tab, panel }, position) => {
      panel.hidden = position !== index
      tab.setAttribute("aria-selected", String(position === index))
      tab.tabIndex = position === index ? 0 : -1
    })
    if (index === 1) navigation.reveal()
    savePreferences(root.ownerDocument, "controls", { tab: String(index) })
  }
  function tabKey(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const current = sections.findIndex(({ tab }) => tab === event.currentTarget)
    const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length
    selectView(next)
    sections[next]!.tab.focus()
  }
  for (const button of buttons) button.addEventListener("click", () => { selected = selected === button.dataset.nodeId ? null : button.dataset.nodeId as NodeID; render() })
  const viewport = root.querySelector<HTMLElement>(".topology-viewport")!
  viewport.addEventListener("click", (event) => {
    if ((event.target as Element).closest("[data-node-id]")) return
    if (selected) { selected = null; render() }
  })
  architectureView.addEventListener("keydown", (event) => { if (event.key === "Escape") { selected = null; render() } })
  sections.forEach(({ tab }, index) => {
    tab.addEventListener("click", () => selectView(index))
    tab.addEventListener("keydown", tabKey)
  })
  closeInspector.addEventListener("click", () => inspector.close())
  inspector.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); inspector.close() } })
  function renderChannelToggle(toggle: HTMLButtonElement) {
    const channel = toggle.dataset.mapChannel!
    const shown = !hiddenChannels.has(channel)
    toggle.setAttribute("aria-pressed", String(shown))
    toggle.querySelector(".legend-toggle-state")!.textContent = shown ? "Shown" : "Hidden"
    toggle.title = `${shown ? "Hide" : "Show"} ${channel === "request" ? "model request" : channel === "response" ? "model response" : "checks, recovery and management"} arrows`
  }
  for (const toggle of channelToggles) {
    renderChannelToggle(toggle)
    toggle.addEventListener("click", () => {
      const channel = toggle.dataset.mapChannel!
      if (hiddenChannels.has(channel)) hiddenChannels.delete(channel)
      else hiddenChannels.add(channel)
      savePreferences(root.ownerDocument, "controls", { hidden: [...hiddenChannels].sort().join(",") })
      renderChannelToggle(toggle)
      render()
    })
  }
  const savedTab = Number(preferences.tab)
  selectView(Number.isInteger(savedTab) && savedTab >= 0 && savedTab < sections.length ? savedTab : 0)
  startSystem.addEventListener("click", () => void actionRequest("all", "start"))
  stopSystem.addEventListener("click", () => void actionRequest("all", "stop"))
  autoReconnect.addEventListener("change", () => void settings())
  autoWake.addEventListener("change", () => void settings())

  return {
    update(status, nextStale, nextReceivedAt, nextLoading = false) { if (status) system = status; stale = nextStale; receivedAt = nextReceivedAt ?? receivedAt; loading = nextLoading; render() },
    destroy() { destroyed = true; navigation.destroy(); components.destroy(); inspector.close() },
  }
}
