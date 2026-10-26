// OpenCode V2 consumes the default export's id and setup() lifecycle directly.
// Only this thin adapter is JavaScript; all hashing, transfers and networking
// between the PC and VPS are implemented by the Go services.
import { readFileSync, statSync } from "node:fs"
import { randomUUID } from "node:crypto"

function readToken(file) {
  let token
  if (file) {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) {
      throw new Error("DeltaRelay local token file must be private (chmod 600)")
    }
    token = readFileSync(file, "utf8").trim()
  } else {
    token = process.env.DELTARELAY_LOCAL_TOKEN
  }
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
    throw new Error("DeltaRelay requires localTokenFile or DELTARELAY_LOCAL_TOKEN")
  }
  return token
}

export async function setup(ctx) {
  const options = ctx.options ?? {}
  if (options.enabled === false) return
  const gateway = new URL(options.gateway ?? "http://127.0.0.1:8788")
  if (gateway.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname) || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== "/") {
    throw new Error("DeltaRelay gateway must be a loopback HTTP origin")
  }
  const providers = options.providers ?? ["openai", "opencode-go"]
  if (!Array.isArray(providers) || providers.length === 0 || providers.some((id) => typeof id !== "string" || !id)) {
    throw new Error("DeltaRelay providers must be a nonempty array of provider IDs")
  }
  const selected = new Set(providers)
  const headerTimeout = options.headerTimeout ?? 4 * 60 * 60 * 1000
  if (!Number.isSafeInteger(headerTimeout) || headerTimeout <= 0) {
    throw new Error("DeltaRelay headerTimeout must be positive milliseconds")
  }
  readToken(options.localTokenFile)
  const registrations = []
  try {
    registrations.push(await ctx.provider.transform((editor) => {
      for (const { provider } of editor.list()) {
        if (!selected.has(provider.id)) continue
        editor.update(provider.id, (draft) => {
          draft.settings = { ...draft.settings, transport: "http", encoding: "none", headerTimeout }
        })
      }
    }))
    registrations.push(await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        if (!selected.has(model.providerID)) continue
        editor.update(model.providerID, model.id, (draft) => {
          draft.settings = { ...draft.settings, encoding: "none" }
          if (Array.isArray(draft.variants)) {
            draft.variants = draft.variants.map((variant) => ({ ...variant, settings: { ...variant.settings, encoding: "none" } }))
          }
        })
      }
    }))
    for (const providerID of selected) {
      registrations.push(await ctx.session.hook("http.request", (event) => {
        const original = event.request
        if (original.method !== "POST") throw new Error("DeltaRelay only forwards model POST requests")
        const encoding = original.headers.get("content-encoding")
        if (encoding && !["identity", "gzip"].includes(encoding)) {
          throw new Error("DeltaRelay requires uncompressed provider requests; disable model/variant zstd encoding")
        }
        const headers = new Headers(original.headers)
        headers.delete("host")
        headers.delete("content-length")
        headers.set("x-deltarelay-local-token", readToken(options.localTokenFile))
        headers.set("x-deltarelay-target", original.url)
        headers.set("x-deltarelay-request-id", randomUUID())
        if (!headers.has("user-agent")) headers.set("user-agent", "opencode-deltarelay/0.2")
        event.request = new Request(new URL("/v1/proxy", gateway), {
          method: original.method, headers, body: original.body,
          signal: original.signal, redirect: "error", duplex: "half",
        })
      }, { providerID }))
      // DeltaRelay owns link retries and resumes the same durable request.
      // OpenCode retries would create new IDs and could repeat paid generation.
      registrations.push(await ctx.session.hook("retry", (event) => {
        event.decision = { retry: false }
      }, { providerID }))
      registrations.push(await ctx.session.hook("experimental.ws.handshake", () => {
        throw new Error("DeltaRelay is enabled: native provider WebSockets are forbidden")
      }, { providerID }))
    }
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose()
    throw error
  }
  return async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

export default { id: "deltarelay", setup }
