import type { NodeID, TopologyNode } from "./topology.js"

// Stable layout, no client-side graph engine or external assets. The SVG and
// accessible HTML node buttons share the same coordinate system.
export const mapWidth = 1330
export const mapHeight = 1040
export const nodeWidth = 190
export const nodeHeight = 110
export const mapNodes: { id: NodeID; label: string; icon: string; role: string; x: number; y: number }[] = [
  { id: "desktop", label: "OpenCode Desktop", icon: "desktop", role: "App", x: 55, y: 130 },
  { id: "opencode", label: "OpenCode server", icon: "terminal", role: "Process", x: 305, y: 130 },
  { id: "plugin", label: "DeltaRelay plugin", icon: "plugin", role: "Module", x: 535, y: 130 },
  { id: "gateway", label: "Local gateway", icon: "shield", role: "Process", x: 795, y: 130 },
  { id: "network", label: "Internet / interfaces", icon: "globe", role: "Network", x: 535, y: 370 },
  { id: "tunnel", label: "Connection transport", icon: "link", role: "Transport", x: 795, y: 370 },
  { id: "remote", label: "Remote host", icon: "system", role: "Host", x: 1090, y: 95 },
  { id: "relay", label: "DeltaRelay relay", icon: "relay", role: "Process", x: 1090, y: 370 },
  { id: "storage", label: "Cache / saved responses", icon: "storage", role: "Files", x: 1090, y: 565 },
  { id: "provider", label: "Model provider", icon: "bolt", role: "External API", x: 825, y: 615 },
  { id: "dashboard_ui", label: "Dashboard browser", icon: "browser", role: "Browser tab", x: 55, y: 665 },
  { id: "dashboard", label: "Dashboard service", icon: "overview", role: "Process", x: 305, y: 665 },
  { id: "supervisor", label: "Recovery supervisor", icon: "activity", role: "Process", x: 555, y: 665 },
  { id: "remote_provider", label: "Remote-host adapter", icon: "settings", role: "Executable", x: 555, y: 885 },
]

export const mapRegions = [
  { id: "local", label: "YOUR COMPUTER · MODEL REQUEST COMPONENTS", x: 15, y: 20, width: 1020, height: 250 },
  { id: "remote", label: "HOST · REMOTE MACHINE", x: 1055, y: 20, width: 260, height: 720 },
  { id: "control", label: "YOUR COMPUTER · INDEPENDENT CONTROL PLANE", x: 15, y: 555, width: 770, height: 465 },
]

export type BoundaryKind = "process" | "network" | "external" | "path" | "transport"
export interface BoundaryPresentation {
  kind: BoundaryKind
  label: string
  title: string
  detail: string
}

export interface MapBoundary extends BoundaryPresentation {
  id: NodeID
  members: NodeID[]
  x: number
  y: number
  width: number
  height: number
  note?: string
}

// These are runtime/ownership boundaries, not lifecycle-manager relationships:
// the supervisor manages other processes, but does not contain them.
export const mapBoundaries: MapBoundary[] = [
  { id: "desktop", kind: "process", label: "PROCESS", title: "OpenCode Desktop", detail: "Desktop application, separate from the OpenCode server.", members: ["desktop"], x: 35, y: 70, width: 230, height: 185 },
  { id: "opencode", kind: "process", label: "PROCESS", title: "OpenCode server", detail: "The DeltaRelay plugin is loaded inside the OpenCode server process, not a separate process.", members: ["opencode", "plugin"], x: 285, y: 70, width: 460, height: 185 },
  { id: "gateway", kind: "process", label: "PROCESS", title: "Local gateway", detail: "Local authenticated HTTP gateway process.", members: ["gateway"], x: 775, y: 70, width: 230, height: 185 },
  { id: "network", kind: "network", label: "NETWORK · NOT A PROCESS", title: "Internet / interfaces", detail: "Interfaces, routes and connectivity are prerequisites, not a relay process.", members: ["network"], x: 515, y: 310, width: 230, height: 185 },
  { id: "tunnel", ...transportBoundary(), members: ["tunnel"], x: 775, y: 310, width: 230, height: 185 },
  { id: "relay", kind: "process", label: "PROCESS + OWNED FILES", title: "DeltaRelay relay", detail: "The relay process owns the cache and saved-response files. These are persistent files, not a separate process, and survive process restarts.", note: "Owned files survive restarts", members: ["relay", "storage"], x: 1070, y: 310, width: 230, height: 410 },
  { id: "provider", kind: "external", label: "EXTERNAL SERVICE", title: "Model provider API", detail: "External API, outside the relay process and remote host. Its internal processes are not observed.", members: ["provider"], x: 805, y: 555, width: 230, height: 190 },
  { id: "dashboard_ui", kind: "process", label: "BROWSER PROCESS", title: "Dashboard browser", detail: "Dashboard page running in the browser, separate from the dashboard service.", members: ["dashboard_ui"], x: 35, y: 605, width: 230, height: 185 },
  { id: "dashboard", kind: "process", label: "PROCESS", title: "Dashboard service", detail: "Independent local dashboard HTTP service process.", members: ["dashboard"], x: 285, y: 605, width: 230, height: 185 },
  { id: "supervisor", kind: "process", label: "PROCESS", title: "Recovery supervisor", detail: "Independent background supervisor process. Managed applications run in their own processes, not inside this controller.", members: ["supervisor"], x: 535, y: 605, width: 230, height: 185 },
  { id: "remote_provider", kind: "process", label: "PROCESS · ON DEMAND", title: "Remote-host adapter", detail: "Trusted local executable invoked on demand by the supervisor; not a permanently running server or the model provider.", members: ["remote_provider"], x: 535, y: 825, width: 230, height: 185 },
]

// Topology v1 exposes the configured mode through these supervisor labels.
// Readiness/lifecycle cannot identify the mode: a configured tunnel can be down.
export function transportBoundary(node?: TopologyNode): BoundaryPresentation {
  if (node?.label === "Encrypted tunnel") return {
    kind: "process", label: "PROCESS · LOCAL TUNNEL", title: "Encrypted tunnel",
    detail: "Configured local tunnel/forwarder process. Connectivity is checked separately from process existence.",
  }
  if (node?.label === "Direct HTTPS / transport") return {
    kind: "path", label: "PATH · NOT A PROCESS", title: "Direct HTTPS",
    detail: "Direct HTTPS connection path; no separate tunnel process is configured.",
  }
  return {
    kind: "transport", label: "TRANSPORT · MODE UNKNOWN", title: "Connection transport",
    detail: "Waiting for the supervisor to identify a tunnel process or direct HTTPS path.",
  }
}

export function edgePath(source: NodeID, target: NodeID): string {
  const a = mapNodes.find((node) => node.id === source)!
  const b = mapNodes.find((node) => node.id === target)!
  const ax = a.x + nodeWidth / 2, ay = a.y + nodeHeight / 2
  const bx = b.x + nodeWidth / 2, by = b.y + nodeHeight / 2
  // Management links use the open lanes between boundaries, rather than
  // crossing unrelated process/component cards on the way to their targets.
  if (source === "supervisor") {
    if (target === "desktop" || target === "opencode" || target === "tunnel") return `M${ax},${a.y} V520 H${bx} V${b.y + nodeHeight}`
    if (target === "gateway") return `M${ax},${a.y} V520 H760 V285 H${bx} V${b.y + nodeHeight}`
  }
  if (source === "remote_provider") {
    if (target === "remote") return `M${a.x + nodeWidth},${ay} H1045 V250 H${bx} V${b.y + nodeHeight}`
    if (target === "relay") return `M${a.x + nodeWidth},${ay} H1045 V${by} H${b.x}`
  }
  if (a.y === b.y) return a.x < b.x
    ? `M${a.x + nodeWidth},${a.y + nodeHeight / 2} H${b.x}`
    : `M${a.x},${a.y + nodeHeight / 2} H${b.x + nodeWidth}`
  if (a.x === b.x) return a.y < b.y
    ? `M${a.x + nodeWidth / 2},${a.y + nodeHeight} V${b.y}`
    : `M${a.x + nodeWidth / 2},${a.y} V${b.y + nodeHeight}`
  const direction = by > ay ? 1 : -1
  const sy = ay + direction * nodeHeight / 2
  const ty = by - direction * nodeHeight / 2
  const middle = (sy + ty) / 2
  return `M${ax},${sy} V${middle} H${bx} V${ty}`
}
