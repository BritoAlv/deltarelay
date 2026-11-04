// Add a palette here: the picker, CSS, and saved-preference validation all use
// this registry. Components and charts should only use these semantic tokens.
export const themeTokens = [
  "bg", "sidebar", "surface", "surface-raised", "border", "border-strong",
  "text", "muted", "subtle", "accent", "on-accent", "primary-start", "primary-end",
  "chart-original", "chart-reuse", "success", "warning", "danger", "shadow", "backdrop",
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
      bg: "#101216", sidebar: "#14171c", surface: "#181c22", "surface-raised": "#222832",
      border: "#2d3541", "border-strong": "#475366", text: "#edf1f7", muted: "#acb5c5", subtle: "#909bad",
      accent: "#87b8ff", "on-accent": "#101a29", "primary-start": "#1e2c40", "primary-end": "#19212d",
      "chart-original": "#8b98ac", "chart-reuse": "#c7a6ff", success: "#7bd4aa", warning: "#efc479", danger: "#f2999b",
      shadow: "#00000080", backdrop: "#0b0d15b0",
    },
  },
  {
    id: "porcelain", name: "Porcelain + Teal", mode: "light",
    colors: {
      bg: "#f3f6f7", sidebar: "#ffffff", surface: "#ffffff", "surface-raised": "#eaf0f2",
      border: "#d6e0e3", "border-strong": "#aebec5", text: "#182a32", muted: "#516570", subtle: "#5d707a",
      accent: "#087986", "on-accent": "#ffffff", "primary-start": "#e0f3f2", "primary-end": "#f6fcfb",
      "chart-original": "#889aa3", "chart-reuse": "#6f4bb2", success: "#16794f", warning: "#935c0a", danger: "#b83a44",
      shadow: "#182a3226", backdrop: "#0b0d1580",
    },
  },
  {
    id: "midnight", name: "Midnight + Violet", mode: "dark",
    colors: {
      bg: "#121019", sidebar: "#17141f", surface: "#1d1928", "surface-raised": "#282236",
      border: "#373044", "border-strong": "#5d5075", text: "#f3effa", muted: "#bcb0cc", subtle: "#a094b3",
      accent: "#b9a0ff", "on-accent": "#211530", "primary-start": "#302542", "primary-end": "#211b30",
      "chart-original": "#978ba9", "chart-reuse": "#7fd4d0", success: "#83d3b2", warning: "#e8c07b", danger: "#f5a0ab",
      shadow: "#00000080", backdrop: "#0b0d15b0",
    },
  },
  {
    id: "sand", name: "Sand + Terracotta", mode: "light",
    colors: {
      bg: "#f5f1ea", sidebar: "#fbf8f3", surface: "#fffcf7", "surface-raised": "#eee6db",
      border: "#ded4c6", "border-strong": "#b9a995", text: "#352b25", muted: "#706055", subtle: "#7a685a",
      accent: "#a8492f", "on-accent": "#fffaf5", "primary-start": "#f5e2d5", "primary-end": "#fff7ef",
      "chart-original": "#a19283", "chart-reuse": "#2f6f7a", success: "#397454", warning: "#926009", danger: "#b43844",
      shadow: "#352b2526", backdrop: "#1c161080",
    },
  },
  {
    id: "forest", name: "Forest + Green (original)", mode: "dark",
    colors: {
      bg: "#101210", sidebar: "#131613", surface: "#171a17", "surface-raised": "#1d211d",
      border: "#2a3029", "border-strong": "#46513b", text: "#eceeea", muted: "#a1ab9a", subtle: "#83917b",
      accent: "#b5f18c", "on-accent": "#192515", "primary-start": "#202b1c", "primary-end": "#191e17",
      "chart-original": "#819777", "chart-reuse": "#8fc7ff", success: "#b5e99a", warning: "#e9c785", danger: "#f1a199",
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
