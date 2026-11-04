import { counters, object, optionalString, optionalTimestamp, timestamp } from "./validation.js"
import type { Transfer } from "./types.js"

export type InspectionStage = "body" | "inventory" | "upload" | "encoded" | "savings"
export interface CaptureStatus {
  enabled: boolean
  max_bytes: number
  max_capture_bytes: number
  max_captures: number
  max_age_seconds: number
  captures: number
  used_bytes: number
  storage_error: boolean
}
export interface Artifact {
  id: string
  representation: "captured" | "redacted"
  content_type: string
  encoding: "identity" | "gzip"
  source_bytes: number
  captured_bytes: number
  sha256?: string
  complete: boolean
  truncated: boolean
  write_error: boolean
}
export interface InventoryObservation {
  index: number
  kind: "initial" | "recovery"
  observed_at: string
  state_id: string
  scope_chunks: number
  missing_chunks: number
  missing_bytes: number
  present_body_bytes: number
  missing_body_bytes: number
  unknown_body_bytes: number
}
export interface UploadAttempt {
  index: number
  operation: string
  method: string
  path: string
  started_at: string
  finished_at?: string
  encoding: "identity" | "gzip"
  content_type: string
  decoded_bytes: number
  prepared_bytes: number
  consumed_bytes: number
  counted: boolean
  status: number
  outcome: string
  acknowledgment_ok: boolean
  payload?: Artifact
  chunk_count?: number
  chunks?: { hash: string; size: number }[]
}
export interface RequestCapture {
  version: 1
  id: string
  request_id: string
  sequence: number
  started_at: string
  finished_at?: string
  state: string
  body: Artifact
  chunk_count: number
  inventories: InventoryObservation[]
  attempts: UploadAttempt[]
  dropped_events: number
  storage_error: boolean
  transfer: Transfer
}
export interface CapturedChunk {
  index: number
  offset: number
  size: number
  hash: string
  availability: "present" | "missing" | "unknown"
  occurrences: number
}
export interface ChunkPage {
  start: number
  total: number
  inventory: number
  chunks: CapturedChunk[]
}
export interface ArtifactPage {
  offset: number
  total: number
  data: string
  decoded: boolean
  artifact: Artifact
}

const idPattern = /^[a-f0-9]{32}$/
const hashPattern = /^[a-f0-9]{64}$/
const artifactPattern = /^(body|attempt-(0|[1-9][0-9]{0,2}))$/
const transferKeys = ["body_bytes", "chunks", "unique_chunks", "uploaded_chunks", "uploaded_chunk_bytes", "missing_chunk_bytes", "reused_body_bytes", "request_body_bytes_sent", "requests", "duration_ms"]
export function captureID(value: unknown): value is string { return typeof value === "string" && idPattern.test(value) }
export function isCaptureStatus(value: unknown): value is CaptureStatus {
  return object(value) && typeof value.enabled === "boolean" && typeof value.storage_error === "boolean" && counters(value, ["max_bytes", "max_capture_bytes", "max_captures", "max_age_seconds", "captures", "used_bytes"])
}
function artifact(value: unknown): value is Artifact {
  return object(value) && typeof value.id === "string" && artifactPattern.test(value.id) && ["captured", "redacted"].includes(String(value.representation)) &&
    typeof value.content_type === "string" && ["identity", "gzip"].includes(String(value.encoding)) && counters(value, ["source_bytes", "captured_bytes"]) &&
    (value.captured_bytes as number) <= (value.source_bytes as number) && (value.sha256 === undefined || typeof value.sha256 === "string" && hashPattern.test(value.sha256)) &&
    ["complete", "truncated", "write_error"].every((key) => typeof value[key] === "boolean")
}
function inventory(value: unknown): boolean {
  return object(value) && counters(value, ["index", "scope_chunks", "missing_chunks", "missing_bytes", "present_body_bytes", "missing_body_bytes", "unknown_body_bytes"]) && ["initial", "recovery"].includes(String(value.kind)) && timestamp(value.observed_at) && typeof value.state_id === "string"
}
function attempt(value: unknown): boolean {
  return object(value) && counters(value, ["index", "decoded_bytes", "prepared_bytes", "consumed_bytes", "status"]) &&
    ["operation", "method", "path", "content_type", "outcome"].every((key) => typeof value[key] === "string") && ["identity", "gzip"].includes(String(value.encoding)) &&
    timestamp(value.started_at) && optionalTimestamp(value.finished_at) && typeof value.counted === "boolean" && typeof value.acknowledgment_ok === "boolean" && (value.payload === undefined || artifact(value.payload)) &&
    (value.consumed_bytes as number) <= (value.prepared_bytes as number) && (value.status as number) <= 599
}
export function isRequestCapture(value: unknown): value is RequestCapture {
  return object(value) && value.version === 1 && captureID(value.id) && typeof value.request_id === "string" && counters(value, ["sequence", "chunk_count", "dropped_events"]) &&
    timestamp(value.started_at) && optionalTimestamp(value.finished_at) && typeof value.state === "string" && typeof value.storage_error === "boolean" && artifact(value.body) &&
    Array.isArray(value.inventories) && value.inventories.length <= 256 && value.inventories.every(inventory) &&
    Array.isArray(value.attempts) && value.attempts.length <= 256 && value.attempts.every((a) => attempt(a) && object(a) && counters(a, ["chunk_count"])) &&
    object(value.transfer) && optionalString(value.transfer.hash) && counters(value.transfer, transferKeys)
}
function isChunkPage(value: unknown): value is ChunkPage {
  return object(value) && counters(value, ["start", "total"]) && Number.isInteger(value.inventory) && (value.inventory as number) >= -1 &&
    Array.isArray(value.chunks) && value.chunks.length <= 256 && value.chunks.every((c) => object(c) && counters(c, ["index", "offset", "size", "occurrences"]) && typeof c.hash === "string" && hashPattern.test(c.hash) && ["present", "missing", "unknown"].includes(String(c.availability)))
}
function isArtifactPage(value: unknown): value is ArtifactPage {
  return object(value) && counters(value, ["offset", "total"]) && typeof value.data === "string" && value.data.length <= 87384 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data) && typeof value.decoded === "boolean" && artifact(value.artifact)
}

const captureErrors: Record<string, string> = {
  capture_disabled: "Capture is disabled on this gateway. Existing counters cannot reconstruct content.",
  capture_not_retained: "Capture not retained. It may have expired, been evicted, or capture may now be disabled. Historical content cannot be reconstructed. No payload has been substituted or reconstructed.",
  attempt_not_captured: "That attempt was not captured. No substitute payload is shown.",
  artifact_not_captured: "No payload artifact was captured for this operation. No substitute is shown.",
  inventory_not_captured: "That inventory observation was not captured.",
  artifact_unavailable_or_incomplete: "The retained artifact is incomplete or unavailable. No replacement bytes are shown.",
  artifact_read_failed: "The retained artifact could not be read completely. No partial bytes are presented as complete.",
  offset_out_of_range: "The requested byte offset is outside the retained artifact.",
  invalid_inspection_route: "The inspection request was rejected before reaching capture data.",
  capture_gateway_unreachable: "The local gateway could not be reached to load capture evidence.",
  capture_unavailable: "Capture evidence is unavailable from the gateway.",
  invalid_capture_response: "The gateway returned an invalid capture response.",
}

async function get<T>(path: string, validate: (v: unknown) => v is T, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const code = object(body) && typeof body.error === "string" ? body.error : ""
    throw new Error(captureErrors[code] ?? "Capture unavailable. No payload has been substituted or reconstructed.")
  }
  const data: unknown = await response.json()
  signal.throwIfAborted()
  if (!validate(data)) throw new Error("Incompatible capture evidence. Rebuild both the gateway and dashboard.")
  return data
}
export function captureURL(id: string): string {
  if (!captureID(id)) throw new Error("Invalid capture identifier")
  return `/api/inspection/${id}`
}
export const fetchCapture = (id: string, signal: AbortSignal) => get(captureURL(id), isRequestCapture, signal)
export async function fetchChunks(id: string, start: number, inventory: number, signal: AbortSignal): Promise<ChunkPage> {
  const page = await get(`${captureURL(id)}/chunks?start=${start}&limit=128${inventory >= 0 ? `&inventory=${inventory}` : ""}`, isChunkPage, signal)
  if (page.start !== start || page.inventory !== inventory) throw new Error("Capture chunk page does not match the requested offset/observation.")
  return page
}
export async function fetchAttempt(id: string, index: number, signal: AbortSignal): Promise<UploadAttempt> {
  const value = await get(`${captureURL(id)}/attempts/${index}`, (v): v is UploadAttempt => attempt(v) && object(v) && (v.chunks === undefined || Array.isArray(v.chunks) && v.chunks.length <= 1024 && v.chunks.every((c) => object(c) && typeof c.hash === "string" && hashPattern.test(c.hash) && counters(c, ["size"]))), signal)
  if (value.index !== index) throw new Error("Capture attempt index does not match the request.")
  return value
}
export function artifactURL(id: string, artifactID: string, download = false, decoded = false): string {
  if (!artifactPattern.test(artifactID)) throw new Error("Invalid artifact identifier")
  return `${captureURL(id)}/artifacts/${artifactID}${download ? "/download" : ""}${decoded ? "?decode=1" : ""}`
}
export function artifactPageURL(id: string, artifactID: string, offset: number, decoded = false, limit = 4096): string {
  if (!artifactPattern.test(artifactID)) throw new Error("Invalid artifact identifier")
  return `${captureURL(id)}/artifacts/${artifactID}?offset=${offset}&limit=${limit}${decoded ? "&decode=1" : ""}`
}
export async function fetchArtifact(id: string, artifactID: string, offset: number, signal: AbortSignal, decoded = false, limit = 4096): Promise<ArtifactPage> {
  const page = await get(artifactPageURL(id, artifactID, offset, decoded, limit), isArtifactPage, signal)
  if (page.offset !== offset || page.artifact.id !== artifactID) throw new Error("Capture artifact page does not match the requested bytes.")
  return page
}

export function decodeBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}
export function hexDump(data: Uint8Array, offset = 0): string {
  const lines: string[] = []
  for (let i = 0; i < data.length; i += 16) {
    const row = data.subarray(i, i+16)
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47)
    const text = Array.from(row, (b) => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join("")
    lines.push(`${(offset+i).toString(16).padStart(8, "0")}  ${hex}  |${text}|`)
  }
  return lines.join("\n")
}

// Validate, then indent original tokens without reserializing parsed values.
// This preserves duplicate keys, huge integers, exponents and escape sequences.
export function formatJSON(source: string): string {
  JSON.parse(source)
  let output = "", depth = 0, quoted = false, escaped = false, previous = ""
  const indent = () => "  ".repeat(Math.min(depth, 100))
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      output += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') { quoted = true; output += c }
    else if (c === "{" || c === "[") {
      output += c; depth++
      let next = i+1
      while (next < source.length && /\s/.test(source[next]!)) next++
      if (source[next] !== "}" && source[next] !== "]") output += `\n${indent()}`
    }
    else if (c === "}" || c === "]") { depth--; if (previous !== "{" && previous !== "[") output += `\n${indent()}`; output += c }
    else if (c === ",") output += `,\n${indent()}`
    else if (c === ":") output += ": "
    else if (!/\s/.test(c)) output += c
    if (!/\s/.test(c)) previous = c
  }
  return output
}
