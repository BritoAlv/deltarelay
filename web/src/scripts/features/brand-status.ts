import type { SystemStatus } from "../../lib/system.js"

export type BrandStatus = "connected" | "recovering" | "stopped" | "disconnected" | "unknown"

export function brandStatus(system: SystemStatus | null, stale: boolean): BrandStatus {
  if (!system || stale || system.error) return "unknown"
  if (system.recovery.busy) return "recovering"
  if (system.relay_state === "connected") return "connected"
  if (system.recovery.next_retry_at) return "recovering"
  if (system.recovery.last_error === "system_stopped" || system.remote.host_state === "stopped") return "stopped"
  return "disconnected"
}

export function renderBrandStatus(doc: Document, system: SystemStatus | null, stale: boolean): void {
  const status = brandStatus(system, stale)
  const label = status === "unknown" ? "Status unavailable" : status[0]!.toUpperCase() + status.slice(1)
  const brand = doc.querySelector<HTMLAnchorElement>(".brand")
  if (brand) {
    brand.dataset.status = status
    brand.title = `DeltaRelay: ${label} · Overview`
    brand.setAttribute("aria-label", `DeltaRelay: ${label} · Overview`)
  }
  const compactBrand = doc.querySelector<HTMLElement>(".topbar-brand")
  if (compactBrand) compactBrand.dataset.status = status
  const favicon = doc.querySelector<HTMLLinkElement>('link[rel="icon"]')
  const href = status === "unknown" ? "/favicon.svg" : `/_astro/favicon-${status === "disconnected" ? "stopped" : status}.svg`
  if (favicon && favicon.getAttribute("href") !== href) favicon.setAttribute("href", href)
}
