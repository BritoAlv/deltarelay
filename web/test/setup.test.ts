import test from "node:test"
import assert from "node:assert/strict"
import { fetchSetup, isSetupStatus } from "../src/lib/setup.js"

const required = { version: 1, available: true, required: true, busy: false, last_error: "", target: null }

test("setup status accepts first run and interrupted destinations without accepting commands or incompatible data", () => {
  assert.equal(isSetupStatus(required), true)
  const target = { provider: "ssh", target: "user@host", remote_directory: "~/relay", ssh_port: 22, remote_port: 8787 }
  assert.equal(isSetupStatus({ ...required, target }), true)
  for (const change of [{ version: 2 }, { required: false }, { busy: null }, { target: undefined }, { last_error: "private arbitrary error" }, { target: { ...target, provider: "shell" } }, { target: { ...target, remote_port: 80 } }]) {
    assert.equal(isSetupStatus({ ...required, ...change }), false)
  }
})

test("setup fetch uses only its same-origin endpoint and fails closed", async () => {
  const previous = globalThis.fetch
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(url, "/api/system/setup")
      assert.equal(init?.credentials, "same-origin")
      assert.equal(init?.cache, "no-store")
      assert.equal(init?.redirect, "error")
      return Response.json(required)
    }) as typeof fetch
    assert.deepEqual(await fetchSetup(new AbortController().signal), required)
    globalThis.fetch = async () => Response.json({ version: 1 }, { status: 200 })
    await assert.rejects(fetchSetup(new AbortController().signal), /unavailable/)
  } finally {
    globalThis.fetch = previous
  }
})
