import test from "node:test"
import assert from "node:assert/strict"
import {
  catalogDays,
  catalogReduction,
  catalogSessions,
  catalogState,
  filterCatalogSessions,
  sessionDayKey,
  sessionDayLabel,
} from "../src/lib/session-catalog.js"
import { makeOpenCodeSessions, makeSnapshot } from "./fixture.js"

const now = Date.parse("2026-10-28T12:15:00Z")

test("catalog merges OpenCode titles with gateway measurements and keeps unmeasured sessions", () => {
  const snapshot = makeSnapshot(now)
  const catalog = makeOpenCodeSessions(now)
  const entries = catalogSessions(snapshot, catalog)
  assert.equal(entries.length, 10)
  const measured = entries.find((entry) => entry.id === snapshot.history.sessions[0]!.id)!
  assert.equal(measured.title, "Relay dashboard measurement")
  assert.equal(measured.gateway, snapshot.history.sessions[0])
  assert.equal(measured.project, "deltarelay")
  assert.equal(catalogState(measured), "active")
  assert.notEqual(catalogReduction(measured), null)
  const unmeasured = entries.find((entry) => entry.id === "ses_unmeasured_recent")!
  assert.equal(unmeasured.gateway, undefined)
  assert.equal(catalogState(unmeasured), "unmeasured")
  assert.equal(catalogReduction(unmeasured), null)
})

test("gateway-only sessions remain visible when OpenCode has no matching metadata", () => {
  const snapshot = makeSnapshot(now)
  snapshot.history.sessions.push({
    ...snapshot.history.sessions[0]!,
    id: "ses_gateway_only",
    upstream: "openai",
    requests: 1,
    active: 0,
    body_bytes: 100,
    encoded_upload_bytes: 40,
  })
  const entries = catalogSessions(snapshot, makeOpenCodeSessions(now))
  const gatewayOnly = entries.find((entry) => entry.id === "ses_gateway_only")!
  assert.equal(gatewayOnly.title, "")
  assert.equal(gatewayOnly.gateway?.upstream, "openai")
  assert.equal(catalogReduction(gatewayOnly), 60)
})

test("day counts and filters use local start dates and measurement availability", () => {
  const snapshot = makeSnapshot(now)
  const entries = catalogSessions(snapshot, makeOpenCodeSessions(now))
  const days = catalogDays(entries)
  assert.equal(days.length, 5)
  assert.equal(days[0]!.key, sessionDayKey(new Date(now - 24 * 3_600_000).toISOString()))
  assert.equal(days[0]!.count, 6)
  assert.equal(days[0]!.measured, 6)
  assert.equal(sessionDayLabel(new Date(now - 24 * 3_600_000).toISOString()), "27 Oct 2026")

  const oldDay = sessionDayKey(new Date(now - 72 * 3_600_000).toISOString())
  assert.deepEqual(filterCatalogSessions(entries, "", oldDay, "all").map((entry) => entry.id), ["ses_unmeasured_recent"])
  assert.equal(filterCatalogSessions(entries, "", "", "measured").length, 6)
  assert.deepEqual(filterCatalogSessions(entries, "Old migration", "", "all").map((entry) => entry.id), ["ses_unmeasured_older"])
  assert.deepEqual(filterCatalogSessions(entries, "ses_unmeasured_extra_one", "", "all").map((entry) => entry.id), ["ses_unmeasured_extra_one"])
})

test("empty catalog falls back to gateway sessions and empty snapshots keep a usable catalog", () => {
  const snapshot = makeSnapshot(now)
  const gatewayOnly = catalogSessions(snapshot, null)
  assert.equal(gatewayOnly.length, 6)
  assert.ok(gatewayOnly.every((entry) => entry.gateway && entry.title === ""))

  const catalogOnly = catalogSessions(null, makeOpenCodeSessions(now))
  assert.equal(catalogOnly.length, 10)
  assert.ok(catalogOnly.every((entry) => !entry.gateway))
  assert.equal(catalogDays(catalogOnly).length, 5)
})
