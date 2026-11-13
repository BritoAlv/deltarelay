import test from "node:test"
import assert from "node:assert/strict"
import { openPage } from "./browser.js"
import { mountMapNavigation } from "../src/scripts/features/map-navigation.js"
import { mapHeight, mapWidth } from "../src/lib/topology-layout.js"

function setup() {
  const page = openPage("controls")
  const root = page.document.getElementById("controls")!
  const viewport = root.querySelector<HTMLElement>(".topology-viewport")!
  Object.defineProperties(viewport, { clientWidth: { value: 760 }, clientHeight: { value: 500 } })
  const navigation = mountMapNavigation(root)
  const node = root.querySelector<HTMLButtonElement>('[data-node-id="relay"]')!
  const canvas = root.querySelector<HTMLElement>(".topology-canvas")!
  const camera = () => {
    const values = canvas.style.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number)
    return { x: values[0]!, y: values[1]!, scale: values[2]! }
  }
  function pointer(target: EventTarget | typeof page.window, type: string, x: number, y: number, id = 1, touch = false) {
    (target as unknown as EventTarget).dispatchEvent(new page.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: touch ? "touch" : "mouse", clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 }) as unknown as Event)
  }
  return { ...page, root, viewport, navigation, node, camera, pointer, async finish() { navigation.destroy(); await page.close() } }
}

test("map fits all components without a toolbar row or component picker", async () => {
  const page = setup()
  const camera = page.camera()
  assert.ok(camera.scale < 1)
  assert.ok(camera.x >= 0 && camera.y >= 60)
  assert.ok(camera.x + mapWidth * camera.scale <= 760)
  assert.ok(camera.y + mapHeight * camera.scale <= 500)
  assert.equal(page.root.querySelector(".map-navigation")?.parentElement, page.root.querySelector(".topology-workspace"))
  assert.equal(page.root.querySelector(".topology-workspace select"), null)
  assert.equal(page.root.querySelector(".topology-workspace #node-inspector"), null)
  await page.finish()
})

test("dragging from a component stops on release and does not select it", async () => {
  const page = setup()
  let clicks = 0
  page.node.addEventListener("click", () => clicks++)
  const before = page.camera()
  page.pointer(page.node, "pointerdown", 100, 100)
  page.pointer(page.window, "pointermove", 140, 125)
  const dragged = page.camera()
  assert.equal(dragged.x, before.x + 40)
  assert.equal(dragged.y, before.y + 25)
  page.pointer(page.window, "pointerup", 140, 125)
  page.pointer(page.window, "pointermove", 200, 200)
  assert.deepEqual(page.camera(), dragged)
  page.node.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as Event)
  assert.equal(clicks, 0)
  page.pointer(page.node, "pointerdown", 100, 100)
  page.pointer(page.window, "pointermove", 102, 101)
  page.pointer(page.window, "pointerup", 102, 101)
  page.node.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as Event)
  assert.equal(clicks, 1, "a normal click with small pointer jitter still selects")
  await page.finish()
})

test("wheel zoom preserves the map point beneath the cursor and stays bounded", async () => {
  const page = setup()
  const before = page.camera()
  const event = new page.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 })
  // happy-dom's WheelEvent does not yet inherit MouseEvent coordinates.
  Object.defineProperties(event, { clientX: { value: 250 }, clientY: { value: 150 } })
  page.viewport.dispatchEvent(event as unknown as Event)
  const after = page.camera()
  assert.equal(event.defaultPrevented, true)
  assert.ok(after.scale > before.scale)
  assert.ok(Math.abs((250 - before.x) / before.scale - (250 - after.x) / after.scale) < 1e-8)
  assert.ok(Math.abs((150 - before.y) / before.scale - (150 - after.y) / after.scale) < 1e-8)
  for (let i = 0; i < 30; i++) page.root.querySelector<HTMLButtonElement>("#map-zoom-in")!.click()
  assert.equal(page.camera().scale, 2.5)
  page.root.querySelector<HTMLButtonElement>("#map-zoom-reset")!.click()
  assert.equal(page.camera().scale, 1)
  await page.finish()
})

test("touch pinch zooms around its midpoint and transitions to one-finger pan", async () => {
  const page = setup()
  const before = page.camera()
  page.pointer(page.node, "pointerdown", 100, 100, 1, true)
  page.pointer(page.node, "lostpointercapture", 100, 100, 1, true)
  page.pointer(page.viewport, "pointerdown", 200, 100, 2, true)
  page.pointer(page.window, "pointermove", 300, 100, 2, true)
  const pinched = page.camera()
  assert.ok(Math.abs(pinched.scale - before.scale * 2) < 1e-12)
  assert.ok(Math.abs((200 - pinched.x) / pinched.scale - (150 - before.x) / before.scale) < 1e-8)
  page.pointer(page.window, "pointerup", 300, 100, 2, true)
  page.pointer(page.window, "pointermove", 120, 130, 1, true)
  assert.equal(page.camera().x, pinched.x + 20)
  assert.equal(page.camera().y, pinched.y + 30)
  page.pointer(page.window, "pointerup", 120, 130, 1, true)
  const released = page.camera()
  page.pointer(page.window, "pointermove", 180, 180, 1, true)
  assert.deepEqual(page.camera(), released)
  await page.finish()
})

test("architecture camera has keyboard navigation without opening an inspector", async () => {
  const page = setup()
  page.root.querySelector<HTMLButtonElement>("#map-zoom-reset")!.click()
  assert.equal(page.camera().scale, 1)
  const before = page.camera()
  page.viewport.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event)
  assert.equal(page.camera().x, before.x - 60)
  assert.equal(page.root.querySelector<HTMLDialogElement>("#node-inspector")!.open, false)
  page.viewport.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "0", bubbles: true }) as unknown as Event)
  assert.ok(page.camera().scale < .8)
  await page.finish()
})

test("blur, cancellation, capture loss and destroy cannot leave dragging active", async () => {
  const page = setup()
  for (const end of ["blur", "pointercancel", "lostpointercapture"] as const) {
    page.pointer(page.node, "pointerdown", 100, 100)
    page.pointer(page.window, "pointermove", 120, 130)
    const before = page.camera()
    if (end === "blur") page.window.dispatchEvent(new page.window.Event("blur"))
    else page.pointer(end === "lostpointercapture" ? page.viewport : page.window, end, 120, 130)
    page.pointer(page.window, "pointermove", 200, 200)
    assert.deepEqual(page.camera(), before, end)
  }
  page.navigation.destroy()
  const before = page.camera()
  page.pointer(page.node, "pointerdown", 100, 100)
  page.pointer(page.window, "pointermove", 200, 200)
  assert.deepEqual(page.camera(), before)
  await page.close()
})
