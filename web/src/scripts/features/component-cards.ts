import { supportsRemote, type SystemStatus } from "../../lib/system.js"
import { nodePresentation, observationStale, type ComponentAction, type NodeID } from "../../lib/topology.js"
import type { SortDirection } from "../../lib/url-state.js"
import { requiredById } from "../dom.js"

export const actionLabels: Record<ComponentAction, string> = { start: "Start", recover: "Recover", restart: "Restart…", wake: "Wake…", stop: "Shut down…" }
const readable = (value: string) => value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
const componentSortKeys = ["default", "component", "status", "lifecycle", "location"] as const
type ComponentSortKey = (typeof componentSortKeys)[number]
const componentSortLabels: Record<ComponentSortKey, string> = {
  default: "default order",
  component: "component",
  status: "status",
  lifecycle: "lifecycle",
  location: "location",
}
const asComponentSortKey = (value: string | undefined): ComponentSortKey | null => componentSortKeys.find((key) => key === value) ?? null
const sortWord = (direction: SortDirection) => direction === "asc" ? "ascending" : "descending"
const capitalised = (value: string) => value.replace(/^./, (letter) => letter.toUpperCase())

export function mountComponentCards(root: HTMLElement, onAction: (id: NodeID, action: ComponentAction) => void, onDetails: (id: NodeID) => void) {
  const doc = root.ownerDocument
  const filter = requiredById<HTMLInputElement>(root, "component-filter")
  const cards = [...root.querySelectorAll<HTMLElement>("[data-component-id]")]
  const groups = [...root.querySelectorAll<HTMLElement>("[data-component-group]")]
  const categoryChips = [...root.querySelectorAll<HTMLButtonElement>("#component-category-chips [data-component-category]")]
  const sortSelect = requiredById<HTMLSelectElement>(root, "component-sort")
  const sortDirectionButton = requiredById<HTMLButtonElement>(root, "component-sort-direction")
  const sortButtons = [...root.querySelectorAll<HTMLButtonElement>(".component-columns button[data-sort-key]")]
  const sortHeaders = [...root.querySelectorAll<HTMLElement>(".component-columns th[data-sort-key]")]
  const summary = requiredById<HTMLElement>(root, "component-summary")
  const defaultOrder = new Map(cards.map((card, index) => [card, index]))
  const signatures = new Map<string, string>()
  const categoryOf = (card: HTMLElement) => card.querySelector(".resource-category")?.textContent?.trim() ?? ""
  let category = "all"
  let sortState: { key: ComponentSortKey; direction: SortDirection } = { key: "default", direction: "asc" }

  function cardText(card: HTMLElement, key: Exclude<ComponentSortKey, "default">): string {
    if (key === "component") return card.querySelector<HTMLElement>("[data-component-label]")?.textContent ?? ""
    if (key === "status") return card.querySelector<HTMLElement>("[data-component-status]")?.textContent ?? ""
    if (key === "lifecycle") return card.querySelector<HTMLElement>("[data-component-lifecycle]")?.textContent ?? ""
    return card.querySelector<HTMLElement>("[data-component-location]")?.textContent ?? ""
  }

  function sortCards(list: HTMLElement[]): HTMLElement[] {
    if (sortState.key === "default") return [...list].sort((a, b) => (defaultOrder.get(a) ?? 0) - (defaultOrder.get(b) ?? 0))
    const key = sortState.key
    const direction = sortState.direction === "asc" ? 1 : -1
    return [...list].sort((a, b) =>
      cardText(a, key).localeCompare(cardText(b, key), undefined, { numeric: true, sensitivity: "base" }) * direction
      || (defaultOrder.get(a) ?? 0) - (defaultOrder.get(b) ?? 0),
    )
  }

  function updateSortControls(): void {
    for (const header of sortHeaders) {
      const active = header.dataset.sortKey === sortState.key
      header.setAttribute("aria-sort", active ? (sortState.direction === "asc" ? "ascending" : "descending") : "none")
    }
    for (const button of sortButtons) {
      const key = asComponentSortKey(button.dataset.sortKey)
      if (!key) continue
      const label = componentSortLabels[key]
      const active = key === sortState.key
      button.setAttribute("aria-label", active
        ? `${capitalised(label)}, sorted ${sortWord(sortState.direction)}. Activate to sort ${sortState.direction === "asc" ? "descending" : "ascending"}.`
        : `Sort by ${label}`)
    }
    sortSelect.value = sortState.key
    sortDirectionButton.disabled = sortState.key === "default"
    const nextDirection = sortState.direction === "asc" ? "descending" : "ascending"
    sortDirectionButton.dataset.direction = sortState.direction
    sortDirectionButton.setAttribute("aria-label", sortState.key === "default"
      ? "Sort direction unavailable in default order"
      : `Sort direction: ${sortWord(sortState.direction)}. Activate to sort ${nextDirection}.`)
    sortDirectionButton.title = sortState.key === "default" ? "Choose a column to sort" : `Sorted ${sortWord(sortState.direction)} — reverse order`
  }

  function applyView() {
    const query = filter.value.trim().toLocaleLowerCase()
    const visibleByCategory = new Map<string, number>()
    let visible = 0
    for (const card of cards) {
      const cardCategory = categoryOf(card)
      const searchable = `${card.querySelector("[data-component-label]")?.textContent} ${cardCategory}`
      const matchesSearch = searchable.toLocaleLowerCase().includes(query)
      const matchesCategory = category === "all" || cardCategory === category
      card.hidden = !(matchesSearch && matchesCategory)
      if (!card.hidden) {
        visible++
        visibleByCategory.set(cardCategory, (visibleByCategory.get(cardCategory) ?? 0) + 1)
      }
    }
    for (const group of groups) {
      const name = group.dataset.componentGroup ?? ""
      const count = visibleByCategory.get(name) ?? 0
      group.hidden = count === 0
      const counter = group.querySelector<HTMLElement>("[data-group-count]")
      if (counter) counter.textContent = String(count).padStart(2, "0")
      const groupCards = [...root.querySelectorAll<HTMLElement>("[data-component-id]")].filter((card) => categoryOf(card) === name)
      const ordered = sortCards(groupCards)
      if (ordered.some((card, index) => card !== groupCards[index])) group.after(...ordered)
    }
    const empty = requiredById<HTMLElement>(root, "component-empty")
    empty.hidden = visible > 0
    requiredById(root, "component-count").textContent = String(visible)
    const sortNote = sortState.key === "default" ? "default order" : `${componentSortLabels[sortState.key]} ${sortWord(sortState.direction)}`
    const summaryText = `${visible} of ${cards.length} components${category === "all" ? "" : ` in ${category}`} · ${sortNote}`
    if (summary.textContent !== summaryText) summary.textContent = summaryText
  }

  function setCategory(value: string): void {
    category = value
    for (const chip of categoryChips) chip.setAttribute("aria-pressed", String(chip.dataset.componentCategory === category))
    applyView()
  }

  function sortBy(key: ComponentSortKey): void {
    if (key === "default") sortState = { key, direction: "asc" }
    else if (key === sortState.key) sortState = { key, direction: sortState.direction === "asc" ? "desc" : "asc" }
    else sortState = { key, direction: "asc" }
    updateSortControls()
    applyView()
  }
  function click(event: Event) {
    const target = (event.target as Element).closest<HTMLElement>("[data-component-action], [data-component-detail]")
    if (!target || !root.contains(target)) return
    if (target.dataset.componentDetail) onDetails(target.dataset.componentDetail as NodeID)
    else if (!(target as HTMLButtonElement).disabled) {
      target.closest<HTMLDetailsElement>(".resource-more")?.removeAttribute("open")
      onAction(target.closest<HTMLElement>("[data-component-id]")!.dataset.componentId as NodeID, target.dataset.componentAction as ComponentAction)
    }
  }
  function dismiss(event: Event) {
    for (const menu of root.querySelectorAll<HTMLDetailsElement>(".resource-more[open]")) {
      if (!menu.contains(event.target as Node)) menu.open = false
    }
  }
  function escape(event: KeyboardEvent) {
    if (event.key !== "Escape") return
    const menu = (event.target as Element).closest<HTMLDetailsElement>(".resource-more[open]")
    if (menu) { menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus(); event.preventDefault() }
  }
  root.addEventListener("click", click)
  doc.addEventListener("click", dismiss)
  root.addEventListener("keydown", escape)
  filter.addEventListener("input", applyView)
  for (const chip of categoryChips) chip.addEventListener("click", () => setCategory(chip.dataset.componentCategory ?? "all"))
  const categoryGroup = requiredById<HTMLElement>(root, "component-category-chips")
  categoryGroup.addEventListener("keydown", (event) => {
    const current = (event.target as Element).closest<HTMLButtonElement>("[data-component-category]")
    if (!current) return
    const index = categoryChips.indexOf(current)
    let next = index
    if (event.key === "ArrowRight") next = Math.min(categoryChips.length - 1, index + 1)
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1)
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = categoryChips.length - 1
    else return
    event.preventDefault()
    categoryChips[next]?.focus()
  })
  for (const button of sortButtons) {
    button.addEventListener("click", () => {
      const key = asComponentSortKey(button.dataset.sortKey)
      if (key) sortBy(key)
    })
  }
  sortSelect.addEventListener("change", () => {
    const key = asComponentSortKey(sortSelect.value)
    if (key) sortBy(key)
  })
  sortDirectionButton.addEventListener("click", () => {
    if (sortState.key === "default") return
    sortState = { key: sortState.key, direction: sortState.direction === "asc" ? "desc" : "asc" }
    updateSortControls()
    applyView()
  })
  updateSortControls()
  applyView()
  return {
    update(system: SystemStatus | null, stale: boolean, disabled: boolean) {
      const stopped = system?.topology?.intent.system === "stopped"
      for (const card of cards) {
        const id = card.dataset.componentId as NodeID
        const node = system?.topology?.nodes.find((node) => node.id === id)
        const label = card.querySelector<HTMLElement>("[data-component-label]")!
        if (node) label.textContent = node.label
        const presentation = node ? nodePresentation(node, stale || observationStale(node, system!.collected_at)) : { label: "Not verified", tone: "neutral" }
        const status = card.querySelector<HTMLElement>("[data-component-status]")!
        status.textContent = presentation.label
        status.className = `resource-observation ${presentation.tone}`
        card.querySelector("[data-component-lifecycle]")!.textContent = node ? readable(node.lifecycle) : "Unknown"
        card.querySelector("[data-component-location]")!.textContent = !node ? "Not verified" : node.group === "remote" ? "Remote host" : "This computer"
        const menu = card.querySelector<HTMLDetailsElement>(".resource-more")!
        menu.querySelector("summary")!.setAttribute("aria-label", `More actions for ${label.textContent}`)
        const details = card.querySelector<HTMLButtonElement>("[data-component-detail]")!
        details.disabled = !node
        details.setAttribute("aria-label", `Details for ${label.textContent}`)
        const actions = (node?.actions ?? []).filter((action) => Object.hasOwn(actionLabels, action) && (id !== "remote" || action !== "stop" && action !== "wake" || supportsRemote(system, action === "stop" ? "host.stop" : "host.wake")))
        const started = node && ["running", "starting", "started"].includes(node.lifecycle)
        const primary = actions.includes("start") && !started ? "start" : actions.includes("recover") ? "recover" : actions.includes("wake") && node?.lifecycle === "stopped" ? "wake" : null
        const signature = JSON.stringify([actions, primary, disabled, stopped, started, node?.label])
        if (signatures.get(id) === signature) continue
        signatures.set(id, signature)
        const focused = doc.activeElement as HTMLElement | null
        const focusedAction = focused && card.contains(focused) ? focused.dataset.componentAction : undefined
        function button(action: ComponentAction) {
          const button = doc.createElement("button")
          button.type = "button"
          button.className = `button ${action === "stop" ? "button-danger" : ""}`
          button.dataset.componentAction = action
          button.textContent = actionLabels[action]
          button.setAttribute("aria-label", `${action} ${node!.label}`)
          const stoppedIntent = Boolean(stopped) && !(id === "remote" && action === "stop")
          button.disabled = disabled || stoppedIntent || action === "start" && Boolean(started)
          if (stoppedIntent) button.title = "Use Start / recover system to resume the intentionally stopped stack."
          if (id === "remote" && action === "stop") button.id = "stop-remote"
          return button
        }
        const main = card.querySelector<HTMLElement>("[data-primary-action]")!
        const secondary = card.querySelector<HTMLElement>("[data-secondary-actions]")!
        main.replaceChildren()
        secondary.replaceChildren()
        if (primary) main.append(button(primary))
        else {
          const note = doc.createElement("span")
          note.className = "resource-managed"
          note.textContent = !node ? "Waiting for supervisor" : id === "supervisor" ? "Managed by startup.sh" : actions.length ? "Host actions in ⋯" : "No advertised actions"
          main.append(note)
        }
        for (const action of actions.filter((action) => action !== primary).sort((a, b) => Number(a === "stop") - Number(b === "stop"))) secondary.append(button(action))
        menu.hidden = !secondary.childElementCount
        if (menu.hidden) menu.open = false
        if (focusedAction) card.querySelector<HTMLButtonElement>(`[data-component-action="${focusedAction}"]`)?.focus({ preventScroll: true })
      }
      applyView()
    },
    destroy() { root.removeEventListener("click", click); doc.removeEventListener("click", dismiss); root.removeEventListener("keydown", escape); filter.removeEventListener("input", applyView) },
  }
}
