import { readParams, replaceParams } from "./url-state.js"

export const preferencesStorageKey = "deltarelay.dashboard-preferences.v1"

// An allowlist prevents transient selections, credentials, payloads, and backend
// settings from accidentally becoming browser preferences.
const scopes = {
  host: ["host"],
  range: ["range", "last", "unit", "start", "end"],
  traffic: ["view"],
  sessions: ["q", "state", "rows", "sort", "dir", "sid", "req_min", "req_max", "orig_min", "orig_max", "up_min", "up_max", "red_min", "red_max", "act_from", "act_to"],
  measurement: ["q", "day", "show", "sort", "dir"],
  components: ["q", "sort", "dir", "component_contains", "type", "description_contains", "status", "lifecycle", "location"],
  controls: ["tab", "hidden"],
  rangeEditor: ["mode"],
  payload: ["wrap"],
  health: ["provider"],
  inspection: ["body", "inventory", "upload", "encoded"],
} as const

export type PreferenceScope = keyof typeof scopes
type Values = Record<string, string>
type Preferences = Partial<Record<PreferenceScope, Values>>

function storage(doc: Document): Storage | null {
  try { return doc.defaultView?.localStorage ?? null } catch { return null }
}

function read(doc: Document): Preferences {
  try {
    const value: unknown = JSON.parse(storage(doc)?.getItem(preferencesStorageKey) ?? "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const result: Preferences = {}
    for (const scope of Object.keys(scopes) as PreferenceScope[]) {
      const entry = (value as Record<string, unknown>)[scope]
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const clean: Values = {}
      for (const key of scopes[scope]) {
        const item = (entry as Record<string, unknown>)[key]
        if (typeof item === "string" && item.length <= 2048) clean[key] = item
      }
      result[scope] = clean
    }
    return result
  } catch { return {} }
}

export function readPreferences(doc: Document, scope: PreferenceScope): Values {
  return read(doc)[scope] ?? {}
}

export function savePreferences(doc: Document, scope: PreferenceScope, values: Record<string, string | null>): boolean {
  try {
    const target = storage(doc)
    if (!target) return false
    const saved = read(doc)
    const next = { ...saved[scope] }
    for (const key of scopes[scope]) {
      if (!Object.hasOwn(values, key)) continue
      const value = values[key]
      if (typeof value === "string" && value.length <= 2048) next[key] = value
      else delete next[key]
    }
    if (JSON.stringify(saved[scope] ?? {}) === JSON.stringify(next)) return true
    saved[scope] = next
    target.setItem(preferencesStorageKey, JSON.stringify(saved))
    return true
  } catch { return false }
}

// A link specifying this view is authoritative as a group: e.g. range=last
// must not inherit a different user's saved amount/unit. Record links likewise
// must not inherit filters that could hide the linked record.
export function readViewParams(doc: Document, scope: PreferenceScope): URLSearchParams {
  const params = readParams(doc)
  const keys: readonly string[] = scopes[scope]
  const recordLink = (scope === "sessions" || scope === "measurement" || scope === "host")
    && ["session", "request", "page"].some((key) => params.has(key))
  if (recordLink || keys.some((key) => params.has(key))) return params
  for (const [key, value] of Object.entries(readPreferences(doc, scope))) params.set(key, value)
  return params
}

export function replaceViewParams(doc: Document, scope: PreferenceScope, values: Record<string, string | null>): void {
  savePreferences(doc, scope, values)
  replaceParams(doc, values)
}
