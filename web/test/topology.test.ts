import test from "node:test"
import assert from "node:assert/strict"
import { edgeChannel, isTopology, nodePresentation, observationStale, type TopologyEdge } from "../src/lib/topology.js"
import { edgePath, mapBoundaries, mapHeight, mapNodes, mapRegions, mapWidth, nodeHeight, nodeWidth, transportBoundary } from "../src/lib/topology-layout.js"
import { readContract } from "./contracts.js"

test("shared topology validates bounded nodes, edges, ownership and action contracts", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  assert.equal(value.nodes.length, 14)
  const node = value.nodes[0]!
  for (const changed of [{ ...value, version: 2 }, { ...value, nodes: [...value.nodes, node] }, { ...value, nodes: [{ ...node, actions: ["shell"] }] }, { ...value, nodes: [{ ...node, owner: "arbitrary-process" }] }, { ...value, network: { generation: -1, changed_at: null } }, { ...value, edges: [{ ...value.edges[0], target: "arbitrary-process" }] }, { ...value, run: {} }]) {
    assert.equal(isTopology(changed), false)
  }
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
  assert.equal(observationStale({ ...node, checked_at: "2026-11-01T12:00:00Z" }, "2026-11-01T12:00:31Z"), true)
})

test("request-handling arrows are separate from checks and management, regardless of relation or readiness", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  assert.deepEqual(value.edges.filter((edge) => edgeChannel(edge) === "request").map((edge) => edge.id), [
    "desktop_opencode", "opencode_plugin", "plugin_gateway", "gateway_tunnel",
    "tunnel_relay", "relay_storage", "relay_provider",
  ])
  for (const id of ["dashboard_ui_dashboard", "network_tunnel", "remote_relay", "dashboard_supervisor", "remote_provider_relay"]) {
    const edge: TopologyEdge = value.edges.find((item) => item.id === id)!
    assert.equal(edgeChannel(edge), "control", id)
    assert.equal(edgeChannel({ ...edge, state: "blocked" }), "control", `${id} when blocked`)
  }
  const relay = value.edges.find((edge) => edge.id === "tunnel_relay")!
  assert.equal(edgeChannel({ ...relay, state: "not_ready" }), "request")
})

test("every process boundary encloses exactly its runtime and owned components, with room for its heading", () => {
  assert.deepEqual(Object.fromEntries(mapBoundaries.filter((boundary) => boundary.kind === "process").map((boundary) => [boundary.id, boundary.members])), {
    desktop: ["desktop"], opencode: ["opencode", "plugin"], gateway: ["gateway"], relay: ["relay", "storage"],
    dashboard_ui: ["dashboard_ui"], dashboard: ["dashboard"], supervisor: ["supervisor"], remote_provider: ["remote_provider"],
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
  assert.deepEqual(inHost.map((node) => node.id), ["remote", "relay", "storage"])
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
  for (const [source, target] of [["desktop", "opencode"], ["opencode", "desktop"], ["relay", "storage"], ["storage", "relay"]] as const) {
    const a = mapNodes.find((node) => node.id === source)!, b = mapNodes.find((node) => node.id === target)!
    const expected = a.y === b.y
      ? `M${a.x + (a.x < b.x ? nodeWidth : 0)},${a.y + nodeHeight / 2} H${b.x + (a.x > b.x ? nodeWidth : 0)}`
      : `M${a.x + nodeWidth / 2},${a.y + (a.y < b.y ? nodeHeight : 0)} V${b.y + (a.y > b.y ? nodeHeight : 0)}`
    assert.equal(edgePath(source, target), expected, `${source} → ${target}`)
  }
})

test("map arrows never cross unrelated component cards or process boundaries", () => {
  const value = readContract("topology-v1.json")
  assert.ok(isTopology(value))
  type Point = { x: number; y: number }
  const crosses = (a: Point, b: Point, rect: { x: number; y: number; width: number; height: number }) => a.x === b.x
    ? a.x > rect.x && a.x < rect.x + rect.width && Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < rect.y + rect.height
    : a.y > rect.y && a.y < rect.y + rect.height && Math.max(a.x, b.x) > rect.x && Math.min(a.x, b.x) < rect.x + rect.width
  for (const edge of value.edges) {
    let previous: Point = { x: 0, y: 0 }
    for (const command of edgePath(edge.source, edge.target).matchAll(/([MHV])([\d.]+)(?:,([\d.]+))?/g)) {
      const point = { x: command[1] === "V" ? previous.x : Number(command[2]), y: command[1] === "M" ? Number(command[3]) : command[1] === "V" ? Number(command[2]) : previous.y }
      if (command[1] !== "M") {
        for (const node of mapNodes.filter((node) => node.id !== edge.source && node.id !== edge.target)) {
          assert.equal(crosses(previous, point, { ...node, width: nodeWidth, height: nodeHeight }), false, `${edge.id} crosses ${node.id}`)
        }
        for (const boundary of mapBoundaries.filter((boundary) => !boundary.members.includes(edge.source) && !boundary.members.includes(edge.target))) {
          assert.equal(crosses(previous, point, boundary), false, `${edge.id} crosses ${boundary.id} boundary`)
        }
      }
      previous = point
    }
  }
})
