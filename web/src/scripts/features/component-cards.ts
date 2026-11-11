import { supportsRemote, type SystemStatus } from "../../lib/system.js"
import { nodePresentation, observationStale, type ComponentAction, type NodeID } from "../../lib/topology.js"
import { requiredById } from "../dom.js"

export const actionLabels: Record<ComponentAction, string> = { start: "Start", recover: "Recover", restart: "Restart…", wake: "Wake…", stop: "Shut down…" }
const readable = (value: string) => value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())

export function mountComponentCards(root: HTMLElement, onAction: (id: NodeID, action: ComponentAction) => void, onDetails: (id: NodeID) => void) {
  const doc = root.ownerDocument
  const filter = requiredById<HTMLInputElement>(root, "component-filter")
  const cards = [...root.querySelectorAll<HTMLElement>("[data-component-id]")]
  const signatures = new Map<string, string>()
  function applyFilter() {
    const query = filter.value.trim().toLocaleLowerCase()
    let visible = 0
    for (const card of cards) {
      const searchable = `${card.querySelector("[data-component-label]")?.textContent} ${card.querySelector(".resource-category")?.textContent}`
      card.hidden = !searchable.toLocaleLowerCase().includes(query)
      if (!card.hidden) visible++
    }
    requiredById<HTMLElement>(root, "component-empty").hidden = visible > 0
    requiredById(root, "component-count").textContent = String(visible)
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
  filter.addEventListener("input", applyFilter)
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
      applyFilter()
    },
    destroy() { root.removeEventListener("click", click); doc.removeEventListener("click", dismiss); root.removeEventListener("keydown", escape); filter.removeEventListener("input", applyFilter) },
  }
}
