import { nullableTimestamp, object, timestamp } from "./validation.js"

export const nodeIDs = ["desktop", "opencode", "plugin", "gateway", "tunnel", "network", "remote", "relay", "storage", "provider", "dashboard_ui", "dashboard", "supervisor", "remote_provider"] as const
export type NodeID = typeof nodeIDs[number]
export type ComponentAction = "start" | "recover" | "restart" | "wake" | "stop"
export type Readiness = "ready" | "not_ready" | "unknown" | "blocked"

export interface TopologyNode {
  id: NodeID
  label: string
  kind: string
  group: "local" | "network" | "remote" | "external" | "control"
  owner: string
  managed: boolean
  desired: "running" | "stopped" | "external" | "unmanaged"
  lifecycle: string
  readiness: Readiness
  activity: string
  checked_at: string | null
  detail: string
  actions: ComponentAction[]
}

export interface TopologyEdge {
  id: string
  source: NodeID
  target: NodeID
  relation: "traffic" | "requires" | "contains" | "manages"
  protocol: string
  state: Readiness
}

export interface RecoveryStep {
  component: NodeID
  action: string
  status: "running" | "completed" | "failed" | "interrupted"
  started_at: string
  finished_at: string | null
  error: string
}

export interface RecoveryRun {
  version: 1
  id: string
  request_id: string
  target: string
  action: string
  trigger: string
  status: "running" | "completed" | "failed" | "interrupted"
  current_component: string
  current_action: string
  started_at: string
  finished_at: string | null
  error: string
  steps: RecoveryStep[]
}

export interface TopologyStatus {
  version: 1
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  intent: { system: "running" | "stopped"; remote: "running" | "stopped" }
  network: { generation: number; changed_at: string | null }
  run: RecoveryRun | null
  shutdown_blockers: string[]
}

const includes = (value: unknown, choices: readonly string[]): value is string => typeof value === "string" && choices.includes(value)
const id = (value: unknown): value is NodeID => includes(value, nodeIDs)
const safe = (value: unknown, maximum: number): value is string => typeof value === "string" && [...value].length <= maximum && !/[\x00-\x1f\x7f-\x9f]/.test(value)
const code = (value: unknown): value is string => typeof value === "string" && /^[a-z_]{0,64}$/.test(value)
const action = (value: unknown): boolean => includes(value, ["start", "recover", "restart", "stop", "wake", "observe", "verify"])
const readiness = (value: unknown): boolean => includes(value, ["ready", "not_ready", "unknown", "blocked"])
const runState = (value: unknown): boolean => includes(value, ["running", "completed", "failed", "interrupted"])

export function isTopology(v: unknown): v is TopologyStatus {
  if (!object(v) || v.version !== 1 || !Array.isArray(v.nodes) || !v.nodes.length || v.nodes.length > 32 || !Array.isArray(v.edges) || v.edges.length > 64 || !Array.isArray(v.shutdown_blockers) || v.shutdown_blockers.length > 6) return false
  if (!object(v.intent) || !includes(v.intent.system, ["running", "stopped"]) || !includes(v.intent.remote, ["running", "stopped"])) return false
  if (!object(v.network) || !Number.isSafeInteger(v.network.generation) || (v.network.generation as number) < 0 || !nullableTimestamp(v.network.changed_at)) return false
  const seen = new Set<string>()
  for (const n of v.nodes) {
    if (!object(n) || !id(n.id) || seen.has(n.id) || !safe(n.label, 80) || !n.label.length || !safe(n.detail, 400) || !code(n.kind) || !includes(n.group, ["local", "network", "remote", "external", "control"]) || !(id(n.owner) || includes(n.owner, ["external", "user", "launcher"])) || typeof n.managed !== "boolean" || !includes(n.desired, ["running", "stopped", "external", "unmanaged"]) || !includes(n.lifecycle, ["running", "stopped", "starting", "stopping", "started", "unknown", "unmanaged"]) || !readiness(n.readiness) || !(n.activity === "idle" || action(n.activity)) || !nullableTimestamp(n.checked_at) || !Array.isArray(n.actions) || n.actions.length > 5 || new Set(n.actions).size !== n.actions.length || !n.actions.every((a) => includes(a, ["start", "recover", "restart", "wake", "stop"]))) return false
    seen.add(n.id)
  }
  const edges = new Set<string>()
  for (const e of v.edges) {
    if (!object(e) || !id(e.source) || !id(e.target) || !seen.has(e.source) || !seen.has(e.target) || e.id !== `${e.source}_${e.target}` || edges.has(e.id as string) || !includes(e.relation, ["traffic", "requires", "contains", "manages"]) || !safe(e.protocol, 80) || !readiness(e.state)) return false
    edges.add(e.id as string)
  }
  if (!v.shutdown_blockers.every((name) => typeof name === "string" && seen.has(name))) return false
  if (v.run === null) return true
  const r = v.run
  if (!object(r) || r.version !== 1 || typeof r.id !== "string" || !/^[a-f0-9]{16}$/.test(r.id) || typeof r.request_id !== "string" || !/^(?:[a-f0-9]{32})?$/.test(r.request_id) || !(id(r.target) || includes(r.target, ["all", "connection"])) || !action(r.action) || !includes(r.trigger, ["manual", "automatic", "startup"]) || !runState(r.status) || !(r.current_component === "" || id(r.current_component)) || !(r.current_action === "" || action(r.current_action)) || !timestamp(r.started_at) || !nullableTimestamp(r.finished_at) || !code(r.error) || !Array.isArray(r.steps) || r.steps.length > 64) return false
  return r.steps.every((s) => object(s) && id(s.component) && action(s.action) && runState(s.status) && timestamp(s.started_at) && nullableTimestamp(s.finished_at) && code(s.error))
}

export function nodePresentation(node: TopologyNode, stale: boolean): { label: string; tone: string } {
  if (stale) return { label: "Stale", tone: "neutral" }
  if (node.activity !== "idle") return { label: `${node.activity.replaceAll("_", " ")}…`, tone: "working" }
  if (node.desired === "stopped") return { label: node.lifecycle === "stopped" ? "Stopped intentionally" : "Recovery paused", tone: "neutral" }
  if (node.readiness === "ready") return { label: "Ready", tone: "good" }
  if (node.readiness === "blocked") return { label: "Needs attention", tone: "bad" }
  if (node.readiness === "not_ready") return { label: node.lifecycle === "stopped" ? "Stopped" : "Not ready", tone: "warning" }
  if (node.lifecycle === "running" || node.lifecycle === "started") return { label: "Running · unverified", tone: "neutral" }
  return { label: node.lifecycle === "unmanaged" ? "Not configured" : "Not verified", tone: "neutral" }
}

export function observationStale(node: TopologyNode, observedAt: string): boolean {
  return node.checked_at !== null && Date.parse(observedAt) - Date.parse(node.checked_at) > 30_000
}
