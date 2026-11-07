import { counters, nullableTimestamp, object, optionalString, optionalTimestamp, timestamp } from "./validation.js"
import { isTopology, type TopologyStatus } from "./topology.js"

export interface AuthStatus {
  state: string
  expires_at?: string
  checked_at?: string
  stale: boolean
}

export interface SystemStatus {
  version: 2
  managed: boolean
  collected_at: string
  csrf_token: string
  error?: string
  settings: { auto_reconnect: boolean; auto_wake: boolean }
  recovery: { busy: boolean; phase: string; attempts: number; last_error: string; last_connected_at: string | null; next_retry_at: string | null }
  relay_state: string
  internet_state: string
  internet_checked_at: string | null
  remote: {
    id: string
    label: string
    host_state: "running" | "stopped" | "starting" | "stopping" | "unknown"
    capabilities: RemoteCapability[]
  }
  components: { id: string; label: string; state: string; can_start: boolean; can_restart: boolean }[]
  auth: AuthStatus
  topology?: TopologyStatus
}

const componentIDs = ["dashboard", "gateway", "tunnel", "relay", "opencode", "desktop"]
export type RemoteCapability = "relay.ensure" | "relay.restart" | "host.wake" | "host.stop"
const remoteCapabilities = ["relay.ensure", "relay.restart", "host.wake", "host.stop"]

export function supportsRemote(system: SystemStatus | null, capability: RemoteCapability): boolean {
  return Boolean(system?.remote.capabilities.includes(capability))
}

export function isSystemStatus(v: unknown): v is SystemStatus {
  if (!object(v) || v.version !== 2 || typeof v.managed !== "boolean" || !timestamp(v.collected_at) || typeof v.csrf_token !== "string" || !/^[a-f0-9]{64}$/.test(v.csrf_token) || !optionalString(v.error)) return false
  if (typeof v.internet_state !== "string" || !nullableTimestamp(v.internet_checked_at)) return false
  if (!object(v.auth) || typeof v.auth.state !== "string" || typeof v.auth.stale !== "boolean" || !optionalTimestamp(v.auth.expires_at) || !optionalTimestamp(v.auth.checked_at)) return false
  if (!object(v.settings) || typeof v.settings.auto_reconnect !== "boolean" || typeof v.settings.auto_wake !== "boolean") return false
  if (v.topology !== undefined && !isTopology(v.topology)) return false
  if (!object(v.recovery) || typeof v.recovery.busy !== "boolean" || typeof v.recovery.phase !== "string" || typeof v.recovery.last_error !== "string" || !counters(v.recovery, ["attempts"]) || !nullableTimestamp(v.recovery.next_retry_at) || !nullableTimestamp(v.recovery.last_connected_at)) return false
  const remote = v.remote
  if (!object(remote) || typeof remote.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(remote.id) || typeof remote.label !== "string" || !remote.label.length || [...remote.label].length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(remote.label)) return false
  if (typeof remote.host_state !== "string" || !["running", "stopped", "starting", "stopping", "unknown"].includes(remote.host_state) || !Array.isArray(remote.capabilities) || remote.capabilities.length > 4 || new Set(remote.capabilities).size !== remote.capabilities.length || !remote.capabilities.every((c) => typeof c === "string" && remoteCapabilities.includes(c))) return false
  return typeof v.relay_state === "string" && Array.isArray(v.components) && v.components.length <= 6 && v.components.every((c) => object(c) && typeof c.id === "string" && componentIDs.includes(c.id) && typeof c.label === "string" && typeof c.state === "string" && typeof c.can_start === "boolean" && typeof c.can_restart === "boolean")
}

export type ConnectionState = "connected" | "remote_stopped" | "no_internet" | "vps_unreachable" | "unknown"

export function connectionState(system: SystemStatus): ConnectionState {
  if (system.relay_state === "connected") return "connected"
  if (system.relay_state === "unreachable" && system.remote.host_state === "stopped" && !system.settings.auto_reconnect && !system.settings.auto_wake) return "remote_stopped"
  // Only claim "no internet" when the independent external check also failed.
  // An unavailable supervisor leaves internet_state unknown.
  if (system.relay_state === "unreachable" && system.internet_state === "unreachable") return "no_internet"
  if (system.relay_state === "unreachable" && system.internet_state === "connected") return "vps_unreachable"
  return "unknown"
}

export function recoveryStatus(system: SystemStatus): string {
  if (system.error) return controlError(system.error)
  if (system.recovery.busy) {
    const details: Record<string, string> = {
      waking_remote_host: "Waiting for the host to run; connecting and verifying the relay comes next.",
      waiting_for_remote_host: "The host is still starting. Relay connectivity is not confirmed yet.",
      connecting_tunnel: "Waiting for the tunnel and authenticated relay. A running host alone is not a working connection.",
      verifying_connection: "Checking authenticated relay health, even if remote SSH recovery timed out.",
    }
    const detail = details[system.recovery.phase]
    return `In progress: ${system.recovery.phase.replaceAll("_", " ")}${detail ? `. ${detail}` : ""}`
  }
  const connection = connectionState(system)
  if (connection === "remote_stopped") return `The remote host is stopped. Automatic reconnect and wake are off. ${supportsRemote(system, "host.wake") ? "Use Wake on the remote-host node to resume, then re-enable recovery settings as needed." : "Resume it through your hosting provider."}`
  const paused = !system.settings.auto_reconnect ? " Automatic recovery is off. Use Start system for a one-time repair, or enable Automatic recovery for background recovery." : ""
  if (connection === "no_internet") return controlError("no_internet") + paused
  const error = system.recovery.last_error
  if (error && error !== "unreachable") return controlError(error) + paused
  if (connection === "vps_unreachable") return "Internet works, but the VPS/relay did not respond. Check the tunnel, VPN split routes, relay process, or remote host." + paused
  if (error) return controlError(error) + paused
  if (connection === "connected") return system.settings.auto_reconnect ? "Authenticated relay is reachable. VPN changes are monitored in the background." : "Authenticated relay is reachable. Automatic recovery is off; a dropped connection will not be repaired automatically."
  return "Monitoring relay connectivity." + paused
}

export function desktopLaunchState(system: SystemStatus | null, stale = false, pending = false): { disabled: boolean; detail: string } {
  if (!system || stale) return { disabled: true, detail: "Waiting for fresh local supervisor status before launching Desktop." }
  if (!system.managed) return { disabled: true, detail: controlError(system.error ?? "controls_not_configured") }
  const desktop = system.components.find((component) => component.id === "desktop")
  if (!desktop?.can_start) return { disabled: true, detail: "Configure the isolated Desktop launcher in your private supervisor configuration to enable this button." }
  if (pending || system.recovery.busy) return { disabled: true, detail: "A service operation is in progress. Wait for it to finish before launching Desktop." }
  if (desktop.state === "running") return { disabled: true, detail: "The isolated OpenCode Desktop instance is already running. No second instance will be launched." }
  if (desktop.state === "starting" || desktop.state === "started") return { disabled: true, detail: "OpenCode Desktop is starting. Its window may take a moment to appear." }
  return { disabled: false, detail: "Launch the configured isolated OpenCode Desktop on this computer without restarting other services." }
}

export function countdown(deadline: string, now = Date.now()): string {
  const remaining = Date.parse(deadline) - now
  if (!Number.isFinite(remaining)) return "Unknown"
  if (remaining <= 0) return "Expired · awaiting refresh"
  const seconds = Math.ceil(remaining / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  if (days) return `${days}d ${hours}h ${minutes}m`
  if (hours) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds % 60}s`
}

export function controlError(code: string): string {
  const messages: Record<string, string> = {
    controls_not_configured: "Controls are not configured. Start with startup.sh, or configure a private supervisor socket.",
    setup_required: "Set up your remote host using the setup form on System controls. Recovery never initializes a new relay store.",
    setup_not_available: "First-time setup is not available for this configured deployment. Existing credentials and relay data were not changed.",
    invalid_setup_request: "Check the host, remote directory, and port numbers. Use an SSH alias/user@host or an existing Codespace name.",
    setup_target_locked: "An interrupted setup already selected a destination. Resume that same destination; no credentials or identity will be replaced.",
    setup_configuration_changed: "Private configuration changed during setup. Your changes were preserved. Review the system map and the configuration before resuming.",
    identity_already_configured: "A saved relay identity already exists. Use its existing deployment configuration; setup will not overwrite the pin.",
    unsupported_remote_platform: "Remote setup requires Linux amd64 or arm64 and Python 3.",
    setup_go_required: "Go is required locally to build the remote relay. Install Go, then resume setup.",
    setup_failed: "Remote setup failed. Check the map and setup error, fix it, then resume the same setup.",
    supervisor_unavailable: "The local supervisor is unavailable. Run startup.sh to recover it; the gateway is not required for these controls.",
    host_stopped: "The remote host is stopped. Wake it manually, or enable automatic wake if supported. Compute billing may resume.",
    host_unavailable: "The remote host could not be confirmed ready. Check your hosting provider and network connection.",
    host_stop_timeout: "Remote shutdown was not confirmed before the timeout. Automatic reconnect and wake remain off. Check your hosting provider before retrying.",
    relay_ssh_timeout: "Remote SSH relay recovery timed out. A running machine does not confirm SSH or relay health. Check the deployment, VPN, and tunnel.",
    relay_recovery_failed: "Remote SSH/relay recovery failed. Check the existing deployment, VPN, and tunnel; no state was reset.",
    provider_timeout: "The remote-host plugin timed out. Check its private configuration and dependencies.",
    provider_failed: "The remote-host plugin could not run successfully. Check its executable and private configuration.",
    invalid_provider_response: "The remote-host plugin returned an invalid response. Automatic recovery is blocked.",
    provider_version_mismatch: "The remote-host plugin contract version is incompatible. Automatic recovery is blocked.",
    unsupported_operation: "This remote-host provider does not support that operation.",
    command_failed: "A configured service command failed. Check the private supervisor/service logs.",
    command_timeout: "A configured service command timed out. Check the private supervisor/service logs.",
    operation_cancelled: "Recovery stopped because the supervisor is shutting down. Existing services and saved state were left intact.",
    operation_in_progress: "Another service operation is in progress. Wait for it to finish.",
    shutdown_not_configured: "System shutdown needs an explicit stop command for every managed local service. Configure the missing lifecycle actions; no services were stopped.",
    component_not_ready: "The component did not pass its local readiness check before the deadline. Automatic retries are bounded; inspect its node on the map.",
    component_stop_unverified: "A stop command completed, but the service could not be independently confirmed stopped. Automatic recovery remains paused; inspect the component before retrying.",
    system_stopped: "The system is intentionally stopped. Use Start system to resume local services and automatic recovery. A VPS shutdown remains available when supported.",
    operation_interrupted: "The supervisor restarted during an operation. Its outcome is uncertain; current state will be checked before any further repair.",
    unrecognized_port_owner: "A required port has an unrecognized owner. No process was stopped or replaced.",
    identity_mismatch: "The remote relay identity changed. Automatic recovery is blocked; no state was reset.",
    identity_unavailable: "The saved relay identity is missing or invalid. Configure it before enabling recovery.",
    configuration_error: "Check the private relay configuration and token/state file permissions.",
    authentication_failed: "Relay authentication failed. Check the shared token; restarting will not repair credentials.",
    tls_verification_failed: "TLS verification failed. Repair the certificate; verification will not be bypassed.",
    protocol_mismatch: "The remote relay API/protocol is incompatible. Deploy matching relay, gateway, OpenCode plugin, and dashboard revisions. No automatic restart was attempted.",
    forwarding_disabled: "The remote relay has forwarding disabled. Check its upstream allowlist.",
    graphical_session_required: "Desktop needs a graphical session. Start the supervisor from your desktop terminal.",
    graceful_stop_timeout: "The service did not stop gracefully. No forced kill or state reset was performed.",
    unreachable: "The relay is unreachable. Check the network, VPN, tunnel, and remote host.",
    no_internet: "This computer has no internet connection. Check Wi-Fi, Ethernet, VPN, or the default route.",
  }
  return messages[code] ?? "The operation could not complete. Check the private supervisor/service logs."
}

export async function fetchSystem(signal: AbortSignal): Promise<SystemStatus> {
  const response = await fetch("/api/system", { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  const data: unknown = await response.json()
  if (!response.ok || !isSystemStatus(data)) throw new Error("System controls are unavailable or incompatible. Restart the updated dashboard.")
  return data
}

export async function sendControl(path: "action" | "settings" | "setup", data: unknown, nonce: string): Promise<void> {
  const response = await fetch(`/api/system/${path}`, {
    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(6000),
    headers: { "Content-Type": "application/json", "X-DeltaRelay-Control": nonce }, body: JSON.stringify(data),
  })
  if (!response.ok) {
    const answer: unknown = await response.json().catch(() => null)
    throw new Error(controlError(object(answer) && typeof answer.error === "string" ? answer.error : ""))
  }
}
