import test from "node:test"
import assert from "node:assert/strict"
import { activeColumnFilterCount, compileSessionFilters, emptySessionFilters, filterSessionViews, isColumnFilterActive, parseByteSize, parseDateBound, readSessionFilters, sessionFilterParams } from "../src/lib/session-filters.js"
import { displaySessions, savings, type SessionView } from "../src/lib/metrics.js"
import { makeSnapshot } from "./fixture.js"

const now = Date.parse("2026-10-28T12:15:00Z")

function localDate(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

test("byte sizes accept decimal and binary units", () => {
  assert.equal(parseByteSize("1048576"), 1_048_576)
  assert.equal(parseByteSize("1 MiB"), 1_048_576)
  assert.equal(parseByteSize("1MiB"), 1_048_576)
  assert.equal(parseByteSize("1.5 MB"), 1_500_000)
  assert.equal(parseByteSize("500 KB"), 500_000)
  assert.equal(parseByteSize("1,5 GiB"), Math.round(1.5 * 1_073_741_824))
  assert.equal(parseByteSize("0 B"), 0)
  assert.equal(parseByteSize(""), null)
  assert.equal(parseByteSize("many"), null)
  assert.equal(parseByteSize("-1 MiB"), null)
  assert.equal(parseByteSize("1 lightyear"), null)
})

test("date bounds accept real calendar dates only", () => {
  assert.ok(parseDateBound("2026-10-28") !== null)
  assert.ok(parseDateBound("2026-02-29") === null)
  assert.ok(parseDateBound("2026-02-28") !== null)
  assert.ok(parseDateBound("not-a-date") === null)
  const start = parseDateBound("2026-10-28")!
  const end = parseDateBound("2026-10-28", true)!
  assert.equal(new Date(start).getHours(), 0)
  assert.equal(new Date(end).getHours(), 23)
  assert.ok(end > start)
})

test("column filters combine and match the retained session values", () => {
  const sessions = displaySessions(makeSnapshot(now))
  assert.equal(sessions.length, 6)
  const api = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), session: "API-REFACTOR" }))
  assert.deepEqual(api.map((session) => session.id), ["ses_a93f10_api-refactor"])

  const busiest = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), requestsMin: "13" }))
  assert.deepEqual(busiest.map((session) => session.id), ["ses_7fd82a_relay-dashboard"])

  const quiet = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), requestsMax: "12" }))
  assert.equal(quiet.length, 5)

  const bodies = sessions.map((session) => session.body_bytes).sort((left, right) => left - right)
  const median = bodies[3]!
  const original = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), originalMin: String(median) }))
  assert.ok(original.length > 0 && original.length < sessions.length)
  assert.ok(original.every((session) => session.body_bytes >= median))

  const uploaded = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), uploadedMax: "0" }))
  assert.equal(uploaded.length, 0)

  const reduction = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), reductionMin: "50" }))
  assert.ok(reduction.length > 0)
  assert.ok(reduction.every((session) => (savings(session.body_bytes, session.encoded_upload_bytes) ?? -1) >= 50))

  const today = localDate(now)
  const recent = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), activityFrom: today, activityTo: today }))
  assert.equal(recent.length, sessions.length)
  const impossible = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), activityFrom: localDate(now + 86_400_000), activityTo: localDate(now - 86_400_000) }))
  assert.equal(impossible.length, 0)
})

test("usage column filters match credential labels and token bounds", () => {
  const sessions = displaySessions(makeSnapshot(now))
  const personalID = "a".repeat(32)
  const workID = "b".repeat(32)
  const usage = new Map(sessions.map((session, index) => [session.id, {
    keyIDs: index < 3 ? [personalID] : [workID],
    unknownKeyRequests: index < 3 ? 0 : 1,
    inputTokens: index < 3 ? 1_000 + index : null,
    outputTokens: index < 3 ? 100 + index : null,
    contextTokens: index < 3 ? 900 + index : null,
  }]))
  const usageOf = (session: SessionView) => usage.get(session.id)

  const personal = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), key: personalID }), usageOf)
  assert.deepEqual(personal.map((session) => session.id), sessions.slice(0, 3).map((session) => session.id))
  const work = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), key: workID }), usageOf)
  assert.deepEqual(work.map((session) => session.id), sessions.slice(3).map((session) => session.id))
  const unknown = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), key: "unknown" }), usageOf)
  assert.deepEqual(unknown.map((session) => session.id), sessions.slice(3).map((session) => session.id))

  const input = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), inputMin: "1001", inputMax: "1002" }), usageOf)
  assert.deepEqual(input.map((session) => session.id), sessions.slice(1, 3).map((session) => session.id))
  const output = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), outputMax: "100" }), usageOf)
  assert.deepEqual(output.map((session) => session.id), [sessions[0]!.id])
  const context = filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), contextMin: "901" }), usageOf)
  assert.deepEqual(context.map((session) => session.id), sessions.slice(1, 3).map((session) => session.id))

  // Without measured usage, credential and token filters never invent a match.
  assert.equal(filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), key: personalID })).length, 0)
  assert.equal(filterSessionViews(sessions, compileSessionFilters({ ...emptySessionFilters(), inputMax: "999999" })).length, 0)
})

test("active column count ignores empty and invalid values", () => {
  const input = emptySessionFilters()
  assert.equal(activeColumnFilterCount(input), 0)
  assert.equal(isColumnFilterActive(input, "requests"), false)
  input.session = "relay"
  input.requestsMin = "3"
  input.originalMax = "1 GiB"
  input.reductionMin = "-20"
  input.activityFrom = "2026-10-01"
  assert.equal(activeColumnFilterCount(input), 5)
  input.requestsMax = "-1"
  input.originalMin = "not a size"
  assert.equal(activeColumnFilterCount(input), 5)
  assert.equal(isColumnFilterActive(input, "requests"), true, "one valid bound keeps the column active")
  input.key = "a".repeat(32)
  input.inputMin = "1000"
  input.outputMax = "2000"
  input.contextMin = "-1"
  assert.equal(activeColumnFilterCount(input), 8)
  assert.equal(isColumnFilterActive(input, "context"), false, "an invalid token bound does not activate the column")
})

test("session filter URL state round-trips and drops invalid values", () => {
  const keyID = "a".repeat(32)
  const input = { ...emptySessionFilters(), session: "relay", key: keyID, requestsMin: "10", originalMin: "1 MiB", uploadedMax: "500 KB", reductionMin: "-10", inputMin: "1000", outputMax: "2500", contextMin: "512", activityFrom: "2026-10-01", activityTo: "2026-10-28" }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(sessionFilterParams(input))) if (value !== null) params.set(key, value)
  assert.deepEqual(readSessionFilters(params), input)
  assert.equal(readSessionFilters(new URLSearchParams("key_id=unknown")).key, "unknown")

  const invalid = new URLSearchParams("sid=%20%20&key_id=not-a-credential&req_min=-1&orig_min=nope&up_max=1%20lightyear&in_min=-1&out_max=abc&act_from=2026-02-31")
  assert.deepEqual(readSessionFilters(invalid), emptySessionFilters())
  assert.equal(sessionFilterParams({ ...emptySessionFilters(), requestsMin: "-1" }).req_min, null)
  assert.equal(sessionFilterParams({ ...emptySessionFilters(), inputMin: "-1" }).in_min, null)
  assert.equal(sessionFilterParams({ ...emptySessionFilters(), key: "Personal Go" }).key_id, null)
})
