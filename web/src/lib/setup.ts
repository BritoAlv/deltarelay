import { object } from "./validation.js"

export interface SetupTarget {
  provider: "ssh" | "codespaces"
  target: string
  remote_directory: string
  ssh_port: number
  remote_port: number
}

export interface SetupStatus {
  version: 1
  available: boolean
  required: boolean
  busy: boolean
  last_error: string
  target: SetupTarget | null
}

export function isSetupStatus(value: unknown): value is SetupStatus {
  if (!object(value) || value.version !== 1 || typeof value.available !== "boolean" || typeof value.required !== "boolean" || typeof value.busy !== "boolean" || typeof value.last_error !== "string" || !/^[a-z_]{0,80}$/.test(value.last_error) || value.available && !value.required) return false
  const target = value.target
  return target === null || object(target) && ["ssh", "codespaces"].includes(String(target.provider)) && typeof target.target === "string" && target.target.length > 0 && target.target.length <= 255 && typeof target.remote_directory === "string" && target.remote_directory.length <= 512 && /^(\/|~\/)/.test(target.remote_directory) && Number.isInteger(target.ssh_port) && Number(target.ssh_port) >= 1 && Number(target.ssh_port) <= 65535 && Number.isInteger(target.remote_port) && Number(target.remote_port) >= 1024 && Number(target.remote_port) <= 65535
}

export async function fetchSetup(signal: AbortSignal): Promise<SetupStatus> {
  const response = await fetch("/api/system/setup", { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  const value: unknown = await response.json()
  if (!response.ok || !isSetupStatus(value)) throw new Error("Remote setup status is unavailable. Run the updated startup.sh and refresh.")
  return value
}
