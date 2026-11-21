import test from "node:test"
import assert from "node:assert/strict"
import { makeUsageSnapshot } from "./fixture.js"
import { compactTokens, usageFromSnapshot, isUsageReport, keySummary, matchesUsage } from "../src/lib/usage.js"
import { contextChart, requestUsageDetails } from "../src/lib/usage-presentation.js"
import { openPage, json } from "./browser.js"
import { startDashboard } from "../src/scripts/dashboard.js"

const now = Date.parse("2026-11-21T12:00:00Z")

test("key and start-time filtering only sum matching requests", () => {
  const snapshot = makeUsageSnapshot(now)
  const filter = {key:"a".repeat(32),start:now-6*3_600_000,end:now}
  const report = usageFromSnapshot(snapshot,filter)
  const requests = snapshot.history.recent_requests.filter((r) => matchesUsage(r,filter))
  assert.ok(isUsageReport(report))
  assert.equal(report.requests,requests.length)
  assert.equal(report.metrics.input_tokens,requests.reduce((sum,r) => sum+(r.usage?.input_tokens ?? 0),0))
  assert.equal(report.session_count,new Set(requests.map((r) => r.session_id)).size)
  assert.ok(report.sessions.every((s) => s.api_keys.length === 1 && s.api_keys[0]!.name === "Personal Go"))
  const empty = usageFromSnapshot(snapshot,{start:now+1,end:now+2})
  assert.equal(empty.metrics.input_tokens,null)
  assert.equal(empty.keys.length,2)
  const unknown = usageFromSnapshot(snapshot,{key:"unknown"})
  assert.equal(unknown.requests,4)
  assert.equal(unknown.metrics.input_tokens,null)
})

test("usage report validation rejects fractional, negative, and incomplete counters", () => {
  const report = usageFromSnapshot(makeUsageSnapshot(now),{})
  assert.ok(isUsageReport(report))
  const tooLarge = structuredClone(report)
  tooLarge.metrics.input_tokens = Number.MAX_SAFE_INTEGER + 1
  assert.equal(isUsageReport(tooLarge),false)
  const badKey = structuredClone(report)
  badKey.sessions[0]!.api_keys = [{id:"not-hex",name:"Private"}]
  assert.equal(isUsageReport(badKey),false)
  const duplicateNames = structuredClone(report)
  duplicateNames.sessions[0]!.api_keys = [{id:"a".repeat(32),name:"Personal Go"},{id:"b".repeat(32),name:"Work tools"}]
  duplicateNames.sessions[0]!.unknown_key_requests = 0
  assert.equal(keySummary(duplicateNames.sessions[0]!),"Personal Go +1")
})

test("bucketed usage series keeps model totals and treats missing counters as gaps", () => {
  const snapshot = makeUsageSnapshot(now)
  const filter = {start:now-24*3_600_000,end:now,bucket:3_600_000}
  const report = usageFromSnapshot(snapshot,filter)
  assert.ok(isUsageReport(report))
  const series = report.series!
  assert.equal(series.bucket_ms,3_600_000)
  assert.equal(series.points.length,24)
  assert.equal(series.points.reduce((sum,point) => sum+point.measured_requests,0),report.metrics.measured_requests)
  assert.equal(series.models.reduce((sum,model) => sum+model.requests,0),report.metrics.measured_requests)
  assert.equal(series.points.reduce((sum,point) => sum+(point.input_tokens ?? 0),0),report.metrics.input_tokens)
  assert.equal(series.models.reduce((sum,model) => sum+(model.input_tokens ?? 0),0),report.metrics.input_tokens)
  assert.ok(series.points.some((point) => point.input_tokens === null))
  const invalidBucket = structuredClone(report)
  invalidBucket.series!.bucket_ms = 0
  assert.equal(isUsageReport(invalidBucket),false)
  const invalidPoint = structuredClone(report)
  invalidPoint.series!.points[0]!.measured_requests = -1
  assert.equal(isUsageReport(invalidPoint),false)
  assert.equal(usageFromSnapshot(snapshot,{start:filter.start,end:filter.end}).series,undefined)
})

test("series groups the model tail into Other models and does not duplicate buckets", () => {
  const snapshot = makeUsageSnapshot(now)
  const selected = snapshot.history.recent_requests.filter((request) => request.state !== "running").slice(-7)
  snapshot.history.recent_requests = selected
  selected.forEach((request,index) => {
    request.started_at = new Date(now - (10-index)*60_000).toISOString()
    request.usage = {
      version:1,state:"complete",
      model:index === 6 ? "" : `model-${index}`,
      response_model:index === 6 ? "model-g" : `model-${index}`,
      input_tokens:700-index*100,output_tokens:70-index*10,
    }
  })
  const report = usageFromSnapshot(snapshot,{start:now-60*60_000,end:now,bucket:60*60_000})
  assert.ok(isUsageReport(report))
  const series = report.series!
  assert.deepEqual(series.models.map((model) => model.model),["model-0","model-1","model-2","model-3","model-4","Other models"])
  assert.equal(series.models[5]!.requests,2)
  assert.equal(series.models[5]!.input_tokens,300)
  assert.equal(series.points.length,1)
  assert.equal(series.points[0]!.requests,7)
  assert.equal(series.points[0]!.measured_requests,7)
})

test("request usage contains numeric metadata only and charts label their scope", () => {
  const request = makeUsageSnapshot(now).history.recent_requests[6]!
  request.api_key!.name = "<script>private</script>"
  const html = requestUsageDetails(request)
  assert.match(html,/&lt;script&gt;/)
  assert.doesNotMatch(html,/<script>/)
  assert.match(html,/Provider cache read/)
  assert.match(contextChart([request]),/data-context-point/)
  assert.match(contextChart([{...request,usage:undefined}]),/will appear/)
})

test("sessions keeps one table with usage columns and one combined inspector", async () => {
  const page = openPage("sessions")
  page.window.history.replaceState({}, "", "/sessions?range=last&last=30&unit=days")
  page.setFetch((url) => url.startsWith("/api/dashboard") ? json(makeUsageSnapshot(now)) : json({},404))
  const app = startDashboard(page.document,{autoStart:false})
  try {
    await app.refresh()
    const doc = page.document
    assert.equal(doc.querySelector("#session-transfer-view"),null)
    assert.equal(doc.querySelector("#usage-results"),null)
    assert.equal(doc.querySelector("#sessions-view-usage"),null)
    assert.equal(doc.querySelector("#sessions-view-transfer"),null)
    assert.equal(doc.querySelector<HTMLElement>("#session-table-scroll")!.hidden,false)
    assert.equal(doc.querySelector("#usage-requests")!.textContent,"73")
    assert.match(doc.querySelector("#usage-coverage")!.textContent!,/requests with token data/)
    assert.equal(doc.querySelector("#usage-key"),null)
    const expected = usageFromSnapshot(makeUsageSnapshot(now),{})
    assert.equal(doc.querySelector("#usage-requests")!.textContent, String(expected.requests))
    const expectedSession = expected.sessions[0]!
    const row = [...doc.querySelectorAll<HTMLElement>("#session-rows tr")].find((candidate) => candidate.querySelector(".session-name")!.textContent === expectedSession.id)!
    const cells = row.querySelectorAll("td")
    assert.equal(cells[3]!.textContent, keySummary(expectedSession))
    assert.equal(cells[8]!.textContent, compactTokens(expectedSession.metrics.input_tokens))
    assert.equal(cells[9]!.textContent, compactTokens(expectedSession.metrics.output_tokens))
    assert.equal(cells[10]!.textContent, compactTokens(expectedSession.metrics.latest_context))
    row.querySelector<HTMLButtonElement>(".session-name")!.click()
    const dialog = doc.querySelector<HTMLDialogElement>("#session-dialog")!
    assert.equal(dialog.open,true)
    assert.equal(doc.querySelector("#usage-session-dialog"),null)
    assert.equal(dialog.querySelector("#detail-title")!.textContent, expectedSession.id)
    const detail = doc.querySelector("#session-detail")!
    assert.match(detail.textContent!,/Upload reduction/)
    assert.match(detail.textContent!,/Model usage/)
    assert.match(detail.textContent!,/Input tokens/)
    assert.match(detail.textContent!,/Recent requests/)
    assert.ok(doc.querySelector("#session-detail .usage-context-point"))
    const point = doc.querySelector<SVGElement>("#session-detail .usage-context-point")!
    page.fire(point,"focus")
    assert.match(doc.querySelector("#usage-context-readout")!.textContent!,/input tokens/)
    doc.querySelector<HTMLButtonElement>("#close-detail")!.click()
    assert.equal(dialog.open,false)
  } finally { app.destroy(); await page.close() }
})
