import { fetchRequestPage, type RequestPage } from "../../lib/api.js"
import { escapeHtml } from "../../lib/html.js"
import { sessionRequests } from "../../lib/metrics.js"
import type { Snapshot } from "../../lib/types.js"

/** Holds only the current page, never an accumulating cache of request rows. */
export function createRequestPages(onChange: () => void) {
  let identity = ""
  let revision: Snapshot | null = null
  let session = ""
  let host = ""
  let limit = 8
  let before = 0
  let previous: number[] = []
  let page: RequestPage = { requests: [], total: 0, next_before: 0 }
  let loading = false
  let error = ""
  let controller: AbortController | null = null
  let generation = 0
  let destroyed = false

  async function load() {
    controller?.abort()
    controller = new AbortController()
    const current = ++generation
    loading = true
    error = ""
    try {
      const next = await fetchRequestPage(session, host, before, limit, AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]))
      if (destroyed || generation !== current) return
      page = next
    } catch (cause) {
      if (destroyed || generation !== current) return
      error = cause instanceof Error ? cause.message : "Request history is unavailable."
    } finally {
      if (!destroyed && generation === current) {
        loading = false
        onChange()
      }
    }
  }

  return {
    sync(snapshot: Snapshot, id: string, selectedHost: string, size = 8, selectedSequence: number | null = null) {
      if (!snapshot.requests_paged) {
        const requests = sessionRequests(snapshot, id, selectedHost)
        return { requests, total: requests.length, paged: false, loading: false, error: "" }
      }
      const key = JSON.stringify([id, selectedHost])
      if (identity !== key) {
        identity = key
        session = id
        host = selectedHost
        limit = size
        before = selectedSequence === null ? 0 : selectedSequence + 1
        previous = before ? [0] : []
        page = { requests: [], total: 0, next_before: 0 }
        revision = null
      }
      if (revision !== snapshot) {
        revision = snapshot
        void load()
      }
      return { ...page, paged: true, loading, error }
    },
    controls() {
      return `<div class="request-pagination" aria-live="polite">
        ${loading ? "<p>Loading request history…</p>" : ""}
        ${error ? `<p role="status">${escapeHtml(error)}</p><button type="button" class="text-button" data-request-page="retry">Retry</button>` : ""}
        <span>${page.total.toLocaleString()} retained requests · ${page.requests.length.toLocaleString()} on this page</span>
        <button type="button" class="text-button" data-request-page="newer"${loading || !previous.length ? " disabled" : ""}>Newer requests</button>
        <button type="button" class="text-button" data-request-page="older"${loading || !page.next_before ? " disabled" : ""}>Older requests</button>
      </div>`
    },
    navigate(action: string) {
      if (loading) return
      if (action === "older" && page.next_before) {
        previous.push(before)
        before = page.next_before
      } else if (action === "newer" && previous.length) {
        before = previous.pop()!
      } else if (action !== "retry") return
      page = { ...page, requests: [] }
      void load()
      onChange()
    },
    destroy() { destroyed = true; generation++; controller?.abort() },
  }
}
