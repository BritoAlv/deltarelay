// Diagnostics are data, never markup. Every value interpolated into an HTML
// template passes through this function, including opaque IDs and errors.
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}
