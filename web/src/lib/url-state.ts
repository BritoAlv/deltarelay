// Keep durable view state in the address bar without adding history entries for
// every keystroke or poll. The dashboard remains usable if the URL API is
// unavailable (for example in a restricted webview).
export function readParams(doc: Document = document): URLSearchParams {
  try {
    return new URL(doc.defaultView?.location.href ?? "http://localhost/").searchParams
  } catch {
    return new URLSearchParams()
  }
}

export function replaceParams(doc: Document, values: Record<string, string | null>): void {
  const view = doc.defaultView
  if (!view) return
  try {
    const url = new URL(view.location.href)
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    if (url.href !== view.location.href) view.history.replaceState(null, "", url.href)
  } catch {
    // A denied history API must never break the live view.
  }
}
