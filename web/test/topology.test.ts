import test from "node:test"
import assert from "node:assert/strict"
import { edgeChannel, edgeDescription, isTopology, nodePresentation, observationStale, type NodeID, type TopologyEdge } from "../src/lib/topology.js"
import { architectureEdges, architectureLanes } from "../src/lib/topology-flow.js"
import { edgePath, mapBoundaries, mapHeight, mapLayerSegments, mapNodes, mapRegions, mapWidth, nodeHeight, nodeWidth, responsePath, storageFlow, transportBoundary } from "../src/lib/topology-layout.js"
import { readContract } from "./contracts.js"

type Point = { x: number; y: number }

function pathPoints(path: string): Point[] {
  let point: Point = { x: 0, y: 0 }
  const points: Point[] = []
  for (const [, type, first, second] of path.matchAll(/([MHVL])(-?[\d.]+)(?:,(-?[\d.]+))?/g)) {
    point = {
      x: type === "V" ? point.x : Number(first),
      y: type === "H" ? point.y : Number(type === "M" || type === "L" ? second : first),
    }
    points.push(point)
  }
  assert.ok(points.length >= 2, `an arrow has a start and an end: ${path}`)
  return points
}

function onNodeBorder(point: Point, id: NodeID): boolean {
  const node = mapNodes.find((node) => node.id === id)!
  return point.x >= node.x && point.x <= node.x + nodeWidth && point.y >= node.y && point.y <= node.y + nodeHeight
    && (point.x === node.x || point.x === node.x + nodeWidth || point.y === node.y || point.y === node.y + nodeHeight)
}

test("shared topology validates bounded nodes, edges, ownership and action contracts", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  assert.equal(value.nodes.length, 18)
  const node = value.nodes[0]!
  for (const changed of [{ ...value, version: 2 }, { ...value, nodes: [...value.nodes, node] }, { ...value, nodes: [{ ...node, actions: ["shell"] }] }, { ...value, nodes: [{ ...node, owner: "arbitrary-process" }] }, { ...value, network: { generation: -1, changed_at: null } }, { ...value, edges: [{ ...value.edges[0], target: "arbitrary-process" }] }, { ...value, run: {} }]) {
    assert.equal(isTopology(changed), false)
  }
  assert.equal(isTopology({ ...value, nodes: value.nodes.map((item) => item.id === "vscode" ? { ...item, actions: ["open"] } : item) }), true, "the editor may offer only the one-shot open action")
  assert.equal(isTopology({ ...value, nodes: [{ ...node, detail: "<img src=x>" }], edges: [], shutdown_blockers: [] }), true, "plain text is safe to render as text")
})

test("process existence is distinct from readiness, active work and stale evidence", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  const node = value.nodes.find((node) => node.id === "gateway")!
  assert.equal(nodePresentation(node, false).tone, "good")
  assert.equal(nodePresentation({ ...node, readiness: "unknown" }, false).label, "Running · unverified")
  assert.equal(nodePresentation({ ...node, lifecycle: "started", readiness: "unknown" }, false).label, "Running · unverified")
  assert.equal(nodePresentation({ ...node, activity: "recover" }, false).tone, "working")
  assert.equal(nodePresentation(node, true).label, "Stale")
  assert.equal(nodePresentation({ ...node, desired: "stopped" }, false).tone, "neutral")
  assert.equal(nodePresentation({ ...node, owner: "user", lifecycle: "unmanaged", desired: "external", readiness: "unknown" }, false).label, "Not observed")
  assert.equal(nodePresentation({ ...node, lifecycle: "unmanaged", readiness: "unknown" }, false).label, "Not configured")
  assert.equal(observationStale({ ...node, checked_at: "2026-11-01T12:00:00Z" }, "2026-11-01T12:00:31Z"), true)
})

test("request-handling arrows are separate from checks and management, regardless of relation or readiness", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  assert.deepEqual(value.edges.filter((edge) => edgeChannel(edge) === "request").map((edge) => edge.id), [
    "vscode_gate", "openchamber_gate", "gate_opencode", "desktop_opencode", "opencode_plugin",
    "plugin_gateway", "gateway_tunnel", "tunnel_relay", "relay_provider",
  ])
  for (const id of ["gate_gateway", "supervisor_gate", "supervisor_openchamber", "dashboard_ui_dashboard", "tunnel_network", "remote_relay", "relay_storage", "relay_mailbox", "dashboard_gateway", "dashboard_opencode", "dashboard_supervisor", "remote_provider_relay"]) {
    const edge: TopologyEdge = value.edges.find((item) => item.id === id)!
    assert.equal(edgeChannel(edge), "control", id)
    assert.equal(edgeChannel({ ...edge, state: "blocked" }), "control", `${id} when blocked`)
  }
  const relay = value.edges.find((edge) => edge.id === "tunnel_relay")!
  assert.equal(edgeChannel({ ...relay, state: "not_ready" }), "request")
})

test("storage ownership and read-only diagnostics do not imply additional model forwarding hops", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  const storage = value.edges.find((edge) => edge.id === "relay_storage")!
  assert.equal(storage.relation, "contains")
  assert.equal(value.nodes.find((node) => node.id === storage.target)!.owner, storage.source)
  assert.equal(edgeDescription(storage), "Storage ownership / read-write access")
  assert.match(storage.protocol, /request chunk cache.*read \/ write/)
  for (const id of ["dashboard_gateway", "dashboard_opencode"]) {
    const edge: TopologyEdge = value.edges.find((item) => item.id === id)!
    assert.equal(edge.source, "dashboard")
    assert.equal(edge.relation, "traffic")
    assert.equal(edgeChannel(edge), "control")
    assert.equal(edgeDescription(edge), "Read-only diagnostics")
  }
  assert.match(value.edges.find((edge) => edge.id === "dashboard_opencode")!.protocol, /Optional read-only/)
  assert.deepEqual(value.edges.filter((edge) => edge.relation === "requires").map((edge) => [edge.source, edge.target]), [
    ["gate", "gateway"], ["tunnel", "network"],
  ], "dependency arrows point from dependent to prerequisite")
})

test("the remote mailbox supplies saved bytes through its owning relay without becoming a request hop", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  const mailbox = value.nodes.find((node) => node.id === "mailbox")!
  assert.deepEqual([mailbox.label, mailbox.kind, mailbox.group, mailbox.owner, mailbox.managed, mailbox.actions], ["Response mailbox", "storage", "remote", "relay", false, []])
  const related = value.edges.filter((edge) => edge.source === "mailbox" || edge.target === "mailbox")
  assert.equal(related.length, 1, "neither the PC nor the provider accesses the mailbox directly")
  const edge = related[0]!
  assert.deepEqual([edge.id, edge.source, edge.target, edge.relation], ["relay_mailbox", "relay", "mailbox", "contains"])
  assert.equal(edgeChannel(edge), "control", "ownership is not an additional provider request hop")
  assert.equal(edgeDescription(edge), "Response mailbox ownership / read-write access")
  assert.deepEqual(architectureLanes(edge).map((lane) => [lane.channel, lane.reverse, lane.label]), [
    ["response", false, "Write"], ["response", true, "Read"],
  ], "both mailbox directions belong to response flow, not management")
  assert.deepEqual(architectureLanes(value.edges.find((edge) => edge.id === "relay_storage")!).map((lane) => [lane.channel, lane.reverse, lane.label]), [
    ["request", false, "Write"], ["request", true, "Read"],
  ], "cached request bytes are read back without becoming provider responses")
  assert.match(edge.protocol, /Persist checksummed frames.*read by offset.*ACK \/ expiry/)
  assert.match(mailbox.detail, /PC is disconnected.*through the relay by byte offset.*Streaming alone does not delete.*tombstones remain/)
  const legacy = { ...value, nodes: value.nodes.filter((node) => node.id !== "mailbox"), edges: value.edges.filter((edge) => edge.id !== "relay_mailbox") }
  assert.equal(isTopology(legacy), true, "older topology v1 snapshots still validate")
})

test("storage architecture survives older or absent observations without inventing readiness or duplicate edges", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  const legacy = value.edges.filter((edge) => edge.id !== "relay_mailbox").map((edge) => edge.id === "relay_storage" ? { ...edge, protocol: "Durable relay data", state: "ready" as const } : edge)
  const original = JSON.stringify(legacy)
  const edges = architectureEdges(legacy)
  assert.equal(JSON.stringify(legacy), original, "reported observations are not mutated")
  assert.equal(new Set(edges.map((edge) => edge.id)).size, edges.length)
  assert.equal(edges.find((edge) => edge.id === "relay_storage")!.state, "ready", "independent evidence is preserved")
  assert.equal(edges.find((edge) => edge.id === "relay_mailbox")!.state, "unknown", "structural ownership is not readiness proof")
  assert.match(edges.find((edge) => edge.id === "relay_storage")!.protocol, /request chunk cache/)
  assert.deepEqual(architectureEdges(edges), edges, "normalization is idempotent")
  assert.deepEqual(architectureEdges().map((edge) => [edge.id, edge.state]), [
    ["relay_storage", "unknown"], ["relay_mailbox", "unknown"],
  ])
})

test("every displayed arrow reaches the appropriate component border, including both storage directions", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  for (const edge of architectureEdges(value.edges)) {
    for (const lane of architectureLanes(edge)) {
      const points = pathPoints(lane.reverse ? responsePath(edge.source, edge.target) : edgePath(edge.source, edge.target))
      assert.ok(onNodeBorder(points[0]!, lane.reverse ? edge.target : edge.source), `${lane.id}: starts at source`)
      assert.ok(onNodeBorder(points.at(-1)!, lane.reverse ? edge.source : edge.target), `${lane.id}: arrowhead reaches target`)
    }
  }
})

test("cache and mailbox write/read lanes never overlap or intersect and have separate visible labels", () => {
  const all = (["storage", "mailbox"] as const).flatMap((target) => [false, true].map((reverse) => {
    const flow = storageFlow(target, reverse)
    const points = pathPoints(flow.path)
    assert.ok(flow.labelX > Math.min(points[1]!.x, points[2]!.x) && flow.labelX < Math.max(points[1]!.x, points[2]!.x))
    assert.equal(flow.labelY, points[1]!.y - 5)
    return { id: `${target}-${reverse ? "read" : "write"}`, points }
  }))
  for (let left = 0; left < all.length; left++) {
    for (let right = left + 1; right < all.length; right++) {
      const a = all[left]!, b = all[right]!
      for (let i = 1; i < a.points.length; i++) {
        for (let j = 1; j < b.points.length; j++) {
          const a0 = a.points[i - 1]!, a1 = a.points[i]!, b0 = b.points[j - 1]!, b1 = b.points[j]!
          const intersects = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)) <= Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x))
            && Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)) <= Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y))
          assert.equal(intersects, false, `${a.id} intersects ${b.id}`)
        }
      }
    }
  }
})

test("every process boundary encloses exactly its runtime and owned components, with room for its heading", () => {
  assert.deepEqual(Object.fromEntries(mapBoundaries.filter((boundary) => boundary.kind === "process").map((boundary) => [boundary.id, boundary.members])), {
    vscode: ["vscode"], desktop: ["desktop"], openchamber: ["openchamber"], opencode: ["opencode", "plugin"], gateway: ["gateway"],
    gate: ["gate"], relay: ["relay", "storage", "mailbox"], dashboard_ui: ["dashboard_ui"], dashboard: ["dashboard"],
    supervisor: ["supervisor"], remote_provider: ["remote_provider"],
  })
  for (const boundary of mapBoundaries) {
    assert.ok(boundary.x >= 0 && boundary.y >= 0 && boundary.x + boundary.width <= mapWidth && boundary.y + boundary.height <= mapHeight, boundary.id)
    const enclosed = mapNodes.filter((node) => node.x >= boundary.x && node.y >= boundary.y && node.x + nodeWidth <= boundary.x + boundary.width && node.y + nodeHeight <= boundary.y + boundary.height)
    assert.deepEqual(enclosed.map((node) => node.id), boundary.members, boundary.id)
    for (const node of enclosed) {
      assert.ok(node.x >= boundary.x + 15 && node.x + nodeWidth <= boundary.x + boundary.width - 15, `${node.id}: horizontal padding`)
      assert.ok(node.y >= boundary.y + 60 && node.y + nodeHeight <= boundary.y + boundary.height - 15, `${node.id}: heading and bottom padding`)
    }
  }
  for (const node of mapNodes) {
    assert.equal(mapBoundaries.filter((boundary) => boundary.members.includes(node.id)).length, node.id === "remote" ? 0 : 1, `${node.id}: one owning boundary`)
  }
  const host = mapRegions.find((region) => region.id === "remote")!
  const inHost = mapNodes.filter((node) => node.x >= host.x && node.y >= host.y && node.x + nodeWidth <= host.x + host.width && node.y + nodeHeight <= host.y + host.height)
  assert.deepEqual(inHost.map((node) => node.id), ["remote", "relay", "storage", "mailbox"])
})

test("transport boundaries describe configured processes versus paths, not readiness or manageability", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  const tunnel = value.nodes.find((node) => node.id === "tunnel")!
  assert.equal(transportBoundary(tunnel).kind, "process")
  assert.equal(transportBoundary({ ...tunnel, managed: false, lifecycle: "stopped", readiness: "unknown", actions: [] }).kind, "process")
  const direct = transportBoundary({ ...tunnel, label: "Direct HTTPS / transport", managed: false, actions: [] })
  assert.equal(direct.kind, "path")
  assert.equal(direct.title, "Direct HTTPS")
  assert.match(direct.detail, /no separate tunnel process/)
  assert.equal(transportBoundary().kind, "transport")
  assert.equal(transportBoundary({ ...tunnel, label: "Connection transport" }).kind, "transport")
})

test("aligned connection arrows attach to the facing sides in both directions", () => {
  for (const [source, target] of [["gate", "opencode"], ["opencode", "gate"], ["remote", "relay"], ["relay", "remote"]] as const) {
    const a = mapNodes.find((node) => node.id === source)!, b = mapNodes.find((node) => node.id === target)!
    const expected = a.y === b.y
      ? `M${a.x + (a.x < b.x ? nodeWidth : 0)},${a.y + nodeHeight / 2} H${b.x + (a.x > b.x ? nodeWidth : 0)}`
      : `M${a.x + nodeWidth / 2},${a.y + (a.y < b.y ? nodeHeight : 0)} V${b.y + (a.y > b.y ? nodeHeight : 0)}`
    assert.equal(edgePath(source, target), expected, `${source} → ${target}`)
  }
})

test("process boundaries carry the frontend or backend side used by the legend", () => {
  assert.deepEqual(mapBoundaries.filter((boundary) => boundary.side === "frontend").map((boundary) => boundary.id), ["vscode", "desktop", "openchamber", "dashboard_ui"])
  assert.deepEqual(mapBoundaries.filter((boundary) => boundary.side === "backend").map((boundary) => boundary.id), ["opencode", "gateway", "gate", "tunnel", "relay", "dashboard", "supervisor", "remote_provider"])
  for (const boundary of mapBoundaries.filter((boundary) => boundary.kind === "process")) assert.ok(boundary.side, `${boundary.id}: process side`)
  for (const id of ["network", "provider"]) assert.equal(mapBoundaries.find((boundary) => boundary.id === id)!.side, undefined, `${id}: not a frontend/backend process`)
})

test("OpenChamber is a supervised frontend that attaches only through the shared frontend gate", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  const node = value.nodes.find((item) => item.id === "openchamber")!
  assert.equal(node.label, "OpenChamber")
  assert.equal(node.kind, "app")
  assert.equal(node.group, "local")
  assert.equal(node.owner, "supervisor")
  const attach = value.edges.find((item) => item.id === "openchamber_gate")!
  assert.deepEqual([attach.source, attach.target, attach.relation, attach.protocol], ["openchamber", "gate", "traffic", "Attach-only local HTTP"])
  assert.equal(edgeChannel(attach), "request")
  const manage = value.edges.find((item) => item.id === "supervisor_openchamber")!
  assert.deepEqual([manage.source, manage.target, manage.relation, manage.protocol], ["supervisor", "openchamber", "manages", "Configured lifecycle"])
  assert.equal(edgeChannel(manage), "control")

  const mapped = mapNodes.find((item) => item.id === "openchamber")!
  assert.deepEqual(mapped, { id: "openchamber", label: "OpenChamber", icon: "openchamber", role: "App", x: 55, y: 390 })
  const boundary = mapBoundaries.find((item) => item.id === "openchamber")!
  assert.equal(boundary.kind, "process")
  assert.equal(boundary.side, "frontend")
  assert.deepEqual(boundary.members, ["openchamber"])
  assert.match(boundary.detail, /shared OpenCode service only through the frontend health gate.*not independently observed/)
})

test("frontend divider only spans rows where a frontend sits beside a backend", () => {
  const dividerX = 275
  for (const segment of mapLayerSegments) {
    const row = mapBoundaries.filter((boundary) => boundary.y < segment.y2 && boundary.y + boundary.height > segment.y1)
    assert.ok(row.some((boundary) => boundary.x + boundary.width <= dividerX), `${segment.y1}: frontend side`)
    assert.ok(row.some((boundary) => boundary.x >= dividerX), `${segment.y1}: backend side`)
  }
  for (const boundary of mapBoundaries.filter((boundary) => boundary.x + boundary.width <= dividerX)) {
    assert.ok(mapLayerSegments.some((segment) => segment.y1 <= boundary.y && segment.y2 >= boundary.y + boundary.height), `${boundary.id}: covered by a divider segment`)
  }
  for (const region of mapRegions) {
    const label = region.y + 28
    assert.ok(mapLayerSegments.every((segment) => label < segment.y1 || label > segment.y2), `${region.id}: region title stays clear of the divider`)
  }
  for (let index = 1; index < mapLayerSegments.length; index++) {
    assert.ok(mapLayerSegments[index - 1]!.y2 < mapLayerSegments[index]!.y1, "divider segments stay separate")
  }
})

test("reflowed map keeps every node, region and routed lane inside its bounds without card overlap", () => {
  for (const node of mapNodes) {
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + nodeWidth <= mapWidth && node.y + nodeHeight <= mapHeight, node.id)
  }
  for (let left = 0; left < mapNodes.length; left++) {
    for (let right = left + 1; right < mapNodes.length; right++) {
      const a = mapNodes[left]!, b = mapNodes[right]!
      const overlap = a.x < b.x + nodeWidth && a.x + nodeWidth > b.x && a.y < b.y + nodeHeight && a.y + nodeHeight > b.y
      assert.equal(overlap, false, `${a.id} overlaps ${b.id}`)
    }
  }
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  for (const edge of value.edges) {
    for (const command of edgePath(edge.source, edge.target).matchAll(/([MHVL])([\d.]+)(?:,([\d.]+))?/g)) {
      const type = command[1]
      const x = type === "V" ? null : Number(command[2])
      const y = type === "H" ? null : Number(type === "M" || type === "L" ? command[3] : command[2])
      if (x !== null) assert.ok(x >= 0 && x <= mapWidth, `${edge.id} x=${x}`)
      if (y !== null) assert.ok(y >= 0 && y <= mapHeight, `${edge.id} y=${y}`)
    }
  }
  assert.equal(edgePath("vscode", "gate"), `M${55 + nodeWidth},${130 + nodeHeight / 2} L305,${190 + nodeHeight / 2}`)
  assert.equal(edgePath("gate", "opencode"), `M${305 + nodeWidth / 2},${190 + nodeHeight} V390`)
  assert.equal(edgePath("gate", "gateway"), `M${305 + nodeWidth},${190 + nodeHeight / 2} H840 V390`)
  assert.equal(edgePath("supervisor", "gate"), `M${555 + nodeWidth},${930 + nodeHeight / 2} H1048 V285 H510 V275 H495`)
  assert.equal(edgePath("supervisor", "openchamber"), `M${555 + nodeWidth},${930 + nodeHeight / 2} H1048 V560 H150 V${390 + nodeHeight}`)
  assert.equal(edgePath("supervisor", "desktop"), `M${555 + nodeWidth},${930 + nodeHeight / 2} H1048 V560 H150 V645`)
  assert.equal(edgePath("openchamber", "gate"), `M${55 + nodeWidth / 2},390 L305,${190 + nodeHeight}`)
  assert.equal(edgePath("desktop", "opencode"), `M${55 + nodeWidth / 2},645 L${305 + 45},${390 + nodeHeight}`)
  assert.equal(responsePath("vscode", "gate"), `M305,${190 + nodeHeight / 2 + 16} L${55 + nodeWidth},${130 + nodeHeight / 2 + 16}`)
  assert.equal(responsePath("openchamber", "gate"), `M${305 + 16},${190 + nodeHeight} L${55 + nodeWidth / 2 + 16},390`)
  assert.equal(responsePath("desktop", "opencode"), `M${305 + 45 + 16},${390 + nodeHeight} L${55 + nodeWidth / 2 + 16},645`)
})

test("map arrows never cross unrelated component cards or process boundaries", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  // Liang–Barsky segment/AABB clip; touching an edge counts as crossing, while
  // source and target boundaries are filtered out below.
  const crosses = (a: Point, b: Point, rect: { x: number; y: number; width: number; height: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y
    const p = [-dx, dx, -dy, dy]
    const q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y]
    let t0 = 0, t1 = 1
    for (let index = 0; index < 4; index++) {
      if (p[index] === 0) {
        if (q[index]! < 0) return false
      } else {
        const t = q[index]! / p[index]!
        if (p[index]! < 0) {
          if (t > t1) return false
          if (t > t0) t0 = t
        } else {
          if (t < t0) return false
          if (t < t1) t1 = t
        }
      }
    }
    return true
  }
  for (const edge of architectureEdges(value.edges)) {
    const paths = architectureLanes(edge).map((lane) => lane.reverse ? responsePath(edge.source, edge.target) : edgePath(edge.source, edge.target))
    for (const path of paths) {
      const points = pathPoints(path)
      for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1]!, point = points[index]!
        for (const node of mapNodes.filter((node) => node.id !== edge.source && node.id !== edge.target)) {
          assert.equal(crosses(previous, point, { ...node, width: nodeWidth, height: nodeHeight }), false, `${edge.id} crosses ${node.id}`)
        }
        for (const boundary of mapBoundaries.filter((boundary) => !boundary.members.includes(edge.source) && !boundary.members.includes(edge.target))) {
          assert.equal(crosses(previous, point, boundary), false, `${edge.id} crosses ${boundary.id} boundary`)
        }
      }
    }
  }
})
