import type { NodeID, TopologyNode } from "./topology.js"

// Stable layout, no client-side graph engine or external assets. The SVG and
// accessible HTML node buttons share the same coordinate system.
export const mapWidth = 1330
export const mapHeight = 1320
export const nodeWidth = 190
export const nodeHeight = 110
export const mapNodes: { id: NodeID; label: string; icon: import("./icons.js").IconName; role: string; x: number; y: number }[] = [
  { id: "vscode", label: "Varro in VS Code", icon: "vscode", role: "Editor", x: 55, y: 130 },
  { id: "desktop", label: "OpenCode Desktop", icon: "opencode", role: "App", x: 55, y: 390 },
  { id: "openchamber", label: "OpenChamber", icon: "openchamber", role: "App", x: 55, y: 645 },
  { id: "opencode", label: "OpenCode server", icon: "opencode", role: "Process", x: 305, y: 390 },
  { id: "plugin", label: "DeltaRelay plugin", icon: "plugin", role: "Module", x: 535, y: 390 },
  { id: "gate", label: "Frontend health gate", icon: "gate", role: "Process", x: 305, y: 130 },
  { id: "gateway", label: "Local gateway", icon: "shield", role: "Process", x: 795, y: 390 },
  { id: "network", label: "Internet / interfaces", icon: "globe", role: "Network", x: 535, y: 645 },
  { id: "tunnel", label: "Connection transport", icon: "link", role: "Transport", x: 795, y: 645 },
  { id: "remote", label: "Remote host", icon: "system", role: "Host", x: 1090, y: 95 },
  { id: "relay", label: "DeltaRelay relay", icon: "relay", role: "Process", x: 1090, y: 390 },
  { id: "storage", label: "Cache / saved responses", icon: "storage", role: "Files", x: 1090, y: 585 },
  { id: "provider", label: "Model provider", icon: "bolt", role: "External API", x: 1075, y: 880 },
  { id: "dashboard_ui", label: "Dashboard browser", icon: "browser", role: "Browser tab", x: 55, y: 930 },
  { id: "dashboard", label: "Dashboard service", icon: "overview", role: "Process", x: 305, y: 930 },
  { id: "supervisor", label: "Recovery supervisor", icon: "activity", role: "Process", x: 555, y: 930 },
  { id: "remote_provider", label: "Remote-host adapter", icon: "settings", role: "Executable", x: 555, y: 1150 },
]

export const mapRegions = [
  { id: "local", label: "YOUR COMPUTER · MODEL REQUEST COMPONENTS", x: 15, y: 20, width: 1020, height: 770 },
  { id: "remote", label: "HOST · REMOTE MACHINE", x: 1055, y: 20, width: 260, height: 770 },
  { id: "control", label: "YOUR COMPUTER · INDEPENDENT CONTROL PLANE", x: 15, y: 820, width: 770, height: 485 },
]

// The frontend/backend divider is drawn only where a frontend sits beside its
// backend counterpart, so it never runs through region titles or empty space.
export const mapLayerSegments = [
  { y1: 70, y2: 255 },
  { y1: 330, y2: 515 },
  { y1: 585, y2: 770 },
  { y1: 870, y2: 1055 },
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
  side?: "frontend" | "backend"
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
  { id: "vscode", kind: "process", label: "PROCESS", title: "Varro in VS Code", detail: "Editor process opened on request. The supervisor never starts it automatically, restarts it, or observes it.", side: "frontend", members: ["vscode"], x: 35, y: 70, width: 230, height: 185 },
  { id: "desktop", kind: "process", label: "PROCESS", title: "OpenCode Desktop", detail: "Desktop application, separate from the OpenCode server.", side: "frontend", members: ["desktop"], x: 35, y: 330, width: 230, height: 185 },
  { id: "openchamber", kind: "process", label: "PROCESS", title: "OpenChamber", detail: "Frontend process. Attaches to the shared OpenCode service only through the frontend health gate; attachment is not independently observed.", side: "frontend", members: ["openchamber"], x: 35, y: 585, width: 230, height: 185 },
  { id: "opencode", kind: "process", label: "PROCESS", title: "OpenCode server", detail: "The DeltaRelay plugin is loaded inside the OpenCode server process, not a separate process.", side: "backend", members: ["opencode", "plugin"], x: 285, y: 330, width: 460, height: 185 },
  { id: "gateway", kind: "process", label: "PROCESS", title: "Local gateway", detail: "Local authenticated HTTP gateway process.", side: "backend", members: ["gateway"], x: 775, y: 330, width: 230, height: 185 },
  { id: "gate", kind: "process", label: "PROCESS", title: "Frontend health gate", detail: "Supervised loopback health gate. It never owns or restarts the shared OpenCode service.", side: "backend", members: ["gate"], x: 285, y: 70, width: 225, height: 185 },
  { id: "network", kind: "network", label: "NETWORK · NOT A PROCESS", title: "Internet / interfaces", detail: "Interfaces, routes and connectivity are prerequisites, not a relay process.", members: ["network"], x: 520, y: 585, width: 230, height: 185 },
  { id: "tunnel", ...transportBoundary(), side: "backend", members: ["tunnel"], x: 775, y: 585, width: 230, height: 185 },
  { id: "relay", kind: "process", label: "PROCESS + OWNED FILES", title: "DeltaRelay relay", detail: "The relay process owns the cache and saved-response files. These are persistent files, not a separate process, and survive process restarts.", note: "Owned files survive restarts", side: "backend", members: ["relay", "storage"], x: 1070, y: 310, width: 230, height: 410 },
  { id: "provider", kind: "external", label: "EXTERNAL SERVICE", title: "Model provider API", detail: "External API, outside the relay process and remote host. Its internal processes are not observed.", members: ["provider"], x: 1050, y: 820, width: 230, height: 190 },
  { id: "dashboard_ui", kind: "process", label: "BROWSER PROCESS", title: "Dashboard browser", detail: "Dashboard page running in the browser, separate from the dashboard service.", side: "frontend", members: ["dashboard_ui"], x: 35, y: 870, width: 230, height: 185 },
  { id: "dashboard", kind: "process", label: "PROCESS", title: "Dashboard service", detail: "Independent local dashboard HTTP service process.", side: "backend", members: ["dashboard"], x: 285, y: 870, width: 230, height: 185 },
  { id: "supervisor", kind: "process", label: "PROCESS", title: "Recovery supervisor", detail: "Independent background supervisor process. Managed applications run in their own processes, not inside this controller.", side: "backend", members: ["supervisor"], x: 535, y: 870, width: 230, height: 185 },
  { id: "remote_provider", kind: "process", label: "PROCESS · ON DEMAND", title: "Remote-host adapter", detail: "Trusted local executable invoked on demand by the supervisor; not a permanently running server or the model provider.", side: "backend", members: ["remote_provider"], x: 535, y: 1090, width: 230, height: 185 },
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
    // The gate sits in the top row: reach it from the right-hand bus and the
    // lane above the second row, entering left of its data link to OpenCode.
    if (target === "gate") return `M${a.x + nodeWidth},${ay} H1048 V285 H350 V${b.y + nodeHeight}`
    if (target === "openchamber") return `M${a.x + nodeWidth},${ay} H1048 V560 H150 V${b.y}`
    // A shared management lane between the second and third local component rows.
    if (target === "desktop" || target === "opencode" || target === "gateway") return `M${a.x + nodeWidth},${ay} H1048 V560 H${bx} V${b.y + nodeHeight}`
    if (target === "tunnel") return `M${a.x + nodeWidth},${ay} H890 V${b.y + nodeHeight}`
  }
  if (source === "gate" && target === "gateway") {
    // Health/check dependency, not a model-data hop: cross the open top row and
    // enter the gateway from above, clear of the plugin data link.
    return `M${a.x + nodeWidth},${ay} H840 V${b.y}`
  }
  if (source === "openchamber" && target === "gate") {
    // The frontend attaches through the shared gate: climb the frontend/backend
    // divider and enter the gate from below, clear of the editor attach link.
    return `M${a.x + nodeWidth},${ay} H265 V300 H350 V${b.y + nodeHeight}`
  }
  if (source === "tunnel" && target === "relay") {
    // The relay is one row above the transport: climb the gap between the local
    // and remote regions instead of crossing the local cards.
    return `M${a.x + nodeWidth},${ay} H1038 V${by} H${b.x}`
  }
  if (source === "relay" && target === "provider") {
    // The provider sits below the remote column: leave by the right edge and
    // drop down the margin outside the relay's owned-files boundary.
    return `M${a.x + nodeWidth},${ay} H1292 V${b.y + nodeHeight / 2} H${b.x + nodeWidth}`
  }
  if (source === "remote_provider" && (target === "remote" || target === "relay")) {
    return `M${a.x + nodeWidth},${ay} H1048 V${by} H${b.x}`
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

/** Return lane, offset from the outgoing route without moving node endpoints off their borders. */
export function responsePath(source: NodeID, target: NodeID): string {
  const a = mapNodes.find((node) => node.id === target)!
  const b = mapNodes.find((node) => node.id === source)!
  const lane = 16
  const ax = a.x + nodeWidth / 2 + lane, ay = a.y + nodeHeight / 2 + lane
  const bx = b.x + nodeWidth / 2 + lane, by = b.y + nodeHeight / 2 + lane
  if (source === "tunnel" && target === "relay") {
    // Return beside the request lane, clear of the relay-owned cache files.
    return `M${a.x},${a.y + nodeHeight / 2 + lane} H1054 V${b.y + nodeHeight / 2 + lane} H${b.x + nodeWidth}`
  }
  if (source === "relay" && target === "provider") {
    // Return outside the request lane and above its exit, so the two never cross
    // and the relay-owned cache files stay clear.
    return `M${a.x + nodeWidth},${a.y + nodeHeight / 2 + lane} H1308 V${b.y + nodeHeight / 2 - lane} H${b.x + nodeWidth}`
  }
  if (source === "openchamber" && target === "gate") {
    // Return beside the attach route, following the divider before entering the
    // frontend from its right edge.
    return `M${a.x + nodeWidth / 2 + lane},${a.y + nodeHeight} V301 H281 V${b.y + nodeHeight / 2 + lane} H${b.x + nodeWidth}`
  }
  if (a.y === b.y) return a.x < b.x
    ? `M${a.x + nodeWidth},${ay} H${b.x}`
    : `M${a.x},${ay} H${b.x + nodeWidth}`
  if (a.x === b.x) return a.y < b.y
    ? `M${ax},${a.y + nodeHeight} V${b.y}`
    : `M${ax},${a.y} V${b.y + nodeHeight}`
  const direction = by > ay ? 1 : -1
  const sy = ay + direction * nodeHeight / 2 - lane
  const ty = by - direction * nodeHeight / 2 - lane
  const middle = (sy + ty) / 2 + lane
  return `M${ax},${sy} V${middle} H${bx} V${ty}`
}
