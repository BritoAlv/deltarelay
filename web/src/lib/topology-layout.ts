import type { NodeID, TopologyNode } from "./topology.js"

// Stable layout, no client-side graph engine or external assets. The SVG and
// accessible HTML node buttons share the same coordinate system.
export const mapWidth = 1560
export const mapHeight = 1320
export const nodeWidth = 190
export const nodeHeight = 110
export const mapNodes: { id: NodeID; label: string; icon: import("./icons.js").IconName; role: string; note?: string; x: number; y: number }[] = [
  { id: "vscode", label: "Varro in VS Code", icon: "vscode", role: "Editor", x: 55, y: 130 },
  { id: "openchamber", label: "OpenChamber", icon: "openchamber", role: "App", x: 55, y: 390 },
  { id: "desktop", label: "OpenCode Desktop", icon: "opencode", role: "App", x: 55, y: 645 },
  { id: "opencode", label: "OpenCode server", icon: "opencode", role: "Process", x: 305, y: 390 },
  { id: "plugin", label: "DeltaRelay plugin", icon: "plugin", role: "Module", x: 535, y: 390 },
  { id: "gate", label: "Frontend health gate", icon: "gate", role: "Process", x: 305, y: 190 },
  { id: "gateway", label: "Local gateway", icon: "shield", role: "Process", x: 795, y: 390 },
  { id: "network", label: "Internet / interfaces", icon: "globe", role: "Network", x: 535, y: 645 },
  { id: "tunnel", label: "Connection transport", icon: "link", role: "Transport", x: 795, y: 645 },
  { id: "remote", label: "Remote host", icon: "system", role: "Host", x: 1205, y: 95 },
  { id: "relay", label: "DeltaRelay relay", icon: "relay", role: "Process", x: 1205, y: 390 },
  { id: "storage", label: "Request chunk cache", icon: "storage", role: "Files", x: 1090, y: 585 },
  { id: "mailbox", label: "Response mailbox", icon: "mailbox", role: "Durable files", note: "Saved until ACK / expiry", x: 1320, y: 585 },
  { id: "provider", label: "Model provider", icon: "bolt", role: "External API", x: 1205, y: 880 },
  { id: "dashboard_ui", label: "Dashboard browser", icon: "browser", role: "Browser tab", x: 55, y: 930 },
  { id: "dashboard", label: "Dashboard service", icon: "overview", role: "Process", x: 305, y: 930 },
  { id: "supervisor", label: "Recovery supervisor", icon: "activity", role: "Process", x: 555, y: 930 },
  { id: "remote_provider", label: "Remote-host adapter", icon: "settings", role: "Executable", x: 555, y: 1150 },
]

export const mapRegions = [
  { id: "local", label: "YOUR COMPUTER · MODEL REQUEST COMPONENTS", x: 15, y: 20, width: 1020, height: 770 },
  { id: "remote", label: "HOST · REMOTE MACHINE", x: 1055, y: 20, width: 490, height: 770 },
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
  { id: "desktop", kind: "process", label: "PROCESS", title: "OpenCode Desktop", detail: "Desktop application, separate from the OpenCode server.", side: "frontend", members: ["desktop"], x: 35, y: 585, width: 230, height: 185 },
  { id: "openchamber", kind: "process", label: "PROCESS", title: "OpenChamber", detail: "Frontend process. Attaches to the shared OpenCode service only through the frontend health gate; attachment is not independently observed.", side: "frontend", members: ["openchamber"], x: 35, y: 330, width: 230, height: 185 },
  { id: "opencode", kind: "process", label: "PROCESS", title: "OpenCode server", detail: "The DeltaRelay plugin is loaded inside the OpenCode server process, not a separate process.", side: "backend", members: ["opencode", "plugin"], x: 285, y: 330, width: 460, height: 185 },
  { id: "gateway", kind: "process", label: "PROCESS", title: "Local gateway", detail: "Local authenticated HTTP gateway process.", side: "backend", members: ["gateway"], x: 775, y: 330, width: 230, height: 185 },
  { id: "gate", kind: "process", label: "PROCESS", title: "Frontend health gate", detail: "Supervised loopback health gate. It never owns or restarts the shared OpenCode service.", side: "backend", members: ["gate"], x: 285, y: 130, width: 225, height: 185 },
  { id: "network", kind: "network", label: "NETWORK · NOT A PROCESS", title: "Internet / interfaces", detail: "Interfaces, routes and connectivity are prerequisites, not a relay process.", members: ["network"], x: 520, y: 585, width: 230, height: 185 },
  { id: "tunnel", ...transportBoundary(), side: "backend", members: ["tunnel"], x: 775, y: 585, width: 230, height: 185 },
  { id: "relay", kind: "process", label: "PROCESS + OWNED FILES", title: "DeltaRelay relay", detail: "The relay owns a request chunk cache and a separate durable response mailbox. Provider bytes are checksummed and persisted before delivery. The PC fetches saved responses through the relay by byte offset, including after reconnecting. Streaming alone does not delete payloads; explicit ACK or retention expiry does. Files survive restarts; neither store is a separate forwarding service.", note: "Owned files survive restarts", side: "backend", members: ["relay", "storage", "mailbox"], x: 1070, y: 310, width: 460, height: 410 },
  { id: "provider", kind: "external", label: "EXTERNAL SERVICE", title: "Model provider API", detail: "External API, outside the relay process and remote host. Its internal processes are not observed.", members: ["provider"], x: 1185, y: 820, width: 230, height: 190 },
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

/** Distinct write/read lanes, with a label in each clear horizontal segment. */
export function storageFlow(target: "storage" | "mailbox", reverse = false): { path: string; labelX: number; labelY: number } {
  const relay = mapNodes.find((node) => node.id === "relay")!
  const store = mapNodes.find((node) => node.id === target)!
  const offset = reverse ? 16 : 0
  const relayX = relay.x + nodeWidth / 2 + (target === "storage" ? -48 : 48) + offset
  const storeX = store.x + nodeWidth / 2 - 16 + offset
  const relayY = relay.y + nodeHeight
  // Offset each return around the inside of its elbow, avoiding both a shared
  // stem and intersections between the two directions.
  const middle = (relayY + store.y) / 2 + (target === "storage" ? offset : -offset)
  return {
    path: reverse
      ? `M${storeX},${store.y} V${middle} H${relayX} V${relayY}`
      : `M${relayX},${relayY} V${middle} H${storeX} V${store.y}`,
    labelX: (relayX + storeX) / 2,
    labelY: middle - 5,
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
    // The gate sits in the top row: reach it from the right-hand bus and enter
    // its right edge, clear of the attach fan and the gateway check lane.
    if (target === "gate") return `M${a.x + nodeWidth},${ay} H1048 V285 H510 V275 H495`
    // OpenChamber is the second-row attach frontend; Desktop is the third-row
    // direct client. Enter the former from below and the latter from above.
    if (target === "openchamber") return `M${a.x + nodeWidth},${ay} H1048 V560 H150 V${b.y + nodeHeight}`
    if (target === "desktop") return `M${a.x + nodeWidth},${ay} H1048 V560 H150 V${b.y}`
    // A shared management lane between the second and third local component rows.
    if (target === "opencode" || target === "gateway") return `M${a.x + nodeWidth},${ay} H1048 V560 H${bx} V${b.y + nodeHeight}`
    if (target === "tunnel") return `M${a.x + nodeWidth},${ay} H890 V${b.y + nodeHeight}`
  }
  if (source === "vscode" && target === "gate") {
    // Both attach-only frontends feed the gate: Varro steps down from the row
    // above and OpenChamber steps up from the row below.
    return `M${a.x + nodeWidth},${a.y + nodeHeight / 2} L${b.x},${b.y + nodeHeight / 2}`
  }
  if (source === "desktop" && target === "opencode") {
    // Desktop keeps its direct server path as a diagonal below OpenChamber,
    // instead of sharing the attach frontends' lane.
    return `M${a.x + nodeWidth / 2},${a.y} L${b.x + 45},${b.y + nodeHeight}`
  }
  if (source === "gate" && target === "gateway") {
    // Health/check dependency, not a model-data hop: cross the open top row and
    // enter the gateway from above, clear of the plugin data link.
    return `M${a.x + nodeWidth},${ay} H840 V${b.y}`
  }
  if (source === "dashboard" && target === "gateway") {
    // Read-only diagnostics use the gateway API, independently of supervisor
    // controls. Reach it without implying a hop through networking or OpenCode.
    return `M${ax + 32},${a.y} V805 H1026 V540 H${bx} V${b.y + nodeHeight}`
  }
  if (source === "openchamber" && target === "gate") {
    // OpenChamber climbs into the gate from below-left, forming the second
    // diagonal of the attach fan.
    return `M${a.x + nodeWidth / 2},${a.y} L${b.x},${b.y + nodeHeight}`
  }
  if (source === "tunnel" && target === "relay") {
    // The relay is one row above the transport: climb the gap between the local
    // and remote regions instead of crossing the local cards.
    return `M${a.x + nodeWidth},${ay} H1038 V${by} H${b.x}`
  }
  if (source === "relay" && target === "provider") {
    // The provider sits below the remote column: leave by the right edge and
    // drop down the margin outside the relay's owned-files boundary.
    return `M${a.x + nodeWidth},${ay} H${mapWidth - 38} V${b.y + nodeHeight / 2} H${b.x + nodeWidth}`
  }
  if (source === "remote_provider" && (target === "remote" || target === "relay")) {
    return `M${a.x + nodeWidth},${ay} H1048 V${by} H${b.x}`
  }
  if (source === "relay" && (target === "storage" || target === "mailbox")) return storageFlow(target).path
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
  if (source === "relay" && (target === "storage" || target === "mailbox")) return storageFlow(target, true).path
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
    return `M${a.x + nodeWidth},${a.y + nodeHeight / 2 + lane} H${mapWidth - 22} V${b.y + nodeHeight / 2 - lane} H${b.x + nodeWidth}`
  }
  if (source === "vscode" && target === "gate") {
    // Return beside the attach diagonal, entering Varro from its right edge.
    return `M${a.x},${a.y + nodeHeight / 2 + lane} L${b.x + nodeWidth},${b.y + nodeHeight / 2 + lane}`
  }
  if (source === "desktop" && target === "opencode") {
    // Return beside the direct-to-server diagonal, clear of OpenChamber above.
    return `M${a.x + 45 + lane},${a.y + nodeHeight} L${b.x + nodeWidth / 2 + lane},${b.y}`
  }
  if (source === "openchamber" && target === "gate") {
    // Return from the gate's lower edge to the attached frontend.
    return `M${a.x + lane},${a.y + nodeHeight} L${b.x + nodeWidth / 2 + lane},${b.y}`
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
