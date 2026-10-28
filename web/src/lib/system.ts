export interface AuthStatus {
  state: string
  expires_at?: string
  checked_at?: string
  stale: boolean
}

export interface SystemStatus {
  version: 1
  managed: boolean
  collected_at: string
  csrf_token: string
  error?: string
  settings: { auto_reconnect: boolean; auto_wake: boolean }
  recovery: { busy: boolean; phase: string; attempts: number; last_error: string; last_connected_at: string | null; next_retry_at: string | null }
  relay_state: string
  codespace_state: string
  components: { id: string; label: string; state: string; can_start: boolean; can_restart: boolean }[]
  auth: AuthStatus
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v))
const componentIDs = ["dashboard", "gateway", "tunnel", "relay", "opencode", "desktop"]

export function isSystemStatus(v: unknown): v is SystemStatus {
  if (!object(v) || v.version !== 1 || typeof v.managed !== "boolean" || !timestamp(v.collected_at) || typeof v.csrf_token !== "string" || !/^[a-f0-9]{64}$/.test(v.csrf_token)) return false
  if (!object(v.auth) || typeof v.auth.state !== "string" || typeof v.auth.stale !== "boolean" || v.auth.expires_at !== undefined && !timestamp(v.auth.expires_at) || v.auth.checked_at !== undefined && !timestamp(v.auth.checked_at)) return false
  if (!object(v.settings) || typeof v.settings.auto_reconnect !== "boolean" || typeof v.settings.auto_wake !== "boolean") return false
  if (!object(v.recovery) || typeof v.recovery.busy !== "boolean" || typeof v.recovery.phase !== "string" || typeof v.recovery.last_error !== "string" || typeof v.recovery.attempts !== "number" || !Number.isFinite(v.recovery.attempts) || v.recovery.attempts < 0 || v.recovery.next_retry_at !== null && !timestamp(v.recovery.next_retry_at) || v.recovery.last_connected_at !== null && !timestamp(v.recovery.last_connected_at)) return false
  return typeof v.relay_state === "string" && typeof v.codespace_state === "string" && Array.isArray(v.components) && v.components.length <= 6 && v.components.every((c) => object(c) && componentIDs.includes(String(c.id)) && typeof c.label === "string" && typeof c.state === "string" && typeof c.can_start === "boolean" && typeof c.can_restart === "boolean")
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
    supervisor_unavailable: "The local supervisor is unavailable. Run startup.sh to recover it; the gateway is not required for these controls.",
    codespace_stopped: "The Codespace is stopped. Use Wake Codespace, or enable automatic wake. Waking resumes GitHub billing.",
    operation_in_progress: "Another service operation is in progress. Wait for it to finish.",
    unrecognized_port_owner: "A required port has an unrecognized owner. No process was stopped or replaced.",
    identity_mismatch: "The remote relay identity changed. Automatic recovery is blocked; no state was reset.",
    identity_unavailable: "The saved relay identity is missing or invalid. Configure it before enabling recovery.",
    configuration_error: "Check the private relay configuration and token/state file permissions.",
    authentication_failed: "Relay authentication failed. Check the shared token; restarting will not repair credentials.",
    tls_verification_failed: "TLS verification failed. Repair the certificate; verification will not be bypassed.",
    protocol_mismatch: "The remote relay does not match the expected protocol. No automatic restart was attempted.",
    forwarding_disabled: "The remote relay has forwarding disabled. Check its upstream allowlist.",
    graphical_session_required: "Desktop needs a graphical session. Start the supervisor from your desktop terminal.",
    graceful_stop_timeout: "The service did not stop gracefully. No forced kill or state reset was performed.",
    unreachable: "The relay is unreachable. Check the network, VPN, tunnel, and remote host.",
  }
  return messages[code] ?? "The operation could not complete. Check the private supervisor/service logs."
}

export async function fetchSystem(signal: AbortSignal): Promise<SystemStatus> {
  const response = await fetch("/api/system", { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  const data: unknown = await response.json()
  if (!response.ok || !isSystemStatus(data)) throw new Error("System controls are unavailable or incompatible. Restart the updated dashboard.")
  return data
}

export async function sendControl(path: "action" | "settings", data: unknown, nonce: string): Promise<void> {
  const response = await fetch(`/api/system/${path}`, {
    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(6000),
    headers: { "Content-Type": "application/json", "X-DeltaRelay-Control": nonce }, body: JSON.stringify(data),
  })
  if (!response.ok) {
    const answer: unknown = await response.json().catch(() => null)
    throw new Error(controlError(object(answer) && typeof answer.error === "string" ? answer.error : ""))
  }
}
