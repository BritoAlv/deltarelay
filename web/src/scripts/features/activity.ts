import { activityLine, fetchActivity, type ActivityEntry } from "../../lib/activity.js"
import { createPoller } from "../../lib/polling.js"
import { requiredById } from "../dom.js"

export interface ActivityFeature {
  refresh(): Promise<void>
  reveal(): void
  pause(): void
  resume(): void
  destroy(): void
}

const maxEntries = 2000

export function mountActivity(root: HTMLElement, autoStart = true): ActivityFeature {
  const doc = root.ownerDocument
  const view = doc.defaultView ?? window
  const output = requiredById(root, "activity-output")
  const status = requiredById(root, "activity-status")
  const notice = requiredById<HTMLElement>(root, "activity-notice")
  const search = requiredById<HTMLInputElement>(root, "activity-search")
  const component = requiredById<HTMLSelectElement>(root, "activity-component")
  const follow = requiredById<HTMLInputElement>(root, "activity-follow")
  const pauseButton = requiredById<HTMLButtonElement>(root, "activity-pause")
  const earlier = requiredById<HTMLButtonElement>(root, "activity-earlier")
  const copy = requiredById<HTMLButtonElement>(root, "activity-copy")
  const download = requiredById<HTMLButtonElement>(root, "activity-download")
  const count = requiredById(root, "activity-count")
  const listeners = new AbortController()
  const events = { signal: listeners.signal }
  let entries: ActivityEntry[] = []
  let cursor: number | undefined
  let oldest = 0
  let busy = false
  let paused = false
  let destroyed = false
  let error = ""
  let warning = ""
  let connected = false
  let inFlight: AbortController | null = null
  let catchUpTimer: number | null = null
  const components = new Set<string>()
  const rows = new Map<number, HTMLElement>()
  const poller = createPoller({ document: doc, intervalMs: 1000, run: refresh })

  function visibleEntries() {
    const query = search.value.toLowerCase()
    return entries.filter((entry) => (!component.value || entry.component === component.value) && (!query || activityLine(entry).toLowerCase().includes(query)))
  }

  function renderOutput(prepending = false) {
    const height = output.scrollHeight
    const top = output.scrollTop
    const visible = visibleEntries()
    let position = output.firstChild
    for (const entry of visible) {
      let row = rows.get(entry.seq)
      if (!row) {
        row = doc.createElement("div")
        row.className = `activity-line activity-${entry.stream}`
        row.dataset.sequence = String(entry.seq)
        const meta = doc.createElement("span")
        meta.className = "activity-meta"
        meta.textContent = `${entry.time} [${entry.component}] [${entry.trigger}${entry.operation ? `:${entry.operation}` : ""}${entry.execution ? `/${entry.execution}` : ""}] [${entry.stream}] `
        row.append(meta, doc.createTextNode(entry.text))
        rows.set(entry.seq, row)
      }
      // Preserve existing DOM nodes and selections while new output arrives.
      if (position !== row) output.insertBefore(row, position)
      position = row.nextSibling
    }
    while (position) { const next = position.nextSibling; position.remove(); position = next }
    const retained = new Set(entries.map((entry) => entry.seq))
    for (const [seq, row] of rows) {
      if (!retained.has(seq) || !output.contains(row)) {
        row.remove()
        rows.delete(seq)
      }
    }
    output.classList.toggle("empty", visible.length === 0)
    if (!visible.length) {
      const empty = doc.createElement("p")
      empty.className = "activity-empty"
      empty.textContent = entries.length ? "No records match this filter." : connected ? "The supervisor has not recorded any activity yet." : "Waiting for recorded activity. No progress is simulated."
      output.append(empty)
    }
    // Command output is untrusted text, never HTML or executable terminal escapes.
    if (prepending) output.scrollTop = top + output.scrollHeight - height
    else if (follow.checked) output.scrollTop = output.scrollHeight
    else output.scrollTop = top
    count.textContent = `${visible.length} visible · ${entries.length} records loaded (max ${maxEntries.toLocaleString()})`
    copy.disabled = !visible.length
    download.disabled = !entries.length
    renderState()
  }

  function renderState() {
    const nextStatus = paused ? "Paused — supervisor still recording" : error ? "Disconnected — retrying…" : connected ? "Live · polling every 1s" : "Connecting to the supervisor journal…"
    if (status.textContent !== nextStatus) status.textContent = nextStatus
    status.classList.toggle("good", !paused && !error && !warning && connected)
    status.classList.toggle("warning", !paused && (Boolean(error) || Boolean(warning)))
    const nextNotice = error || warning
    const noticeWasHidden = notice.hidden
    notice.hidden = !nextNotice
    if (nextNotice && (noticeWasHidden || notice.textContent !== nextNotice)) notice.textContent = nextNotice
    earlier.disabled = busy || !entries.length || entries[0]!.seq <= oldest || entries.length >= maxEntries
    const pauseLabel = paused ? "Resume Log" : "Pause Log"
    if (pauseButton.textContent !== pauseLabel) pauseButton.textContent = pauseLabel
    pauseButton.setAttribute("aria-pressed", String(paused))
  }

  async function load(before?: number) {
    if (busy || destroyed) return
    busy = true
    inFlight = new AbortController()
    const timeout = view.setTimeout(() => inFlight?.abort(), 6000)
    renderState()
    let catchUp = false
    try {
      const page = await fetchActivity(inFlight.signal, before !== undefined ? { before } : cursor !== undefined ? { after: cursor } : undefined)
      if (destroyed) return
      connected = true
      error = ""
      oldest = page.oldest
      const warnings: string[] = []
      if (page.reset) {
        entries = []
        rows.clear()
        cursor = undefined
        warnings.push("Journal history changed or older output rotated out. Resumed from the latest retained records; a gap may exist.")
      }
      if (page.storage_error) warnings.push("Journal persistence is degraded (storage error or backlog). Memory history is bounded; some output may not survive a supervisor restart.")
      if (warnings.length) warning = warnings.join(" ")
      const previous = new Set(entries.map((entry) => entry.seq))
      const added = page.entries.filter((entry) => !previous.has(entry.seq))
      entries = before !== undefined ? [...added, ...entries].slice(0, maxEntries) : [...entries, ...added].slice(-maxEntries)
      if (before === undefined) cursor = page.entries.at(-1)?.seq ?? cursor ?? page.newest
      catchUp = before === undefined && page.entries.length > 0 && cursor !== undefined && cursor < page.newest
      for (const entry of added) {
        if (components.has(entry.component)) continue
        components.add(entry.component)
        const option = doc.createElement("option")
        option.value = option.textContent = entry.component
        component.append(option)
      }
      if (added.length || !entries.length || page.reset) renderOutput(before !== undefined)
    } catch (cause) {
      if (!destroyed) error = cause instanceof Error ? cause.message : "Supervisor journal unavailable. Reconnecting automatically."
    } finally {
      view.clearTimeout(timeout)
      inFlight = null
      busy = false
      if (!destroyed) renderState()
      if (!destroyed && !paused && catchUp && doc.visibilityState !== "hidden") {
        catchUpTimer = view.setTimeout(() => { catchUpTimer = null; if (!paused && !destroyed && doc.visibilityState !== "hidden") void refresh() }, 0)
      }
    }
  }

  async function refresh() { await load() }

  function setPaused(value: boolean) {
    paused = value
    if (paused) poller.pause()
    else poller.resume()
    renderState()
  }

  search.addEventListener("input", () => renderOutput(), events)
  component.addEventListener("change", () => renderOutput(), events)
  follow.addEventListener("change", () => { if (follow.checked) output.scrollTop = output.scrollHeight }, events)
  output.addEventListener("scroll", () => {
    if (output.scrollHeight - output.scrollTop - output.clientHeight > 48) follow.checked = false
  }, events)
  pauseButton.addEventListener("click", () => setPaused(!paused), events)
  earlier.addEventListener("click", () => { follow.checked = false; void load(entries[0]?.seq) }, events)
  copy.addEventListener("click", () => {
    void (async () => {
      try {
        await view.navigator.clipboard.writeText(visibleEntries().map(activityLine).join("\n"))
        notice.textContent = "Visible activity copied. Review logs before sharing; diagnostic output can contain private information."
      } catch {
        notice.textContent = "Clipboard unavailable. Select the log text or use Download Loaded Log."
      }
      notice.hidden = false
    })()
  }, events)
  download.addEventListener("click", () => {
    const blob = new Blob([(warning ? `# WARNING: ${warning}\n` : "") + entries.map(activityLine).join("\n") + "\n"], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = doc.createElement("a")
    anchor.href = url
    anchor.download = `deltarelay-system-${new Date().toISOString().replaceAll(":", "-")}.log`
    anchor.click()
    URL.revokeObjectURL(url)
  }, events)

  renderState()
  if (autoStart) poller.start()
  return {
    refresh,
    reveal() {
      follow.checked = true
      output.scrollTop = output.scrollHeight
      root.scrollIntoView?.({ block: "nearest" })
    },
    pause: () => setPaused(true),
    resume: () => setPaused(false),
    destroy() {
      destroyed = true
      poller.stop()
      listeners.abort()
      inFlight?.abort()
      if (catchUpTimer !== null) view.clearTimeout(catchUpTimer)
    },
  }
}
