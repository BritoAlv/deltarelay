// All feature controllers resolve their elements from an explicit feature root.
// Missing markup fails once at mount time with a useful selector, instead of
// scattering nullable global getElementById() calls through render paths.
export function required<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector(selector)
  if (!value) throw new Error(`Missing required dashboard element: ${selector}`)
  return value as T
}

export function requiredById<T extends Element>(root: ParentNode, id: string): T {
  const value = root.querySelector(`#${id}`)
  if (!value) throw new Error(`Missing required dashboard element: #${id}`)
  return value as T
}

export function text(scope: ParentNode, selector: string, value: string | number): void {
  required(scope, selector).textContent = String(value)
}
