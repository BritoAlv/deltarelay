import { escapeHtml as escape } from "../../lib/html.js"
import { supportsRemote, type SystemStatus } from "../../lib/system.js"
import { iconMarkup, remoteHostIcon } from "../../lib/icons.js"
import { nodePresentation, observationStale, type ComponentAction, type NodeID } from "../../lib/topology.js"
import { readParams, readSort, replaceParams, sortParams, type SortState } from "../../lib/url-state.js"
import { requiredById } from "../dom.js"

export const actionLabels: Record<ComponentAction, string> = { start: "Start", recover: "Recover", restart: "Restart", wake: "Wake", stop: "Stop", open: "Open" }
const readable = (value: string) => value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
const columns = ["component", "type", "description", "status", "lifecycle", "location"] as const
type Column = (typeof columns)[number]
const sortKeys = ["default", ...columns] as const
type SortKey = (typeof sortKeys)[number]
const asColumn = (value: string | undefined): Column | undefined => columns.find((key) => key === value)
const asSortKey = (value: string | undefined): SortKey | undefined => sortKeys.find((key) => key === value)
const textColumn = (key: Column) => key === "component" || key === "description"
const sortWord = (direction: "asc" | "desc") => direction === "asc" ? "ascending" : "descending"
const filterParams: Record<Column, string> = { component: "component_contains", type: "type", description: "description_contains", status: "status", lifecycle: "lifecycle", location: "location" }

export function mountComponentTable(root: HTMLElement, onAction: (id: NodeID, action: ComponentAction) => void, onDetails: (id: NodeID) => void) {
  const doc = root.ownerDocument
  const view = doc.defaultView
  const search = requiredById<HTMLInputElement>(root, "component-filter")
  const body = requiredById<HTMLElement>(root, "component-rows")
  const rows = [...body.querySelectorAll<HTMLTableRowElement>("[data-component-id]")]
  const sortSelect = requiredById<HTMLSelectElement>(root, "component-sort")
  const sortDirection = requiredById<HTMLButtonElement>(root, "component-sort-direction")
  const sortButtons = [...root.querySelectorAll<HTMLButtonElement>("#component-table-scroll button[data-sort-key]")]
  const headers = [...root.querySelectorAll<HTMLElement>("#component-table-scroll th[data-sort-key]")]
  const filterButtons = [...root.querySelectorAll<HTMLButtonElement>("#component-table-scroll button[data-filter-key]")]
  const clearButtons = [requiredById<HTMLButtonElement>(root, "clear-component-filters"), requiredById<HTMLButtonElement>(root, "clear-component-filters-empty")]
  const summary = requiredById<HTMLElement>(root, "component-summary")
  const empty = requiredById<HTMLElement>(root, "component-empty")
  const popover = requiredById<HTMLElement>(root, "component-filter-popover")
  const popoverTitle = requiredById<HTMLElement>(popover, "component-filter-popover-title")
  const popoverBody = requiredById<HTMLElement>(popover, "component-filter-popover-body")
  const caret = requiredById<HTMLElement>(popover, "component-filter-caret")
  const closeFilterButton = requiredById<HTMLButtonElement>(popover, "close-component-filter")
  const doneFilterButton = requiredById<HTMLButtonElement>(popover, "done-component-filter")
  const clearFilterButton = requiredById<HTMLButtonElement>(popover, "clear-component-filter")
  const defaultOrder = new Map(rows.map((row, index) => [row, index]))
  const signatures = new Map<NodeID, string>()
  // The filter popover lives outside the scroll container so no table edge clips it.
  doc.body.append(popover)
  const initial = readParams(doc)
  const filters = Object.fromEntries(columns.map((key) => [key, initial.get(filterParams[key]) ?? ""])) as Record<Column, string>
  search.value = initial.get("q") ?? ""
  let sort: SortState<SortKey> = readSort(initial, sortKeys, "default", "asc")
  let openFilter: { key: Column; trigger: HTMLButtonElement } | null = null
  const listeners: (() => void)[] = []
  function listen(target: EventTarget | null, name: string, handler: (event: Event) => void, capture = false) {
    target?.addEventListener(name, handler, capture)
    listeners.push(() => target?.removeEventListener(name, handler, capture))
  }

  function value(row: HTMLElement, key: Column): string {
    return row.querySelector(`[data-component-${key === "component" ? "label" : key}]`)?.textContent?.trim() ?? ""
  }

  function matches(row: HTMLElement, except?: Column): boolean {
    const query = search.value.trim().toLocaleLowerCase()
    return (!query || columns.map((key) => value(row, key)).join(" ").toLocaleLowerCase().includes(query))
      && columns.every((key) => key === except || !filters[key].trim() || (textColumn(key)
        ? value(row, key).toLocaleLowerCase().includes(filters[key].trim().toLocaleLowerCase())
        : value(row, key) === filters[key]))
  }

  function syncUrl() {
    replaceParams(doc, {
      q: search.value.trim() || null,
      ...Object.fromEntries(columns.map((key) => [filterParams[key], filters[key].trim() || null])),
      ...sortParams(sort, "default", "asc"),
    })
  }

  function closeFilter(returnFocus = false) {
    if (!openFilter) return
    const { trigger } = openFilter
    const focused = popover.contains(doc.activeElement)
    openFilter = null
    popover.hidden = true
    popoverBody.replaceChildren()
    trigger.setAttribute("aria-expanded", "false")
    if (returnFocus && focused) trigger.focus({ preventScroll: true })
  }

  function positionPanel(panel: HTMLElement, trigger: HTMLElement): number {
    panel.hidden = false
    const rect = trigger.getBoundingClientRect()
    const box = panel.getBoundingClientRect()
    const margin = 12
    const viewportWidth = view?.innerWidth ?? 1024
    const viewportHeight = view?.innerHeight ?? 768
    const left = Math.max(margin, Math.min(rect.right - box.width, viewportWidth - box.width - margin))
    const above = rect.bottom + 8 + box.height > viewportHeight - margin && rect.top - box.height - 8 >= margin
    panel.style.top = `${Math.round(above ? rect.top - box.height - 8 : rect.bottom + 8)}px`
    panel.style.left = `${Math.round(left)}px`
    panel.dataset.placement = above ? "top" : "bottom"
    return Math.max(14, Math.min(box.width - 14, rect.left + rect.width / 2 - left))
  }

  function optionValues(key: Column): string[] {
    const values = [...new Set(rows.map((row) => value(row, key)))]
    if (filters[key] && !values.includes(filters[key])) values.push(filters[key])
    return key === "type" ? values : values.sort((a, b) => a.localeCompare(b))
  }

  function renderFilterBody() {
    if (!openFilter) return
    const { key } = openFilter
    if (textColumn(key)) {
      popoverBody.innerHTML = `<label class="filter-text-field"><span class="sr-only">${readable(key)} contains</span><input type="search" data-component-filter-field="${key}" value="${escape(filters[key])}" placeholder="Contains ${key}…" autocomplete="off" spellcheck="false" maxlength="200"></label>`
    } else {
      const options = ["", ...optionValues(key)]
      popoverBody.innerHTML = `<div class="filter-options" role="radiogroup" aria-label="${readable(key)}">${options.map((option) => `<label class="filter-option"><input type="radio" name="component-filter-${key}" data-component-filter-option="${key}" value="${escape(option)}"><span>${escape(option || `All ${key === "status" ? "statuses" : key === "type" ? "types" : key === "location" ? "locations" : "lifecycles"}`)}</span><span class="filter-option-count"></span></label>`).join("")}</div>`
      updateFilterOptions()
    }
  }

  function focusFilterControl() {
    const target = popoverBody.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? popoverBody.querySelector<HTMLInputElement>("input")
    target?.focus({ preventScroll: true })
    if (target?.type === "search") target.setSelectionRange?.(target.value.length, target.value.length)
  }

  function updateFilterOptions() {
    if (!openFilter || textColumn(openFilter.key)) return
    const { key } = openFilter
    const options = [...popoverBody.querySelectorAll<HTMLInputElement>("[data-component-filter-option]")]
    const values = ["", ...optionValues(key)]
    if (values.length !== options.length || values.some((item, index) => item !== options[index]?.value)) {
      const focused = popoverBody.contains(doc.activeElement)
      renderFilterBody()
      if (focused) focusFilterControl()
      return
    }
    const scoped = rows.filter((row) => matches(row, key))
    for (const input of options) {
      input.checked = input.value === filters[key]
      const label = input.closest("label")!
      label.classList.toggle("selected", input.checked)
      label.querySelector(".filter-option-count")!.textContent = String(scoped.filter((row) => !input.value || value(row, key) === input.value).length)
    }
  }

  function applyView() {
    for (const row of rows) row.hidden = !matches(row)
    const direction = sort.direction === "asc" ? 1 : -1
    const ordered = [...rows].sort((a, b) => (sort.key === "default" ? 0 : value(a, sort.key).localeCompare(value(b, sort.key), undefined, { numeric: true, sensitivity: "base" }) * direction)
      || defaultOrder.get(a)! - defaultOrder.get(b)!)
    if (ordered.some((row, index) => row !== body.children[index])) {
      const focused = body.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null
      body.append(...ordered)
      focused?.focus({ preventScroll: true })
    }
    const visible = rows.filter((row) => !row.hidden).length
    const activeFilters = columns.filter((key) => filters[key].trim()).length + Number(Boolean(search.value.trim()))
    empty.hidden = visible > 0
    clearButtons.forEach((button) => { button.hidden = activeFilters === 0 })
    requiredById(root, "component-count").textContent = String(visible)
    const sortNote = sort.key === "default" ? "default order" : `sorted by ${sort.key} ${sortWord(sort.direction)}`
    const note = `${visible} of ${rows.length} components${activeFilters ? ` · ${activeFilters} filter${activeFilters === 1 ? "" : "s"} active` : ""} · ${sortNote}`
    if (summary.textContent !== note) summary.textContent = note
    for (const button of filterButtons) {
      const key = asColumn(button.dataset.filterKey)!
      const active = Boolean(filters[key].trim())
      button.dataset.active = String(active)
      button.setAttribute("aria-label", `Filter by ${key}${active ? ", active" : ""}`)
      button.title = `Filter by ${key}${active ? " (active)" : ""}`
    }
    updateFilterOptions()
    syncUrl()
  }

  function updateSortControls() {
    headers.forEach((header) => header.setAttribute("aria-sort", header.dataset.sortKey === sort.key ? sortWord(sort.direction) : "none"))
    for (const button of sortButtons) {
      const key = button.dataset.sortKey!
      button.setAttribute("aria-label", key === sort.key ? `${readable(key)}, sorted ${sortWord(sort.direction)}. Activate to sort ${sort.direction === "asc" ? "descending" : "ascending"}.` : `Sort by ${key}`)
    }
    sortSelect.value = sort.key
    sortDirection.disabled = sort.key === "default"
    sortDirection.dataset.direction = sort.direction
    sortDirection.setAttribute("aria-label", sort.key === "default" ? "Sort direction unavailable in default order" : `Sort direction: ${sortWord(sort.direction)}. Activate to sort ${sort.direction === "asc" ? "descending" : "ascending"}.`)
    sortDirection.title = sort.key === "default" ? "Choose a column to sort" : `Sorted ${sortWord(sort.direction)} — reverse order`
  }

  function sortBy(key: SortKey) {
    sort = { key, direction: key !== "default" && key === sort.key && sort.direction === "asc" ? "desc" : "asc" }
    updateSortControls()
    applyView()
  }

  listen(doc, "click", (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-component-action], [data-component-detail]")
    if (!target || target.disabled || !root.contains(target)) return
    if (target.dataset.componentDetail) onDetails(target.dataset.componentDetail as NodeID)
    else onAction(target.closest<HTMLElement>("[data-component-id]")!.dataset.componentId as NodeID, target.dataset.componentAction as ComponentAction)
  })
  listen(doc, "pointerdown", (event) => {
    const target = event.target as Node
    if (openFilter && !popover.contains(target) && !openFilter.trigger.contains(target)) closeFilter()
  })
  listen(doc, "keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape" || !openFilter) return
    event.preventDefault()
    closeFilter(true)
  })
  listen(view, "scroll", (event) => {
    if (openFilter && !popover.contains(event.target as Node)) closeFilter(true)
  }, true)
  listen(view, "resize", () => closeFilter(true))
  for (const button of sortButtons) listen(button, "click", () => sortBy(asSortKey(button.dataset.sortKey)!))
  listen(sortSelect, "change", () => { const key = asSortKey(sortSelect.value); if (key) sortBy(key) })
  listen(sortDirection, "click", () => { if (sort.key !== "default") sortBy(sort.key) })
  listen(search, "input", applyView)
  for (const button of filterButtons) listen(button, "click", () => {
    const key = asColumn(button.dataset.filterKey)!
    if (openFilter?.key === key) { closeFilter(true); return }
    closeFilter()
    openFilter = { key, trigger: button }
    popoverTitle.textContent = `Filter by ${key}`
    renderFilterBody()
    button.setAttribute("aria-expanded", "true")
    caret.style.left = `${Math.round(positionPanel(popover, button))}px`
    focusFilterControl()
  })
  listen(popoverBody, "input", (event) => {
    const input = event.target as HTMLInputElement
    const key = asColumn(input.dataset.componentFilterField)
    if (key) { filters[key] = input.value; applyView() }
  })
  listen(popoverBody, "change", (event) => {
    const input = event.target as HTMLInputElement
    const key = asColumn(input.dataset.componentFilterOption)
    if (key) { filters[key] = input.value; applyView() }
  })
  listen(closeFilterButton, "click", () => closeFilter(true))
  listen(doneFilterButton, "click", () => closeFilter(true))
  listen(clearFilterButton, "click", () => {
    if (!openFilter) return
    filters[openFilter.key] = ""
    renderFilterBody()
    applyView()
    focusFilterControl()
  })
  for (const button of clearButtons) listen(button, "click", () => {
    closeFilter()
    columns.forEach((key) => { filters[key] = "" })
    search.value = ""
    applyView()
    search.focus({ preventScroll: true })
  })
  updateSortControls()
  applyView()
  return {
    update(system: SystemStatus | null, stale: boolean, disabled: boolean) {
      const stopped = system?.topology?.intent.system === "stopped"
      for (const row of rows) {
        const id = row.dataset.componentId as NodeID
        if (id === "remote") {
          const icon = row.querySelector<HTMLElement>(".component-icon")!
          const name = remoteHostIcon(system?.remote)
          if (icon.dataset.icon !== name) { icon.innerHTML = iconMarkup(name, 16); icon.dataset.icon = name }
        }
        const node = system?.topology?.nodes.find((node) => node.id === id)
        const label = row.querySelector<HTMLElement>("[data-component-label]")!
        if (node) label.textContent = node.label
        label.title = label.textContent ?? ""
        const presentation = node ? nodePresentation(node, stale || observationStale(node, system!.collected_at)) : { label: "Not verified", tone: "neutral" }
        const status = row.querySelector<HTMLElement>("[data-component-status]")!
        status.textContent = presentation.label
        status.className = `component-status ${presentation.tone}`
        row.querySelector("[data-component-lifecycle]")!.textContent = node ? readable(node.lifecycle) : "Unknown"
        row.querySelector("[data-component-location]")!.textContent = !node ? "Not verified" : node.group === "remote" ? "Remote host" : "This computer"
        const actionsCell = row.querySelector<HTMLElement>("[data-component-actions]")!
        actionsCell.setAttribute("aria-label", `Actions for ${label.textContent}`)
        row.querySelector<HTMLButtonElement>("[data-component-detail]")!.setAttribute("aria-label", `Details for ${label.textContent}`)
        const actions = (node?.actions ?? []).filter((action) => Object.hasOwn(actionLabels, action) && (id !== "remote" || action !== "stop" && action !== "wake" || supportsRemote(system, action === "stop" ? "host.stop" : "host.wake")))
        const started = node && ["running", "starting", "started"].includes(node.lifecycle)
        const primary = actions.includes("start") && !started ? "start" : actions.includes("recover") ? "recover" : actions.includes("wake") && node?.lifecycle === "stopped" ? "wake" : actions.includes("open") ? "open" : null
        const signature = JSON.stringify([actions, primary, disabled, stopped, started, node?.label])
        if (signatures.get(id) === signature) continue
        signatures.set(id, signature)
        const focused = doc.activeElement as HTMLElement | null
        const focusedAction = focused && row.contains(focused) ? focused.dataset.componentAction : undefined
        function button(action: ComponentAction) {
          const button = doc.createElement("button")
          button.type = "button"
          button.className = `button ${action === "stop" ? "button-danger" : ""}`
          button.dataset.componentAction = action
          button.textContent = actionLabels[action]
          button.setAttribute("aria-label", `${action} ${node!.label}`)
          if (["restart", "wake", "stop"].includes(action)) button.title = "Requires confirmation"
          const stoppedIntent = Boolean(stopped) && action !== "open" && !(id === "remote" && action === "stop")
          button.disabled = disabled || stoppedIntent || action === "start" && Boolean(started)
          if (stoppedIntent) button.title = "Use Start / recover system to resume the intentionally stopped stack."
          if (id === "remote" && action === "stop") button.id = "stop-remote"
          return button
        }
        actionsCell.replaceChildren()
        if (primary) actionsCell.append(button(primary))
        else if (!node || node.owner === "user") {
          const note = doc.createElement("span")
          note.className = "component-action-note"
          note.textContent = !node ? "Waiting for supervisor" : "Open not configured"
          actionsCell.append(note)
        }
        for (const action of actions.filter((action) => action !== primary).sort((a, b) => Number(a === "stop") - Number(b === "stop"))) actionsCell.append(button(action))
        if (focusedAction) actionsCell.querySelector<HTMLButtonElement>(`[data-component-action="${focusedAction}"]`)?.focus({ preventScroll: true })
      }
      applyView()
    },
    destroy() {
      closeFilter()
      listeners.forEach((remove) => remove())
      root.append(popover)
    },
  }
}
