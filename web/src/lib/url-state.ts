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

export type SortDirection = "asc" | "desc"

export interface SortState<Key extends string> {
  key: Key
  direction: SortDirection
}

// Table sort state shares the same URL entry as search and pagination. Unknown
// keys fall back to the view's historical order instead of leaking into the UI.
export function readSort<Key extends string>(
  params: URLSearchParams,
  keys: readonly Key[],
  defaultKey: Key,
  defaultDirection: SortDirection = "desc",
): SortState<Key> {
  const requested = params.get("sort")
  const key = requested && keys.includes(requested as Key) ? requested as Key : defaultKey
  const requestedDirection = params.get("dir")
  const direction = key === requested && (requestedDirection === "asc" || requestedDirection === "desc")
    ? requestedDirection
    : defaultDirection
  return { key, direction }
}

// Default order stays implicit so existing links and the common case keep a
// short address.
export function sortParams<Key extends string>(
  sort: SortState<Key>,
  defaultKey: Key,
  defaultDirection: SortDirection = "desc",
): { sort: string | null; dir: SortDirection | null } {
  if (sort.key === defaultKey && sort.direction === defaultDirection) return { sort: null, dir: null }
  return { sort: sort.key, dir: sort.direction }
}
