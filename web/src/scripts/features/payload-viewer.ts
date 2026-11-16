import { EditorState, Compartment } from "@codemirror/state"
import { EditorView, lineNumbers, keymap, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view"
import { defaultKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { foldGutter, foldKeymap, foldAll, unfoldAll, syntaxHighlighting, HighlightStyle, forceParsing, bracketMatching } from "@codemirror/language"
import { search, searchKeymap, openSearchPanel } from "@codemirror/search"
import { tags } from "@lezer/highlight"
import { PagedByteSource } from "@hexcanvas/core"
import type { HexCanvasElement } from "@hexcanvas/element"
import { decodeBytes, fetchArtifact, hexDump } from "../../lib/inspection.js"
import { dataValue } from "../../lib/presentation.js"
import { readPreferences, savePreferences } from "../../lib/preferences.js"

export interface PayloadViewerOptions {
  mode: "text" | "json" | "hex"
  text: string
  jsonText: boolean
  bytes: Uint8Array | null
  offset: number
  total: number
  captureID: string
  artifactID: string
  decoded: boolean
}

const colors = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--accent)" },
  { tag: tags.string, color: "var(--success)" },
  { tag: tags.number, color: "var(--warning)" },
  { tag: [tags.bool, tags.null], color: "var(--chart-reuse)" },
  { tag: tags.punctuation, color: "var(--muted)" },
])

// CodeMirror injects its light base theme outside the dashboard's cascade
// layers, so the editor chrome must be themed through the library itself.
const chrome = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--subtle)", borderRight: "1px solid var(--border)" },
  ".cm-lineNumbers .cm-gutterElement": { color: "var(--subtle)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--surface-raised)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-textfield": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "4px" },
  ".cm-button": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "4px", backgroundImage: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 25%, transparent)", outline: "1px solid var(--warning)" },
}, { dark: true })

// These adapters only host the libraries. Parsing, folding, search, selection,
// virtual rendering and keyboard navigation belong to CodeMirror/HexCanvas.
export function mountPayloadViewer(root: HTMLElement, options: PayloadViewerOptions) {
  const doc = root.ownerDocument
  const toolbar = doc.createElement("div")
  toolbar.className = "payload-viewer-tools"
  const host = doc.createElement("div")
  host.className = "payload-viewer-host"
  const status = doc.createElement("p")
  status.className = "inspect-range payload-viewer-status"
  status.setAttribute("role", "status")
  root.replaceChildren(toolbar, host, status)
  let editor: EditorView | null = null
  let hex: HexCanvasElement | null = null
  let destroyed = false
  const controller = new AbortController()
  let observer: MutationObserver | null = null
  let unsubscribeBytes: (() => void) | null = null

  function disposeHex() {
    unsubscribeBytes?.()
    unsubscribeBytes = null
    hex?.remove()
    hex?.engine.destroy()
    hex = null
  }

  function action(label: string, run: () => void) {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "text-button"
    button.textContent = label
    button.addEventListener("click", run)
    toolbar.append(button)
    return button
  }

  if (options.mode !== "hex") {
    const wrapping = new Compartment()
    let wrap = readPreferences(doc, "payload").wrap !== "false"
    editor = new EditorView({
      parent: host,
      root: doc,
      state: EditorState.create({
        doc: options.text,
        extensions: [
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": options.mode === "json" ? "Read-only JSON viewer" : "Read-only text viewer", tabindex: "0", translate: "no" }),
          chrome,
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          search(), keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
          wrapping.of(wrap ? EditorView.lineWrapping : []),
          ...(options.jsonText ? [json(), foldGutter(), bracketMatching(), syntaxHighlighting(colors)] : []),
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet) return
            const position = update.state.selection.main.head
            const line = update.state.doc.lineAt(position)
            status.innerHTML = `Read only · Ln ${dataValue(line.number)}, Col ${dataValue(position - line.from + 1)} · ${dataValue(`${update.state.doc.lines.toLocaleString()} lines`)}`
          }),
        ],
      }),
    })
    status.innerHTML = `Read only · ${dataValue(`${editor.state.doc.lines.toLocaleString()} lines`)} · ${options.mode === "json" ? "Parsed JSON · original tokens preserved" : "UTF-8 byte window"}`
    action("Find", () => { if (editor) { openSearchPanel(editor); editor.focus() } })
    if (options.jsonText) {
      action("Fold all", () => { if (editor) { forceParsing(editor, editor.state.doc.length, 300); foldAll(editor) } })
      action("Unfold all", () => { if (editor) unfoldAll(editor) })
    }
    const wrapButton = action("Wrap lines", () => {
      wrap = !wrap
      savePreferences(doc, "payload", { wrap: String(wrap) })
      editor?.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) })
      wrapButton.setAttribute("aria-pressed", String(wrap))
    })
    wrapButton.setAttribute("aria-pressed", String(wrap))
  } else {
    status.textContent = "Loading interactive hex viewer…"
    // The canvas library is browser-only, so load it only when hex is selected.
    void (async () => {
      try {
        const canvas = doc.createElement("canvas")
        if (!canvas.getContext("2d")) throw new Error("Canvas is unavailable")
        await import("@hexcanvas/element")
        if (destroyed) return
        const element = doc.createElement("hexcanvas-editor") as HexCanvasElement
        element.setAttribute("edit-mode", "read-only")
        element.setAttribute("bytes-per-row", "16")
        element.setAttribute("byte-group", "4")
        element.setAttribute("search", "native")
        element.setAttribute("goto", "native")
        element.setAttribute("replace", "off")
        element.setAttribute("aria-label", "Read-only captured bytes: hexadecimal and ASCII")
        element.setAttribute("font", "13px monospace")
        const source = new PagedByteSource({
          length: options.total,
          pageSize: 4096,
          maxPages: 32,
          async fetch(offset, length, signal) {
            const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(6000)])
            try {
              const page = await fetchArtifact(options.captureID, options.artifactID, offset, combined, options.decoded, length)
              const bytes = decodeBytes(page.data)
              if (page.total !== options.total || bytes.length !== length) throw new Error("Capture changed or returned an incomplete byte range. Refresh evidence.")
              return bytes
            } catch (error) {
              if (!destroyed && !combined.aborted) status.textContent = error instanceof Error ? error.message : "Byte range unavailable."
              throw error
            }
          },
        })
        // No apply/save API is exposed: the source itself is also read-only.
        element.source = source
        hex = element
        host.append(element)
        element.engine.gotoOffset(options.offset)
        const report = () => {
          const offset = element.cursor.offset
          const byte = source.peek(offset, 1)?.[0]
          status.innerHTML = `Read only · ${dataValue(`Offset 0x${offset.toString(16).padStart(8, "0")} (${offset.toLocaleString()})`)}${byte === undefined ? "" : ` · Hex ${dataValue(byte.toString(16).padStart(2, "0"))} · Decimal ${dataValue(byte)}`} · ${dataValue(`${options.total.toLocaleString()} ${options.decoded ? "decoded" : "retained"} bytes`)}`
        }
        element.addEventListener("cursorchange", report)
        unsubscribeBytes = source.subscribe(report)
        await source.ensure(options.offset, Math.min(4096, Math.max(0, options.total-options.offset)), controller.signal)
        if (destroyed) return
        report()
        action("Find bytes / text", () => element.engine.openSearch())
        action("Go to offset", () => element.engine.openGoto())
        const hint = doc.createElement("span")
        hint.className = "inspect-range"
        hint.textContent = "Arrows to navigate · Tab switches hex / ASCII · Escape, then Tab to leave"
        toolbar.append(hint)
        observer = new MutationObserver(() => element.refreshTheme())
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] })
      } catch (error) {
        if (destroyed) return
        disposeHex()
        // A truthful text alternative when canvas is unsupported, never fake bytes.
        const fallback = doc.createElement("pre")
        fallback.className = "payload-hex-fallback"
        fallback.textContent = options.bytes ? hexDump(options.bytes, options.offset) : "No byte window loaded."
        host.replaceChildren(fallback)
        status.textContent = `Interactive hex viewer unavailable; showing the captured byte window. ${error instanceof Error ? error.message : ""}`
      }
    })()
  }

  return {
    destroy() {
      destroyed = true
      controller.abort()
      observer?.disconnect()
      editor?.destroy()
      disposeHex()
      root.replaceChildren()
    },
  }
}
