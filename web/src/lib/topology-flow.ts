import { edgeChannel, edgeDescription, type TopologyEdge } from "./topology.js"

// These are fixed file-ownership relationships, not readiness observations.
// Older supervisors report one combined store, or omit the mailbox entirely.
const ownedStorageEdges: readonly TopologyEdge[] = [
  { id: "relay_storage", source: "relay", target: "storage", relation: "contains", protocol: "Owned request chunk cache (read / write)", state: "unknown" },
  { id: "relay_mailbox", source: "relay", target: "mailbox", relation: "contains", protocol: "Persist checksummed frames; read by offset; release on ACK / expiry", state: "unknown" },
]

export function architectureEdges(reported: readonly TopologyEdge[] = []): TopologyEdge[] {
  return [
    ...reported.filter((edge) => !ownedStorageEdges.some((storage) => storage.id === edge.id)),
    ...ownedStorageEdges.map((edge) => ({ ...edge, state: reported.find((item) => item.id === edge.id)?.state ?? "unknown" })),
  ]
}

export interface MapLane {
  id: string
  channel: "request" | "response" | "control"
  reverse: boolean
  description: string
  label?: "Write" | "Read"
}

export function architectureLanes(edge: TopologyEdge): MapLane[] {
  // Ownership is already shown by the relay boundary. Draw the actual storage
  // writes and reads in their data channels, not as optional management arrows.
  if (edge.id === "relay_storage") return [
    { id: edge.id, channel: "request", reverse: false, label: "Write", description: "Request chunk cache write · relay → storage: Store verified uploaded chunks for reuse." },
    { id: `${edge.id}_read`, channel: "request", reverse: true, label: "Read", description: "Request chunk cache read · storage → relay: Read verified cached chunks to reconstruct the provider request body, not a provider response." },
  ]
  if (edge.id === "relay_mailbox") return [
    { id: edge.id, channel: "response", reverse: false, label: "Write", description: "Persisted response frames · relay → mailbox: Write checksummed provider bytes before delivery; retain until explicit ACK or expiry." },
    { id: `${edge.id}_response`, channel: "response", reverse: true, label: "Read", description: "Saved response bytes · mailbox → relay: Read persisted frames for PC fetch / resume by byte offset. Streaming alone does not acknowledge or delete them." },
  ]
  const channel = edgeChannel(edge)
  const outgoing: MapLane = { id: edge.id, channel, reverse: false, description: `${edgeDescription(edge)} · ${edge.source} → ${edge.target}: ${edge.protocol}` }
  return channel === "request"
    ? [outgoing, { id: `${edge.id}_response`, channel: "response", reverse: true, description: `Response / stream · ${edge.target} → ${edge.source}: ${edge.protocol}` }]
    : [outgoing]
}
