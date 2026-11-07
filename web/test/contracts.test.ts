import test from "node:test"
import assert from "node:assert/strict"
import { isSnapshot } from "../src/lib/api.js"
import { isSystemStatus } from "../src/lib/system.js"
import { savings } from "../src/lib/metrics.js"
import { contractCases, contractPayload, readContract } from "./contracts.js"

for (const [file, fallback, guard] of [
  ["dashboard-cases.json", "dashboard-v1.json", isSnapshot],
  ["system-cases.json", "system-v2.json", isSystemStatus],
] as const) {
  for (const c of contractCases(file)) {
    test(`${file}: ${c.name}`, () => {
      assert.equal(guard(contractPayload(c, fallback)), c.valid)
    })
  }
}

test("all declared required fields and numeric counters are checked, not just displayed fields", () => {
  for (const [file, guard] of [["dashboard-v1.json", isSnapshot], ["system-v2.json", isSystemStatus]] as const) {
    const original = readContract(file)
    const visit = (node: unknown, path: string[] = []) => {
      if (node === null || typeof node !== "object") return
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(node)) { visit(value, [...path, key]); continue }
        const field = [...path, key].join(".")
        const optional = ["topology", "last_error", "error_code", "control_error", "finished_at", "last_seen", "expires_at", "checked_at", "error"].includes(key) &&
          field !== "recovery.last_error"
        if (!optional) assert.equal(guard(contractPayload({ name: field, valid: false, fixture: file, changes: [{ path: field, remove: true }] }, file)), false, `missing ${field}`)
        if (typeof value === "number") {
          for (const invalid of [-1, 0.5, "0", null, false, NaN, Infinity]) {
            const candidate = structuredClone(original) as Record<string, unknown>
            let parent = candidate
            for (const part of path) parent = parent[part] as Record<string, unknown>
            parent[key] = invalid
            assert.equal(guard(candidate), false, `${field} = ${String(invalid)}`)
          }
        }
        visit(value, [...path, key])
      }
    }
    visit(original)
  }
})

test("diagnostics without required traffic aggregates are rejected", () => {
  const incomplete = structuredClone(readContract("dashboard-v1.json")) as { history: Record<string, unknown> }
  delete incomplete.history.traffic
  assert.equal(isSnapshot(incomplete), false)
})

test("encoded overhead is not a negative wire counter", () => {
  const current = readContract("system-v2.json")
  assert.ok(isSystemStatus(current))
  const dashboard = readContract("dashboard-v1.json")
  assert.ok(isSnapshot(dashboard))
  assert.equal(savings(dashboard.history.totals.body_bytes, dashboard.history.totals.encoded_upload_bytes), -50)
})
