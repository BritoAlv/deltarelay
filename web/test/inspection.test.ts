import test from "node:test"
import assert from "node:assert/strict"
import { artifactPageURL, artifactURL, decodeBytes, formatJSON, hexDump } from "../src/lib/inspection.js"

test("capture URLs never double-encode query separators", () => {
  const id = "a".repeat(32)
  assert.equal(artifactURL(id, "body"), `/api/inspection/${id}/artifacts/body`)
  assert.equal(artifactURL(id, "body", true, true), `/api/inspection/${id}/artifacts/body/download?decode=1`)
  assert.equal(artifactPageURL(id, "attempt-2", 4096, true), `/api/inspection/${id}/artifacts/attempt-2?offset=4096&limit=4096&decode=1`)
  assert.throws(() => artifactURL("../capture", "body"), /Invalid capture identifier/)
  assert.throws(() => artifactURL(id, "../body"), /Invalid artifact identifier/)
})

test("JSON formatting preserves original tokens rather than parsed values", () => {
  const source = `{"z":1,"z":2,"big":9007199254740993,"exp":1e400,"text":"héllo \\n world","escaped":"\\u00e9","empty":{},"array":[]}`
  const formatted = formatJSON(source)
  assert.match(formatted, /"z": 1,\n  "z": 2/)
  assert.match(formatted, /9007199254740993/)
  assert.match(formatted, /1e400/)
  assert.ok(formatted.includes('"escaped": "\\u00e9"'))
  assert.match(formatted, /"empty": \{\}/)
  assert.match(formatted, /"array": \[\]/)
  assert.equal((JSON.parse(formatted) as { text: string }).text, "héllo \n world")
  assert.throws(() => formatJSON("{invalid"), SyntaxError)
})

test("byte utilities preserve offsets and non-UTF-8 bytes", () => {
  const data = Uint8Array.from([0, 0xff, 0x41, 0x0a, 0xc3, 0xa9])
  assert.deepEqual([...decodeBytes(Buffer.from(data).toString("base64"))], [...data])
  assert.match(hexDump(data, 0x10), /^00000010  00 ff 41 0a c3 a9 +\|\.\.A\.\.\.\|$/)
  assert.match(hexDump(data.subarray(0, 2), 0x20), /^00000020  00 ff +\|\.\.\|$/)
})
