import { mergeSessions, savings, sessionHost, sessionState } from "./metrics.js"
import type { OpenCodeSessions, Session, Snapshot } from "./types.js"

export interface CatalogSession {
  id: string
  title: string
  created_at: string
  updated_at: string
  project: string
  agent: string
  model: string
  hosts: string[]
  gateway?: Session
}

export interface CatalogDay {
  key: string
  label: string
  count: number
  measured: number
}

export type CatalogAvailability = "all" | "measured"

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function validTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function sessionDayKey(value: string): string {
  const parsed = validTime(value)
  if (!parsed) return ""
  const date = new Date(parsed)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function sessionDayLabel(value: string): string {
  const parsed = validTime(value)
  if (!parsed) return "Unknown day"
  const date = new Date(parsed)
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

export function catalogSessions(snapshot: Snapshot | null, catalog: OpenCodeSessions | null, host = ""): CatalogSession[] {
  const gateway = new Map<string, Session[]>()
  for (const session of snapshot?.history.sessions ?? []) {
    const matches = gateway.get(session.id) ?? []
    matches.push(session)
    gateway.set(session.id, matches)
  }
  const measured = (id: string): Session[] => (gateway.get(id) ?? []).filter((session) => !host || sessionHost(session) === host)
  const seen = new Set<string>()
  const entries: CatalogSession[] = []
  for (const session of catalog?.sessions ?? []) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    const matching = measured(session.id)
    const merged = matching.length ? mergeSessions(matching)[0] : undefined
    entries.push({
      id: session.id,
      title: session.title?.trim() ?? "",
      created_at: merged?.started_at ?? session.created_at,
      updated_at: merged?.updated_at ?? session.updated_at,
      project: session.project?.trim() ?? "",
      agent: session.agent?.trim() ?? "",
      model: session.model?.trim() ?? "",
      hosts: merged?.hosts ?? [],
      gateway: merged,
    })
  }
  for (const [id, sessions] of gateway) {
    if (seen.has(id)) continue
    const matching = host ? sessions.filter((session) => sessionHost(session) === host) : sessions
    if (!matching.length) continue
    seen.add(id)
    const merged = mergeSessions(matching)[0]!
    entries.push({
      id,
      title: "",
      created_at: merged.started_at,
      updated_at: merged.updated_at,
      project: "",
      agent: "",
      model: "",
      hosts: merged.hosts,
      gateway: merged,
    })
  }
  return entries.sort((a, b) => validTime(b.updated_at) - validTime(a.updated_at) || validTime(b.created_at) - validTime(a.created_at))
}

export function catalogDays(entries: CatalogSession[]): CatalogDay[] {
  const days = new Map<string, CatalogDay>()
  for (const entry of entries) {
    const key = sessionDayKey(entry.created_at)
    if (!key) continue
    const day = days.get(key) ?? { key, label: sessionDayLabel(entry.created_at), count: 0, measured: 0 }
    day.count++
    if (entry.gateway) day.measured++
    days.set(key, day)
  }
  return [...days.values()].sort((a, b) => b.key.localeCompare(a.key))
}

export function filterCatalogSessions(entries: CatalogSession[], query: string, day: string, availability: CatalogAvailability, host = ""): CatalogSession[] {
  const text = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (day && sessionDayKey(entry.created_at) !== day) return false
    if (host && !entry.gateway) return false
    if (availability === "measured" && !entry.gateway) return false
    if (!text) return true
    return `${entry.title} ${entry.id} ${entry.project} ${entry.agent} ${entry.model} ${entry.hosts.join(" ")} ${entry.gateway?.upstream ?? ""} ${entry.gateway?.id ?? ""}`
      .toLowerCase()
      .includes(text)
  })
}

export function catalogEntry(entries: CatalogSession[], id: string | null): CatalogSession | undefined {
  if (id === null) return undefined
  return entries.find((entry) => entry.id === id)
}

export function catalogReduction(entry: CatalogSession): number | null {
  return entry.gateway ? savings(entry.gateway.body_bytes, entry.gateway.encoded_upload_bytes) : null
}

export function catalogState(entry: CatalogSession): "active" | "attention" | "idle" | "unmeasured" {
  return entry.gateway ? sessionState(entry.gateway) : "unmeasured"
}
