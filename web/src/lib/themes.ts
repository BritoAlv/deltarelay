// Add a palette here: the picker, CSS, and saved-preference validation all use
// this registry. Components and charts should only use these semantic tokens.
// Map roles get their own tokens so boundaries never borrow an arrow color.
export const themeTokens = [
  "bg", "sidebar", "surface", "surface-raised", "border", "border-strong",
  "text", "muted", "subtle", "accent", "on-accent", "primary-start", "primary-end",
  "chart-original", "chart-reuse", "usage-model-1", "usage-model-2", "usage-model-3",
  "usage-model-4", "usage-model-5", "map-frontend", "map-backend", "map-context",
  "map-request", "map-response", "map-control", "success", "warning", "danger", "shadow", "backdrop",
] as const

export interface Theme {
  id: string
  name: string
  mode: "light" | "dark"
  colors: Record<typeof themeTokens[number], string>
}

export const themes = [
  {
    id: "graphite", name: "Graphite + Blue", mode: "dark",
    colors: {
      bg: "#0e1116", sidebar: "#111419", surface: "#151a21", "surface-raised": "#1b222b",
      border: "#252d38", "border-strong": "#3a4554", text: "#e9eef6", muted: "#9fabbc", subtle: "#7f8b9d",
      accent: "#6ea8fe", "on-accent": "#08111f", "primary-start": "#16202c", "primary-end": "#121821",
      "chart-original": "#7c8aa0", "chart-reuse": "#63c2c7",
      "usage-model-1": "#3987e5", "usage-model-2": "#d95926", "usage-model-3": "#199e70", "usage-model-4": "#c98500", "usage-model-5": "#d55181",
      "map-frontend": "#f2a08f", "map-backend": "#63c2c7", "map-context": "#9aa7ba",
      "map-request": "#6ea8fe", "map-response": "#7fd6a4", "map-control": "#e6bd72",
      success: "#69c99a", warning: "#e6bd72", danger: "#ef8e92",
      shadow: "#00000080", backdrop: "#080b10b0",
    },
  },
  {
    id: "porcelain", name: "Porcelain + Teal", mode: "light",
    colors: {
      bg: "#f3f6f7", sidebar: "#ffffff", surface: "#ffffff", "surface-raised": "#eaf0f2",
      border: "#d6e0e3", "border-strong": "#aebec5", text: "#182a32", muted: "#516570", subtle: "#5d707a",
      accent: "#087986", "on-accent": "#ffffff", "primary-start": "#e0f3f2", "primary-end": "#f6fcfb",
      "chart-original": "#889aa3", "chart-reuse": "#6f4bb2",
      "usage-model-1": "#2a78d6", "usage-model-2": "#c24f1f", "usage-model-3": "#0f7a55", "usage-model-4": "#9a6a00", "usage-model-5": "#b84772",
      "map-frontend": "#b0553c", "map-backend": "#2f6f9f", "map-context": "#6f828c",
      "map-request": "#087986", "map-response": "#16794f", "map-control": "#8a5a00",
      success: "#16794f", warning: "#935c0a", danger: "#b83a44",
      shadow: "#182a3226", backdrop: "#0b0d1580",
    },
  },
  {
    id: "midnight", name: "Midnight + Violet", mode: "dark",
    colors: {
      bg: "#121019", sidebar: "#17141f", surface: "#1d1928", "surface-raised": "#282236",
      border: "#373044", "border-strong": "#5d5075", text: "#f3effa", muted: "#bcb0cc", subtle: "#a094b3",
      accent: "#b9a0ff", "on-accent": "#211530", "primary-start": "#302542", "primary-end": "#211b30",
      "chart-original": "#978ba9", "chart-reuse": "#7fd4d0",
      "usage-model-1": "#3987e5", "usage-model-2": "#d95926", "usage-model-3": "#199e70", "usage-model-4": "#c98500", "usage-model-5": "#d55181",
      "map-frontend": "#f0a0c0", "map-backend": "#8fb8ff", "map-context": "#a5b0c0",
      "map-request": "#b9a0ff", "map-response": "#7fd4d0", "map-control": "#e8c07b",
      success: "#83d3b2", warning: "#e8c07b", danger: "#f5a0ab",
      shadow: "#00000080", backdrop: "#0b0d15b0",
    },
  },
  {
    id: "sand", name: "Sand + Terracotta", mode: "light",
    colors: {
      bg: "#f5f1ea", sidebar: "#fbf8f3", surface: "#fffcf7", "surface-raised": "#eee6db",
      border: "#ded4c6", "border-strong": "#b9a995", text: "#352b25", muted: "#706055", subtle: "#7a685a",
      accent: "#a8492f", "on-accent": "#fffaf5", "primary-start": "#f5e2d5", "primary-end": "#fff7ef",
      "chart-original": "#a19283", "chart-reuse": "#2f6f7a",
      "usage-model-1": "#2a78d6", "usage-model-2": "#c24f1f", "usage-model-3": "#0f7a55", "usage-model-4": "#9a6a00", "usage-model-5": "#b84772",
      "map-frontend": "#9a4a7a", "map-backend": "#2f6f7a", "map-context": "#7f8a92",
      "map-request": "#a8492f", "map-response": "#397454", "map-control": "#8a6a10",
      success: "#397454", warning: "#926009", danger: "#b43844",
      shadow: "#352b2526", backdrop: "#1c161080",
    },
  },
  {
    id: "forest", name: "Forest + Green (original)", mode: "dark",
    colors: {
      bg: "#101210", sidebar: "#131613", surface: "#171a17", "surface-raised": "#1d211d",
      border: "#2a3029", "border-strong": "#46513b", text: "#eceeea", muted: "#a1ab9a", subtle: "#83917b",
      accent: "#b5f18c", "on-accent": "#192515", "primary-start": "#202b1c", "primary-end": "#191e17",
      "chart-original": "#819777", "chart-reuse": "#8fc7ff",
      "usage-model-1": "#3987e5", "usage-model-2": "#d95926", "usage-model-3": "#199e70", "usage-model-4": "#c98500", "usage-model-5": "#d55181",
      "map-frontend": "#f2a48f", "map-backend": "#b9a0ff", "map-context": "#9fae9a",
      "map-request": "#b5f18c", "map-response": "#8fc7ff", "map-control": "#e9c785",
      success: "#b5e99a", warning: "#e9c785", danger: "#f1a199",
      shadow: "#00000080", backdrop: "#080d08bd",
    },
  },
] as const satisfies readonly Theme[]

export const defaultTheme = themes[0]
export const themeStorageKey = "deltarelay.dashboard.theme"

export function resolveTheme(value: unknown): Theme {
  return themes.find((theme) => theme.id === value) ?? defaultTheme
}

export function readTheme(storage: Pick<Storage, "getItem"> | null): Theme {
  try { return resolveTheme(storage?.getItem(themeStorageKey)) }
  catch { return defaultTheme }
}

export function saveTheme(value: unknown, storage: Pick<Storage, "setItem"> | null): boolean {
  if (!storage) return false
  try { storage.setItem(themeStorageKey, resolveTheme(value).id); return true }
  catch { return false }
}

export function themeStylesheet(): string {
  return themes.map((theme) => {
    const selector = `${theme.id === defaultTheme.id ? ":root, " : ""}:root[data-theme="${theme.id}"]`
    return `${selector} { color-scheme: ${theme.mode}; ${themeTokens.map((token) => `--${token}: ${theme.colors[token]};`).join(" ")} }`
  }).join("\n")
}

// A parser-blocking external script restores the palette before first paint.
// No inline JavaScript, eval, or relaxed script CSP is needed.
export function themeInitializationScript(): string {
  const backgrounds = Object.fromEntries(themes.map((theme) => [theme.id, theme.colors.bg]))
  return `(() => {
    let theme = ${JSON.stringify(defaultTheme.id)};
    try {
      const saved = localStorage.getItem(${JSON.stringify(themeStorageKey)});
      if (${JSON.stringify(themes.map((theme) => theme.id))}.includes(saved)) theme = saved;
    } catch {}
    document.documentElement.dataset.theme = theme;
    const backgrounds = ${JSON.stringify(backgrounds)};
    const meta = typeof document.querySelector === "function" ? document.querySelector('meta[name="theme-color"]') : null;
    if (meta) meta.setAttribute("content", backgrounds[theme] || backgrounds[${JSON.stringify(defaultTheme.id)}]);
  })();`
}
