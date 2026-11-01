import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"
import { defaultTheme, readTheme, resolveTheme, saveTheme, themeInitializationScript, themes, themeStorageKey, themeStylesheet, themeTokens } from "../src/lib/themes.js"

test("the registry supplies at least five complete, uniquely identified light/dark palettes", () => {
  assert.ok(themes.length >= 5)
  assert.equal(new Set(themes.map((theme) => theme.id)).size, themes.length)
  assert.ok(themes.some((theme) => theme.mode === "light"))
  assert.ok(themes.some((theme) => theme.mode === "dark"))
  for (const theme of themes) {
    assert.match(theme.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(theme.name)
    assert.deepEqual(Object.keys(theme.colors).sort(), [...themeTokens].sort())
    for (const value of Object.values(theme.colors)) assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
    assert.equal(resolveTheme(theme.id), theme)
  }
})

test("invalid, removed, or unavailable preferences fall back safely", () => {
  for (const value of [null, undefined, "", "removed-theme", "__proto__", {}, "<script>"]) {
    assert.equal(resolveTheme(value), defaultTheme)
  }
  assert.equal(readTheme(null), defaultTheme)
  assert.equal(readTheme({ getItem: () => { throw new Error("Storage blocked") } }), defaultTheme)
  for (const theme of themes) {
    assert.equal(readTheme({ getItem: (key) => { assert.equal(key, themeStorageKey); return theme.id } }), theme)
  }
})

test("only validated theme IDs are stored; denied storage does not prevent switching", () => {
  const writes = new Map<string, string>()
  const storage = { setItem: (key: string, value: string) => { writes.set(key, value) } }
  for (const theme of themes) {
    assert.equal(saveTheme(theme.id, storage), true)
    assert.equal(writes.get(themeStorageKey), theme.id)
  }
  assert.equal(saveTheme("unrecognized", storage), true)
  assert.deepEqual([...writes], [[themeStorageKey, defaultTheme.id]])
  assert.equal(saveTheme("sand", null), false)
  assert.equal(saveTheme("sand", { setItem: () => { throw new Error("Quota exceeded") } }), false)
})

test("the CSP-compatible startup script restores all palettes before the dashboard loads", () => {
  const script = themeInitializationScript()
  for (const stored of [...themes.map((theme) => theme.id), null, "removed", "__proto__"]) {
    const document = { documentElement: { dataset: { theme: "" } } }
    runInNewContext(script, { document, localStorage: { getItem: () => stored } })
    assert.equal(document.documentElement.dataset.theme, resolveTheme(stored).id)
  }
  const document = { documentElement: { dataset: { theme: "" } } }
  const context = { document }
  Object.defineProperty(context, "localStorage", { get: () => { throw new Error("Storage denied") } })
  assert.doesNotThrow(() => runInNewContext(script, context))
  assert.equal(document.documentElement.dataset.theme, defaultTheme.id)
})

test("generated CSS includes every palette, semantic token, and native color scheme", () => {
  const css = themeStylesheet()
  assert.ok(css.startsWith(`:root, :root[data-theme="${defaultTheme.id}"]`))
  for (const theme of themes) {
    const rule = css.split("\n").find((line) => line.includes(`[data-theme="${theme.id}"]`))!
    assert.ok(rule)
    assert.ok(rule.includes(`color-scheme: ${theme.mode};`))
    for (const token of themeTokens) assert.ok(rule.includes(`--${token}: ${theme.colors[token]};`))
  }
})

test("dashboard components and chart graphics do not hardcode palette colors", async () => {
  const css = await readFile(new URL("../../src/styles/dashboard.css", import.meta.url), "utf8")
  const chart = await readFile(new URL("../../src/scripts/dashboard.ts", import.meta.url), "utf8")
  for (const source of [css, chart]) assert.doesNotMatch(source, /#[0-9a-f]{6}([0-9a-f]{2})?\b/i)
  for (const [, token] of css.matchAll(/var\(--([a-z-]+)/g)) {
    assert.ok(token === "mono" || themeTokens.some((key) => key === token), `Unknown theme token: ${token}`)
  }
  const page = await readFile(new URL("../../src/pages/index.astro", import.meta.url), "utf8")
  assert.match(page, /<script is:inline src="\/_astro\/theme-init\.js"><\/script>/)
  assert.ok(page.indexOf('/_astro/theme-init.js') < page.indexOf('/_astro/themes.css'))
  const config = await readFile(new URL("../../astro.config.mjs", import.meta.url), "utf8")
  assert.match(config, /assetsInlineLimit:\s*0/)
})

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }
  return channel(1) * .2126 + channel(3) * .7152 + channel(5) * .0722
}

test("text and status colors maintain readable contrast on dashboard surfaces", () => {
  for (const theme of themes) {
    for (const foreground of ["text", "muted", "subtle", "accent", "success", "warning", "danger"] as const) {
      for (const background of ["bg", "surface"] as const) {
        const a = luminance(theme.colors[foreground]), b = luminance(theme.colors[background])
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
        assert.ok(ratio >= 4.5, `${theme.id}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`)
      }
    }
  }
})
