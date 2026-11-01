import { readTheme, resolveTheme, saveTheme, themeStorageKey, type Theme } from "../lib/themes.js"

const picker = document.getElementById("dashboard-theme") as HTMLSelectElement
const status = document.getElementById("theme-status")!
let storage: Storage | null = null
try { storage = window.localStorage } catch { /* The picker still works when storage is blocked. */ }

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme.id
  picker.value = theme.id
}

applyTheme(readTheme(storage))
picker.disabled = false
picker.addEventListener("change", () => {
  const theme = resolveTheme(picker.value)
  applyTheme(theme)
  const saved = saveTheme(theme.id, storage)
  status.textContent = `${theme.name} theme applied. ${saved ? "Saved on this browser." : "Browser storage is unavailable; this choice will not survive a reload."}`
})

window.addEventListener("storage", (event) => {
  if (event.storageArea !== storage || event.key !== null && event.key !== themeStorageKey) return
  const theme = resolveTheme(event.newValue)
  applyTheme(theme)
  status.textContent = `${theme.name} theme applied from another dashboard tab.`
})
