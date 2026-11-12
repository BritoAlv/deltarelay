import { readTheme, resolveTheme, saveTheme, themeStorageKey, type Theme } from "../lib/themes.js"

const pickers = [...document.querySelectorAll<HTMLSelectElement>("[data-theme-select]")]
const status = document.getElementById("theme-status")
let storage: Storage | null = null
try { storage = window.localStorage } catch { /* The picker still works when storage is blocked. */ }

function announce(message: string) {
  if (status) status.textContent = message
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme.id
  for (const picker of pickers) picker.value = theme.id
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.colors.bg)
}

function chooseTheme(value: string) {
  const theme = resolveTheme(value)
  applyTheme(theme)
  const saved = saveTheme(theme.id, storage)
  announce(`${theme.name} theme applied. ${saved ? "Saved on this browser." : "Browser storage is unavailable; this choice will not survive a reload."}`)
}

applyTheme(readTheme(storage))
for (const picker of pickers) {
  picker.disabled = false
  picker.addEventListener("change", () => chooseTheme(picker.value))
}

window.addEventListener("storage", (event) => {
  if (event.storageArea !== storage || event.key !== null && event.key !== themeStorageKey) return
  const theme = resolveTheme(event.newValue)
  applyTheme(theme)
  announce(`${theme.name} theme applied from another dashboard tab.`)
})
