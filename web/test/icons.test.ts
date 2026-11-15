import test from "node:test"
import assert from "node:assert/strict"
import { iconDefinition, iconMarkup, remoteHostIcon, type IconName } from "../src/lib/icons.js"
import { mapNodes } from "../src/lib/topology-layout.js"
import { mountSetup } from "../src/scripts/features/setup.js"
import { startSystemStatus } from "../src/scripts/system.js"
import { readContract } from "./contracts.js"
import { isSystemStatus } from "../src/lib/system.js"
import { json, openPage } from "./browser.js"

test("every architecture component has a real SVG and branded components use identity marks", () => {
  for (const node of mapNodes) {
    assert.match(iconMarkup(node.icon), /^<svg /)
    assert.ok(iconDefinition(node.icon).body)
  }
  for (const [id, icon] of [["vscode", "vscode"], ["desktop", "opencode"], ["opencode", "opencode"]]) {
    assert.equal(mapNodes.find((node) => node.id === id)?.icon, icon)
  }
  for (const name of ["github", "vscode", "openai", "opencode"] as const) {
    assert.equal(iconDefinition(name).brand, true)
    assert.match(iconMarkup(name), /stroke="none"/)
  }
  assert.throws(() => iconMarkup("misspelled" as IconName), /Unknown dashboard icon/)
})

test("SVG icons retain intrinsic geometry and decorative accessibility attributes", () => {
  assert.match(iconMarkup("opencode", 18), /viewBox="0 0 240 300"/)
  assert.match(iconMarkup("play", 17), /width="17" height="17"/)
  assert.match(iconMarkup("chevron"), /aria-hidden="true" focusable="false"/)
  assert.throws(() => iconMarkup("play", NaN), /Invalid icon size/)
  assert.equal(remoteHostIcon({ id: "codespaces", label: "My host" }), "github")
  assert.equal(remoteHostIcon({ id: "configured", label: "GitHub Codespace" }), "github")
  assert.equal(remoteHostIcon({ id: "ssh", label: "Linux VPS" }), "system")
  assert.equal(remoteHostIcon(undefined), "system")
})

test("dashboard icon controls use SVG instead of text glyphs on all routes", async () => {
  for (const route of ["index", "sessions", "measurement", "controls", "system"] as const) {
    const page = openPage(route)
    try {
      for (const selector of [".brand-symbol", ".topbar-brand"]) {
        const logo = page.document.querySelector(selector)!
        const svg = logo.querySelector("svg")!
        assert.ok(svg, `${route}: original DeltaRelay identity as SVG`)
        assert.equal(svg.getAttribute("viewBox"), "0 0 2048 2048")
        assert.equal(svg.querySelector("path")?.getAttribute("d"), iconDefinition("deltarelay").body.match(/d="([^"]+)"/)?.[1])
        assert.equal(svg.getAttribute("stroke"), "none")
        assert.equal(svg.querySelector("text"), null)
        assert.equal(logo.getAttribute("aria-hidden"), "true")
      }
      for (const selector of [".page-footer a", ".icon-button", ".mobile-tab"]) {
        for (const element of page.document.querySelectorAll(selector)) assert.ok(element.querySelector("svg"), `${route}: ${selector}`)
      }
      if (route === "controls") {
        for (const selector of ["#map-zoom-in", "#map-zoom-out", ".resource-more summary", "#node-inspector-close"]) {
          for (const element of page.document.querySelectorAll(selector)) assert.ok(element.querySelector("svg"), selector)
        }
      }
    } finally { await page.close() }
  }
})

test("controls initialize and poll status while updating remote host icons", async () => {
  const page = openPage("controls")
  let app: ReturnType<typeof startSystemStatus> | undefined
  try {
    const system = readContract("system-v2.json")
    assert.ok(isSystemStatus(system))
    page.setFetch(() => json(system))
    app = startSystemStatus(page.document, { autoStart: false })
    const cardIcon = page.document.querySelector<HTMLElement>('[data-component-id="remote"] .resource-icon')!
    const mapIcon = page.document.querySelector<HTMLElement>('[data-node-id="remote"] [data-node-icon]')!
    assert.equal(cardIcon.dataset.icon, "system", "initial render works without supervisor data")
    assert.equal(mapIcon.dataset.icon, "system")
    for (const [remote, name] of [
      [{ id: "codespaces", label: "GitHub Codespace" }, "github"],
      [{ id: "ssh", label: "Linux VPS" }, "system"],
    ] as const) {
      Object.assign(system.remote, remote)
      await app.refresh()
      assert.notEqual(page.document.getElementById("control-connection")!.textContent, "Checking…")
      assert.equal(page.document.getElementById("architecture-data-state")!.textContent, "Live supervisor data")
      assert.equal(cardIcon.dataset.icon, name)
      assert.equal(mapIcon.dataset.icon, name)
      assert.ok(cardIcon.querySelector("svg"))
      assert.ok(mapIcon.querySelector("svg"))
    }
  } finally { app?.destroy(); await page.close() }
})

test("switching setup provider updates GitHub and SSH SVGs, including restored setup", async () => {
  const page = openPage("controls")
  try {
    const root = page.document.getElementById("remote-setup")!
    const feature = mountSetup(root, () => undefined)
    const system = readContract("system-v2.json")
    assert.ok(isSystemStatus(system))
    const status = { version: 1 as const, required: true, available: true, busy: false, last_error: "", target: null }
    feature.update(status, system, false)
    const provider = page.document.getElementById("setup-provider") as HTMLSelectElement
    const icon = page.document.getElementById("setup-provider-icon")!
    const expectIcon = (name: IconName) => {
      const expected = page.document.createElement("span")
      expected.innerHTML = iconMarkup(name, 16)
      assert.equal(icon.innerHTML, expected.innerHTML)
    }
    expectIcon("terminal")
    provider.value = "codespaces"
    page.fire(provider, "change")
    expectIcon("github")
    provider.value = "ssh"
    page.fire(provider, "change")
    expectIcon("terminal")
    feature.update({ ...status, target: { provider: "codespaces", target: "example", remote_directory: "~/relay", ssh_port: 22, remote_port: 8787 } }, system, false)
    expectIcon("github")
  } finally { await page.close() }
})
