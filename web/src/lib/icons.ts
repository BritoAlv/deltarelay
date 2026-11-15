import { providerMark } from "./provider-marks.js"

// Trusted, local SVG geometry only. See docs/dashboard-icons.md for sources.
const paths = {
  arrow: "M7 17 17 7 M7 7h10v10",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 11-2l3 3 M4 16l3 3a7 7 0 0 0 11-2",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  filter: "M3 4h18l-7 8v6l-4 2v-8L3 4z",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z m-4 9 3 3 5-5",
  info: "M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  close: "m6 6 12 12 M6 18 18 6",
  pause: "M8 5v14 M16 5v14",
  play: "m8 5 12 7-12 7V5z",
  activity: "M2 12h4l4-9 4 18 4-9h4",
  clock: "M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  measure: "m3 17 14-14 4 4L7 21z M8 12l2 2 M11 9l2 2 M14 6l2 2",
  link: "m9 15 6-6 M9 7l2-2a5 5 0 0 1 7 7l-2 2 M8 10l-2 2a5 5 0 0 0 7 7l2-2",
  bolt: "m13 2-9 12h7l-1 8 10-12h-7l1-8z",
  globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M2 12h20 M12 2c6 6 6 14 0 20-6-6-6-14 0-20",
  terminal: "m5 7 5 5-5 5 M13 17h6",
  desktop: "M3 4h18v12H3z M12 16v4 M8 20h8",
  code: "m8 8-4 4 4 4 M16 8l4 4-4 4 M14 4l-4 16",
  power: "M12 2v10 M6 5a9 9 0 1 0 12 0",
  plugin: "M8 3v5 M16 3v5 M5 8h14v5a7 7 0 0 1-14 0V8z M12 20v3",
  storage: "M20 5c0 4-16 4-16 0s16-4 16 0v14c0 4-16 4-16 0V5 M4 12c0 4 16 4 16 0",
  settings: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
  palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1.5 1.5 0 0 1 1.1-2.6H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9 M7 11h.01 M9 7h.01 M14 7h.01 M17 10h.01",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  "arrow-right": "M5 12h14 m-7-7 7 7-7 7",
} as const

const shapes = {
  overview: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  sessions: '<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>',
  system: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01 M6 18h.01"/>',
  gate: '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/><path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  relay: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3 M12 12V8"/>',
  browser: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18 M9 21V9"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
} as const

const brands = {
  // Original Inter SemiBold U+0394 outline (2048 units/em), not a stroked triangle.
  // Preserve the original em-box placement, including its flat apex and counter.
  deltarelay: { viewBox: "0 0 2048 2048", path: "M334 1769H1713L1188 279H860ZM694 1545 1018 583H1030L1356 1545Z" },
  github: { viewBox: "0 0 24 24", path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" },
  vscode: { viewBox: "0 0 128 128", path: "M90.767 127.126a7.968 7.968 0 0 0 6.35-.244l26.353-12.681a8 8 0 0 0 4.53-7.209V21.009a8 8 0 0 0-4.53-7.21L97.117 1.12a7.97 7.97 0 0 0-9.093 1.548l-50.45 46.026L15.6 32.013a5.328 5.328 0 0 0-6.807.302l-7.048 6.411a5.335 5.335 0 0 0-.006 7.888L20.796 64 1.74 81.387a5.336 5.336 0 0 0 .006 7.887l7.048 6.411a5.327 5.327 0 0 0 6.807.303l21.974-16.68 50.45 46.025a7.96 7.96 0 0 0 2.743 1.793Zm5.252-92.183L57.74 64l38.28 29.058V34.943Z" },
} as const

export type IconName = keyof typeof paths | keyof typeof shapes | keyof typeof brands | "opencode" | "openai"

export function remoteHostIcon(remote: { id: string; label: string } | undefined): IconName {
  return remote && /github|codespace/i.test(`${remote.id} ${remote.label}`) ? "github" : "system"
}

export function iconDefinition(name: IconName): { viewBox: string; body: string; brand: boolean } {
  if (name === "opencode" || name === "openai") {
    const mark = providerMark(name)
    return { viewBox: mark.match(/viewBox="([^"]+)"/)![1]!, body: mark.slice(mark.indexOf(">") + 1, mark.lastIndexOf("</svg>")), brand: true }
  }
  if (Object.hasOwn(brands, name)) {
    const mark = brands[name as keyof typeof brands]
    return { viewBox: mark.viewBox, body: `<path fill-rule="evenodd" d="${mark.path}"/>`, brand: true }
  }
  const body = Object.hasOwn(shapes, name) ? shapes[name as keyof typeof shapes] : Object.hasOwn(paths, name) ? `<path d="${paths[name as keyof typeof paths]}"/>` : null
  if (!body) throw new Error(`Unknown dashboard icon: ${name}`)
  return { viewBox: "0 0 24 24", body, brand: false }
}

export function iconMarkup(name: IconName, size = 20): string {
  const { viewBox, body, brand } = iconDefinition(name)
  if (!Number.isFinite(size) || size <= 0) throw new Error("Invalid icon size")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="${brand ? "currentColor" : "none"}" stroke="${brand ? "none" : "currentColor"}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
}
