import { savings, type SessionView } from "./metrics.js"

// Per-column session filters are kept separate from the free-text search. The
// form keeps raw input strings so the popover can restore exactly what the user
// typed, while compiled criteria are cheap to apply on every render.
export interface SessionFilterInput {
  session: string
  requestsMin: string
  requestsMax: string
  originalMin: string
  originalMax: string
  uploadedMin: string
  uploadedMax: string
  reductionMin: string
  reductionMax: string
  activityFrom: string
  activityTo: string
}

export type SessionColumnFilterKey = "session" | "requests" | "original" | "uploaded" | "reduction" | "activity"

export interface NumericRange {
  min: number | null
  max: number | null
}

export interface SessionFilterCriteria {
  session: string
  requests: NumericRange
  original: NumericRange
  uploaded: NumericRange
  reduction: NumericRange
  activity: { from: number | null; to: number | null }
}

const byteUnits: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1_000,
  kb: 1_000,
  kib: 1_024,
  m: 1_000_000,
  mb: 1_000_000,
  mib: 1_048_576,
  g: 1_000_000_000,
  gb: 1_000_000_000,
  gib: 1_073_741_824,
  t: 1_000_000_000_000,
  tb: 1_000_000_000_000,
  tib: 1_099_511_627_776,
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/

export function emptySessionFilters(): SessionFilterInput {
  return {
    session: "",
    requestsMin: "",
    requestsMax: "",
    originalMin: "",
    originalMax: "",
    uploadedMin: "",
    uploadedMax: "",
    reductionMin: "",
    reductionMax: "",
    activityFrom: "",
    activityTo: "",
  }
}

// Accepts a plain byte count or a human-readable size such as "500 KB",
// "1.5 MB", or "1 MiB". Decimal and binary units are intentionally distinct.
export function parseByteSize(value: string): number | null {
  const text = value.trim().toLowerCase()
  if (!text) return null
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*([a-z]*)$/.exec(text)
  if (!match) return null
  const amount = Number(match[1]!.replace(",", "."))
  const unit = byteUnits[match[2]!]
  if (!Number.isFinite(amount) || amount < 0 || unit === undefined) return null
  return Math.round(amount * unit)
}

export function parseFilterNumber(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

// Date inputs are calendar dates without a time zone. Convert them to local
// day boundaries so "to" includes the whole selected day.
export function parseDateBound(value: string, endOfDay = false): number | null {
  const match = datePattern.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(year, month, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0)
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null
  return date.getTime()
}

function numberBound(value: string, minimum?: number): number | null {
  const parsed = parseFilterNumber(value)
  if (parsed === null || (minimum !== undefined && parsed < minimum)) return null
  return parsed
}

function sizeBound(value: string): number | null {
  return parseByteSize(value)
}

function compileRange(min: string, max: string, parse: (value: string) => number | null): NumericRange {
  return { min: parse(min), max: parse(max) }
}

export function compileSessionFilters(input: SessionFilterInput): SessionFilterCriteria {
  return {
    session: input.session.trim().toLowerCase(),
    requests: compileRange(input.requestsMin, input.requestsMax, (value) => numberBound(value, 0)),
    original: compileRange(input.originalMin, input.originalMax, sizeBound),
    uploaded: compileRange(input.uploadedMin, input.uploadedMax, sizeBound),
    reduction: compileRange(input.reductionMin, input.reductionMax, parseFilterNumber),
    activity: {
      from: input.activityFrom.trim() ? parseDateBound(input.activityFrom) : null,
      to: input.activityTo.trim() ? parseDateBound(input.activityTo, true) : null,
    },
  }
}

function inRange(value: number, range: NumericRange): boolean {
  if (range.min !== null && value < range.min) return false
  if (range.max !== null && value > range.max) return false
  return true
}

function hasRange(range: NumericRange): boolean {
  return range.min !== null || range.max !== null
}

export function matchesSessionFilters(session: SessionView, criteria: SessionFilterCriteria): boolean {
  if (criteria.session && !(session.id || "Unattributed requests").toLowerCase().includes(criteria.session)) return false
  if (!inRange(session.requests, criteria.requests)) return false
  if (!inRange(session.body_bytes, criteria.original)) return false
  if (!inRange(session.encoded_upload_bytes, criteria.uploaded)) return false
  if (hasRange(criteria.reduction)) {
    const reduction = savings(session.body_bytes, session.encoded_upload_bytes)
    if (reduction === null || !inRange(reduction, criteria.reduction)) return false
  }
  if (criteria.activity.from !== null || criteria.activity.to !== null) {
    const activity = Date.parse(session.updated_at)
    if (!Number.isFinite(activity)) return false
    if (criteria.activity.from !== null && activity < criteria.activity.from) return false
    if (criteria.activity.to !== null && activity > criteria.activity.to) return false
  }
  return true
}

export function filterSessionViews<T extends SessionView>(sessions: T[], criteria: SessionFilterCriteria): T[] {
  return sessions.filter((session) => matchesSessionFilters(session, criteria))
}

function numberActive(value: string, minimum?: number): boolean {
  return numberBound(value, minimum) !== null
}

function sizeActive(value: string): boolean {
  return sizeBound(value) !== null
}

function dateActive(value: string, endOfDay: boolean): boolean {
  return parseDateBound(value, endOfDay) !== null
}

export function isColumnFilterActive(input: SessionFilterInput, key: SessionColumnFilterKey): boolean {
  switch (key) {
    case "session": return input.session.trim() !== ""
    case "requests": return numberActive(input.requestsMin, 0) || numberActive(input.requestsMax, 0)
    case "original": return sizeActive(input.originalMin) || sizeActive(input.originalMax)
    case "uploaded": return sizeActive(input.uploadedMin) || sizeActive(input.uploadedMax)
    case "reduction": return numberActive(input.reductionMin) || numberActive(input.reductionMax)
    case "activity": return dateActive(input.activityFrom, false) || dateActive(input.activityTo, true)
  }
}

export function activeColumnFilterCount(input: SessionFilterInput): number {
  return (["session", "requests", "original", "uploaded", "reduction", "activity"] as const)
    .filter((key) => isColumnFilterActive(input, key)).length
}

function validRaw(params: URLSearchParams, name: string, validate: (value: string) => boolean, maxLength = 200): string {
  const raw = (params.get(name) ?? "").trim().slice(0, maxLength)
  return raw && validate(raw) ? raw : ""
}

export function readSessionFilters(params: URLSearchParams): SessionFilterInput {
  return {
    session: validRaw(params, "sid", () => true),
    requestsMin: validRaw(params, "req_min", (value) => numberBound(value, 0) !== null),
    requestsMax: validRaw(params, "req_max", (value) => numberBound(value, 0) !== null),
    originalMin: validRaw(params, "orig_min", sizeActive),
    originalMax: validRaw(params, "orig_max", sizeActive),
    uploadedMin: validRaw(params, "up_min", sizeActive),
    uploadedMax: validRaw(params, "up_max", sizeActive),
    reductionMin: validRaw(params, "red_min", (value) => parseFilterNumber(value) !== null),
    reductionMax: validRaw(params, "red_max", (value) => parseFilterNumber(value) !== null),
    activityFrom: validRaw(params, "act_from", (value) => parseDateBound(value) !== null),
    activityTo: validRaw(params, "act_to", (value) => parseDateBound(value, true) !== null),
  }
}

export function sessionFilterParams(input: SessionFilterInput): Record<string, string | null> {
  const valid = (value: string, validate: (value: string) => boolean) => value.trim() && validate(value.trim()) ? value.trim() : null
  return {
    sid: input.session.trim() || null,
    req_min: valid(input.requestsMin, (value) => numberBound(value, 0) !== null),
    req_max: valid(input.requestsMax, (value) => numberBound(value, 0) !== null),
    orig_min: valid(input.originalMin, sizeActive),
    orig_max: valid(input.originalMax, sizeActive),
    up_min: valid(input.uploadedMin, sizeActive),
    up_max: valid(input.uploadedMax, sizeActive),
    red_min: valid(input.reductionMin, (value) => parseFilterNumber(value) !== null),
    red_max: valid(input.reductionMax, (value) => parseFilterNumber(value) !== null),
    act_from: valid(input.activityFrom, (value) => parseDateBound(value) !== null),
    act_to: valid(input.activityTo, (value) => parseDateBound(value, true) !== null),
  }
}
