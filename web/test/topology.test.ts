import test from "node:test"
import assert from "node:assert/strict"
import { isTopology, nodePresentation, observationStale } from "../src/lib/topology.js"
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
