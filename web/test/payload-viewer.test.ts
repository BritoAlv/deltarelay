import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { EditorView } from "@codemirror/view"
import { openPage } from "./browser.js"
import { formatJSON } from "../src/lib/inspection.js"
import { mountPayloadViewer, type PayloadViewerOptions } from "../src/scripts/features/payload-viewer.js"

const defaults: PayloadViewerOptions = { mode: "json", text: "", jsonText: true, bytes: null, offset: 0, total: 0, captureID: "a".repeat(32), artifactID: "body", decoded: false }

test("CodeMirror preserves exact JSON tokens, treats markup as data, and cannot edit evidence", async () => {
  const page = openPage("measurement")
  const root = page.document.createElement("div")
  page.document.body.append(root)
  const source = formatJSON('{"key":1,"key":2,"huge":9007199254740993,"escaped":"\\u00e9","html":"<img src=x onerror=alert(1)>"}')
  const viewer = mountPayloadViewer(root, { ...defaults, text: source })
  const editor = EditorView.findFromDOM(root.querySelector(".cm-editor")!)!
  assert.equal(editor.state.doc.toString(), source)
  assert.equal(editor.state.readOnly, true)
  assert.equal(root.querySelector(".cm-content")?.getAttribute("contenteditable"), "false")
  assert.equal(root.querySelector("img"), null)
  viewer.destroy()
  assert.equal(root.childElementCount, 0)
  await page.close()
})

test("text viewer has a read-only document, line numbers, search, and switchable wrapping", async () => {
  const page = openPage("measurement")
  const root = page.document.createElement("div")
  page.document.body.append(root)
  const text = "First line\nSecond line\n<third>"
  const viewer = mountPayloadViewer(root, { ...defaults, mode: "text", jsonText: false, text })
  const editor = EditorView.findFromDOM(root.querySelector(".cm-editor")!)!
  assert.equal(editor.state.doc.toString(), text)
  assert.equal(editor.state.doc.lines, 3)
  assert.ok(root.querySelector(".cm-lineNumbers"))
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")]
  const wrap = buttons.find((button) => button.textContent === "Wrap lines")!
  wrap.click()
  assert.equal(wrap.getAttribute("aria-pressed"), "false")
  assert.equal(buttons.some((button) => button.textContent === "Fold all"), false)
  buttons.find((button) => button.textContent === "Find")!.click()
  assert.ok(root.querySelector(".cm-search"))
  viewer.destroy()
  const restored = mountPayloadViewer(root, { ...defaults, mode: "text", jsonText: false, text })
  assert.equal([...root.querySelectorAll("button")].find((button) => button.textContent === "Wrap lines")!.getAttribute("aria-pressed"), "false")
  restored.destroy()
  await page.close()
})

test("unsupported canvas falls back to the real byte window with its absolute offset", async () => {
  const page = openPage("measurement")
  const root = page.document.createElement("div")
  const viewer = mountPayloadViewer(root, { ...defaults, mode: "hex", bytes: Uint8Array.of(0, 255, 65), offset: 4096, total: 4099 })
  assert.match(root.querySelector("pre")?.textContent ?? "", /^00001000  00 ff 41/)
  assert.match(root.textContent ?? "", /Interactive hex viewer unavailable/)
  viewer.destroy()
  await page.close()
})

test("hex host preserves the library flex layout so the canvas stays viewport-sized", async () => {
  const page = openPage("measurement")
  page.window.happyDOM.settings.disableComputedStyleRendering = false
  const stylesheet = page.document.createElement("style")
  // Happy DOM does not apply the dashboard's @layer wrapper. Exercise the
  // actual integration rule on its own; browser checks cover canvas sizing.
  const css = readFileSync(new URL("../../src/styles/dashboard.css", import.meta.url), "utf8")
  const rule = css.match(/\.payload-viewer-host hexcanvas-editor\s*\{[^}]+\}/)?.[0]
  assert.ok(rule)
  stylesheet.textContent = rule
  page.document.head.append(stylesheet)
  const host = page.document.createElement("div")
  host.className = "payload-viewer-host"
  const element = page.document.createElement("hexcanvas-editor")
  host.append(element)
  page.document.body.append(host)
  const style = page.window.getComputedStyle(element as unknown as Parameters<typeof page.window.getComputedStyle>[0])
  assert.equal(style.display, "flex")
  assert.equal(style.flexDirection, "column")
  assert.match(style.minHeight, /^0(?:px)?$/)
  await page.close()
})
