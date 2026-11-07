import type { NodeID } from "./topology.js"

// Stable layout, no client-side graph engine or external assets. The SVG and
// accessible HTML node buttons share the same coordinate system.
export const mapWidth = 1190
export const mapHeight = 900
export const nodeWidth = 190
export const nodeHeight = 110
export const mapNodes: { id: NodeID; label: string; icon: string; x: number; y: number }[] = [
  { id: "desktop", label: "OpenCode Desktop", icon: "desktop", x: 35, y: 70 },
  { id: "opencode", label: "OpenCode server", icon: "terminal", x: 265, y: 70 },
  { id: "plugin", label: "DeltaRelay plugin", icon: "plugin", x: 495, y: 70 },
  { id: "gateway", label: "Local gateway", icon: "shield", x: 725, y: 70 },
  { id: "network", label: "Internet / interfaces", icon: "globe", x: 495, y: 280 },
  { id: "tunnel", label: "Connection transport", icon: "link", x: 725, y: 280 },
  { id: "remote", label: "Remote host", icon: "system", x: 965, y: 70 },
  { id: "relay", label: "DeltaRelay relay", icon: "relay", x: 965, y: 280 },
  { id: "storage", label: "Cache / saved responses", icon: "storage", x: 965, y: 490 },
  { id: "provider", label: "Model provider", icon: "bolt", x: 725, y: 490 },
  { id: "dashboard_ui", label: "Dashboard browser", icon: "browser", x: 35, y: 540 },
  { id: "dashboard", label: "Dashboard service", icon: "overview", x: 265, y: 540 },
  { id: "supervisor", label: "Recovery supervisor", icon: "activity", x: 495, y: 540 },
  { id: "remote_provider", label: "Remote-host adapter", icon: "settings", x: 495, y: 730 },
]

export function edgePath(source: NodeID, target: NodeID): string {
  const a = mapNodes.find((node) => node.id === source)!
  const b = mapNodes.find((node) => node.id === target)!
  if (a.y === b.y) return `M${a.x + nodeWidth},${a.y + nodeHeight / 2} H${b.x}`
  if (a.x === b.x) return `M${a.x + nodeWidth / 2},${a.y + nodeHeight} V${b.y}`
  const ax = a.x + nodeWidth / 2, ay = a.y + nodeHeight / 2
  const bx = b.x + nodeWidth / 2, by = b.y + nodeHeight / 2
  const direction = by > ay ? 1 : -1
  const sy = ay + direction * nodeHeight / 2
  const ty = by - direction * nodeHeight / 2
  const middle = (sy + ty) / 2
  return `M${ax},${sy} V${middle} H${bx} V${ty}`
}
