import { escapeHtml as escape } from "./html.js"
import { bytes, percentage, savings } from "./metrics.js"

// Values are always escaped here; callers supply labels, never arbitrary markup.
export function dataValue(value: unknown): string {
  return `<span class="data-value">${escape(value)}</span>`
}

export function facts(items: ReadonlyArray<readonly [string, unknown]>): string {
  return `<dl class="data-facts">${items.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>`
}

/** Native MathML gives equations real fractions and accessible math, without a runtime. */
export function reductionEquation(original: number, encoded: number): string {
  if (original <= 0) return `<span class="equation-unavailable">Original body is zero; reduction is unavailable.</span>`
  const label = `100 × (1 − ${bytes(encoded)} ÷ ${bytes(original)}) = ${percentage(savings(original, encoded))}`
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" aria-label="${escape(label)}"><mrow><mn>100</mn><mo>×</mo><mo>(</mo><mn>1</mn><mo>−</mo><mfrac><mtext>${escape(bytes(encoded))}</mtext><mtext>${escape(bytes(original))}</mtext></mfrac><mo>)</mo><mo>=</mo><mtext>${escape(percentage(savings(original, encoded)))}</mtext></mrow></math>`
}

export function savedEquation(original: number, encoded: number): string {
  const saved = original - encoded
  const label = `${original.toLocaleString()} − ${encoded.toLocaleString()} = ${saved.toLocaleString()} bytes`
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" aria-label="${escape(label)}"><mrow><mn>${escape(original.toLocaleString())}</mn> <mo>−</mo> <mn>${escape(encoded.toLocaleString())}</mn> <mo>=</mo> <mn>${escape(saved.toLocaleString())}</mn> <mtext>bytes</mtext></mrow></math>`
}
