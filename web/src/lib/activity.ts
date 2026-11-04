import { object, timestamp } from "./validation.js"

export interface ActivityEntry {
  seq: number
  time: string
  component: string
  trigger: "startup" | "manual" | "monitor" | "automatic" | "service"
  operation: string
  execution: string
  stream: "event" | "command" | "stdout" | "stderr" | "output" | "exit" | "error"
  text: string
}

export interface ActivityPage {
  version: 1
  entries: ActivityEntry[]
  oldest: number
  newest: number
  reset: boolean
  storage_error: boolean
}

const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0

export function isActivityPage(v: unknown): v is ActivityPage {
  if (!object(v) || v.version !== 1 || !integer(v.oldest) || !integer(v.newest) || v.newest < v.oldest || typeof v.reset !== "boolean" || typeof v.storage_error !== "boolean" || !Array.isArray(v.entries) || v.entries.length > 100) return false
  let previous = 0
  return v.entries.every((entry: unknown) => {
    if (!object(entry) || !integer(entry.seq) || entry.seq <= previous || entry.seq < (v.oldest as number) || entry.seq > (v.newest as number) || !timestamp(entry.time)) return false
    if (typeof entry.component !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.component) || typeof entry.operation !== "string" || !/^(?:[a-f0-9]{16})?$/.test(entry.operation) || typeof entry.execution !== "string" || !/^(?:[a-f0-9]{8})?$/.test(entry.execution)) return false
    if (typeof entry.trigger !== "string" || !["startup", "manual", "monitor", "automatic", "service"].includes(entry.trigger) || typeof entry.stream !== "string" || !["event", "command", "stdout", "stderr", "output", "exit", "error"].includes(entry.stream) || typeof entry.text !== "string" || [...entry.text].length > 4096) return false
    previous = entry.seq
    return true
  })
}

export async function fetchActivity(signal: AbortSignal, cursor?: { after: number } | { before: number }): Promise<ActivityPage> {
  const query = cursor ? `?${"after" in cursor ? `after=${cursor.after}` : `before=${cursor.before}`}` : ""
  const response = await fetch(`/api/system/journal${query}`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = object(data) && typeof data.error === "string" ? data.error : ""
    if (code === "supervisor_upgrade_required" || response.status === 404) throw new Error("Activity logging needs the updated dashboard and supervisor. Rebuild and restart them; existing services can remain running.")
    if (code === "controls_not_configured") throw new Error("Activity journal is not configured. Start the independent supervisor to record system activity.")
    throw new Error("Supervisor journal unavailable. Retained output stays on screen; reconnecting automatically.")
  }
  if (!isActivityPage(data)) throw new Error("Invalid supervisor journal response. Retained output stays on screen.")
  return data
}

export function activityLine(entry: ActivityEntry): string {
  const context = `${entry.trigger}${entry.operation ? `:${entry.operation}` : ""}${entry.execution ? `/${entry.execution}` : ""}`
  return `${entry.time} [${entry.component}] [${context}] [${entry.stream}] ${entry.text}`
}
