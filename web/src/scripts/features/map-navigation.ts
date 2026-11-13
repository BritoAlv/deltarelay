import { mapHeight, mapNodes, mapWidth, nodeHeight, nodeWidth } from "../../lib/topology-layout.js"
import type { NodeID } from "../../lib/topology.js"
import { requiredById } from "../dom.js"

/** The camera is independent of status polling: fresh observations never move it. */
export function mountMapNavigation(root: HTMLElement) {
  const doc = root.ownerDocument
  const view = doc.defaultView!
  const viewport = root.querySelector<HTMLElement>(".topology-viewport")!
  const canvas = root.querySelector<HTMLElement>(".topology-canvas")!
  const resetButton = requiredById<HTMLButtonElement>(root, "map-zoom-reset")
  const zoomIn = requiredById<HTMLButtonElement>(root, "map-zoom-in")
  const zoomOut = requiredById<HTMLButtonElement>(root, "map-zoom-out")
  const fitButton = requiredById<HTMLButtonElement>(root, "map-fit")
  const cleanup: (() => void)[] = []
  function on<K extends keyof (WindowEventMap & DocumentEventMap)>(target: EventTarget, type: K, handler: (event: (WindowEventMap & DocumentEventMap)[K]) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler as EventListener, options)
    cleanup.push(() => target.removeEventListener(type, handler as EventListener, options))
  }
  let scale = 1
  let x = 0
  let y = 0
  let fitted = true
  let readableFit = true
  let suppressClick = false
  const pointers = new Map<number, { x: number; y: number }>()
  let drag: { x: number; y: number; cameraX: number; cameraY: number; moved: boolean } | null = null
  let pinch: { distance: number; scale: number; worldX: number; worldY: number } | null = null
  const dimensions = () => ({ width: viewport.clientWidth, height: viewport.clientHeight })
  const localPoint = (clientX: number, clientY: number) => {
    const rect = viewport.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }
  function paint() {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    resetButton.textContent = `${Math.round(scale * 100)}%`
    zoomIn.disabled = scale >= 2.5
    zoomOut.disabled = scale <= .1
  }
  function zoom(next: number, point?: { x: number; y: number }) {
    const { width, height } = dimensions()
    const anchor = point ?? { x: width / 2, y: height / 2 }
    const worldX = (anchor.x - x) / scale
    const worldY = (anchor.y - y) / scale
    scale = Math.max(.1, Math.min(2.5, next))
    x = anchor.x - worldX * scale
    y = anchor.y - worldY * scale
    fitted = false
    readableFit = false
    paint()
  }
  function fitMode(readable: boolean) {
    const { width, height } = dimensions()
    if (!width || !height) return
    // Reserve space for the floating toolbar, rather than covering the top row.
    const fittedScale = Math.min(2.5, (width - 32) / mapWidth, (height - 76) / mapHeight)
    // Keep labels legible on first open at every width; "Fit all" still performs a true fit.
    scale = Math.max(.1, Math.min(2.5, readable ? Math.max(fittedScale, .75) : fittedScale))
    x = Math.max(16, (width - mapWidth * scale) / 2)
    y = scale > fittedScale ? 60 : 60 + (height - 60 - mapHeight * scale) / 2
    fitted = true
    readableFit = readable
    paint()
  }
  function fitAll() { fitMode(false) }
  function fitDefault() { fitMode(true) }
  function center(id: NodeID) {
    const node = mapNodes.find((item) => item.id === id)
    if (!node) return
    const { width, height } = dimensions()
    scale = Math.max(.8, scale)
    x = width / 2 - (node.x + nodeWidth / 2) * scale
    y = 60 + (height - 60) / 2 - (node.y + nodeHeight / 2) * scale
    fitted = false
    readableFit = false
    paint()
  }
  function cancel() {
    const ids = [...pointers.keys()]
    pointers.clear()
    drag = null
    pinch = null
    viewport.classList.remove("is-dragging")
    for (const id of ids) if (viewport.hasPointerCapture?.(id)) viewport.releasePointerCapture(id)
  }
  function beginPinch() {
    const [a, b] = [...pointers.values()]
    if (!a || !b) return
    const midpoint = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2)
    pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale, worldX: (midpoint.x - x) / scale, worldY: (midpoint.y - y) / scale }
    drag = null
    suppressClick = true
  }
  on(viewport, "pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    if (!(event.target as Element).closest("[data-node-id]")) viewport.focus({ preventScroll: true })
    if (!pointers.size) suppressClick = false
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size >= 2) {
      beginPinch()
      for (const id of pointers.keys()) viewport.setPointerCapture?.(id)
    } else drag = { x: event.clientX, y: event.clientY, cameraX: x, cameraY: y, moved: false }
    // Keep normal component clicks (and their keyboard focus) until movement
    // crosses the drag threshold. Pointer capture then handles outside release.
  })
  on(view, "pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return
    if (event.pointerType === "mouse" && !(event.buttons & 1)) { cancel(); return }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pinch && pointers.size >= 2) {
      event.preventDefault()
      const [a, b] = [...pointers.values()]
      if (!a || !b) return
      const midpoint = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2)
      scale = Math.max(.1, Math.min(2.5, pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance))
      x = midpoint.x - pinch.worldX * scale
      y = midpoint.y - pinch.worldY * scale
    } else if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 5) return
      drag.moved = true
      suppressClick = true
      viewport.setPointerCapture?.(event.pointerId)
      viewport.classList.add("is-dragging")
      event.preventDefault()
      x = drag.cameraX + dx
      y = drag.cameraY + dy
    } else return
    fitted = false
    paint()
  }, { passive: false })
  function release(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return
    pointers.delete(event.pointerId)
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
    pinch = null
    drag = null
    if (pointers.size >= 2) beginPinch()
    else if (pointers.size === 1) {
      const point = [...pointers.values()][0]!
      drag = { x: point.x, y: point.y, cameraX: x, cameraY: y, moved: true }
    } else viewport.classList.remove("is-dragging")
  }
  on(view, "pointerup", release)
  on(view, "pointercancel", (event) => { if (pointers.has(event.pointerId)) { suppressClick = true; cancel() } })
  // Touch begins with implicit capture on the node under the finger. Losing
  // that node's capture when we take over a drag is expected, not cancellation.
  on(viewport, "lostpointercapture", (event) => { if (event.target === viewport && pointers.has(event.pointerId)) cancel() })
  on(view, "blur", cancel)
  on(doc, "visibilitychange", () => { if (doc.hidden) cancel() })
  on(viewport, "dragstart", (event) => event.preventDefault())
  on(viewport, "click", (event) => {
    if (!suppressClick || event.detail === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    suppressClick = false
  }, { capture: true })
  on(viewport, "wheel", (event) => {
    event.preventDefault()
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
    zoom(scale * Math.exp(-delta * .002), localPoint(event.clientX, event.clientY))
  }, { passive: false })
  on(viewport, "dblclick", (event) => {
    if ((event.target as Element).closest("[data-node-id]")) return
    event.preventDefault()
    zoom(scale * (event.shiftKey ? .5 : 2), localPoint(event.clientX, event.clientY))
  })
  on(root, "keydown", (event) => {
    if (!viewport.contains(event.target as Node) || (event.target as Element).closest("button")) return
    const step = event.shiftKey ? 150 : 60
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      x += move[0]; y += move[1]
      fitted = false
      paint()
    } else if (["+", "=", "-", "0", "Home"].includes(event.key)) {
      event.preventDefault()
      if (event.key === "0" || event.key === "Home") fitAll()
      else zoom(scale * (event.key === "-" ? .8 : 1.25))
    }
  })
  on(zoomIn, "click", () => zoom(scale * 1.25))
  on(zoomOut, "click", () => zoom(scale / 1.25))
  on(resetButton, "click", () => zoom(1))
  on(fitButton, "click", fitAll)
  // Tabbing through off-screen node buttons should reveal, not scroll, the
  // transformed canvas. Preserve the keyboard user's place on resize as well.
  on(viewport, "focusin", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-node-id]")
    if (!button || pointers.size) return
    const rect = button.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    if (rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top + 60 || rect.bottom > bounds.bottom) center(button.dataset.nodeId as NodeID)
  })
  const observer = new view.ResizeObserver(() => { if (fitted) (readableFit ? fitDefault() : fitAll()) })
  observer.observe(viewport)
  fitDefault()
  return { reveal() { if (fitted) (readableFit ? fitDefault() : fitAll()) }, destroy() { cancel(); observer.disconnect(); for (const remove of cleanup) remove() } }
}
