import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setup } from "./index.mjs"

function context(options) {
  const hooks = []
  const transforms = { provider: [], model: [] }
  const provider = { id: "openai", settings: { transport: "websocket", encoding: "zstd" } }
  const model = { providerID: "openai", id: "test", settings: { encoding: "zstd" }, variants: [{ id: "high", settings: { encoding: "gzip" } }] }
  let disposed = 0
  const registration = () => ({ dispose: async () => { disposed++ } })
  return {
    options, hooks, transforms, providerValue: provider, modelValue: model, get disposed() { return disposed },
    provider: { transform: async (fn) => { transforms.provider.push(fn); fn({ list: () => [{ provider }], update: (_, edit) => edit(provider) }); return registration() } },
    model: { transform: async (fn) => { transforms.model.push(fn); fn({ list: () => [model], update: (_provider, _model, edit) => edit(model) }); return registration() } },
    session: { hook: async (name, fn, scope) => { hooks.push({ name, fn, scope }); return registration() } },
  }
}

test("forces HTTP, routes all model flows, preserves content/auth, and vetoes retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deltarelay-plugin-"))
  try {
    const file = join(dir, "local.token")
    writeFileSync(file, "private-local-token\n", { mode: 0o600 })
    const ctx = context({ localTokenFile: file })
    const cleanup = await setup(ctx)
    assert.equal(ctx.providerValue.settings.transport, "http")
    assert.equal(ctx.providerValue.settings.encoding, "none")
    assert.equal(ctx.modelValue.settings.encoding, "none")
    assert.equal(ctx.modelValue.variants[0].settings.encoding, "none")
    assert.equal(ctx.modelValue.compatibility, undefined)
    assert.equal(ctx.providerValue.settings.compaction, undefined)
    const hook = ctx.hooks.find((h) => h.name === "http.request" && h.scope.providerID === "openai")
    for (const kind of ["primary", "title", "compaction", "generate"]) {
      const controller = new AbortController()
      const event = { sessionID: "ses_dashboard_test", kind, request: new Request("https://api.openai.com/v1/responses", { method: "POST", body: '{"input":"hello"}', headers: { authorization: "Bearer original-provider-token" }, signal: controller.signal }) }
      hook.fn(event)
      assert.equal(event.request.url, "http://127.0.0.1:8788/proxy")
      assert.equal(event.request.headers.get("authorization"), "Bearer original-provider-token")
      assert.equal(event.request.headers.get("x-deltarelay-target"), "https://api.openai.com/v1/responses")
      assert.equal(event.request.headers.get("x-deltarelay-local-token"), "private-local-token")
      assert.match(event.request.headers.get("x-deltarelay-request-id"), /^[a-f0-9-]{36}$/)
      assert.equal(event.request.headers.get("x-deltarelay-session-id"), "ses_dashboard_test")
      assert.equal(event.request.headers.get("x-deltarelay-request-kind"), kind)
      assert.equal(event.request.redirect, "error")
      assert.equal(await event.request.text(), '{"input":"hello"}')
      controller.abort()
      assert.equal(event.request.signal.aborted, true)
    }
    const retry = ctx.hooks.find((h) => h.name === "retry")
    const event = { decision: { retry: true, delay: 100 } }
    retry.fn(event)
    assert.deepEqual(event.decision, { retry: false })
    const websocket = ctx.hooks.find((h) => h.name === "experimental.ws.handshake")
    assert.throws(() => websocket.fn({}), /forbidden/)
    await cleanup()
    assert.equal(ctx.disposed, ctx.hooks.length + 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("disabled mode registers nothing", async () => {
  const ctx = context({ enabled: false })
  await setup(ctx)
  assert.equal(ctx.hooks.length, 0)
  assert.equal(ctx.providerValue.settings.transport, "websocket")
})

test("token-sharing policy survives fresh registry rebuilds without authentication and preserves reasoning choices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deltarelay-plugin-"))
  try {
    const file = join(dir, "local.token")
    writeFileSync(file, "private-local-token\n", { mode: 0o600 })
    // No integration/credential API exists in this context: setup and rebuilds
    // must not resolve OAuth credentials, refresh tokens, or inspect secrets.
    const ctx = context({ localTokenFile: file, providers: ["openai", "opencode-go"], chatgptTokenSharingProviders: ["openai"] })
    const cleanup = await setup(ctx)
    assert.equal(ctx.modelValue.compatibility.supportsEffortUpdates, false)
    for (let rebuild = 0; rebuild < 3; rebuild++) {
      const providers = ["openai", "opencode-go", "unselected"].map((id) => ({ id, settings: { compaction: { type: "native" }, unrelated: true } }))
      const models = ["openai", "openai", "opencode-go", "unselected"].map((providerID, i) => ({
        providerID, id: `gpt-6-test-${i}`,
        compatibility: { supportsEffortUpdates: true, supportsThinkingBlockBinding: true },
        settings: { compaction: { type: "native" }, reasoningEffort: "high" },
        variants: [{ id: "max", settings: { compaction: { type: "native" }, reasoningEffort: "max" }, body: { untouched: true } }],
      }))
      for (const transform of ctx.transforms.provider) transform({ list: () => providers.map((provider) => ({ provider })), update: (id, edit) => edit(providers.find((p) => p.id === id)) })
      for (const transform of ctx.transforms.model) transform({ list: () => models, update: (providerID, id, edit) => edit(models.find((m) => m.providerID === providerID && m.id === id)) })
      assert.deepEqual(providers[0].settings.compaction, { type: "summary" })
      assert.equal(providers[0].settings.unrelated, true)
      assert.deepEqual(providers[1].settings.compaction, { type: "native" })
      for (const model of models) {
        assert.equal(model.compatibility.supportsEffortUpdates, model.providerID !== "openai")
        assert.equal(model.compatibility.supportsThinkingBlockBinding, true)
        assert.equal(model.settings.reasoningEffort, "high")
        assert.equal(model.variants[0].settings.reasoningEffort, "max")
        assert.deepEqual(model.variants[0].body, { untouched: true })
        const expected = { type: model.providerID === "openai" ? "summary" : "native" }
        assert.deepEqual(model.settings.compaction, expected)
        assert.deepEqual(model.variants[0].settings.compaction, expected)
      }
    }
    await cleanup()
    assert.equal(ctx.disposed, ctx.hooks.length + 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("rejects invalid or unrouted token-sharing provider policies", async () => {
  for (const value of [true, "openai", [null], [""], ["unrouted"]]) {
    await assert.rejects(setup(context({ chatgptTokenSharingProviders: value })), /chatgptTokenSharingProviders/)
  }
})

test("rejects remote gateways and world-readable token files", async () => {
  await assert.rejects(setup(context({ gateway: "http://evil.example" })), /loopback/)
  const dir = mkdtempSync(join(tmpdir(), "deltarelay-plugin-"))
  try {
    const file = join(dir, "local.token")
    writeFileSync(file, "token", { mode: 0o600 })
    chmodSync(file, 0o644)
    await assert.rejects(setup(context({ localTokenFile: file })), /private/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
