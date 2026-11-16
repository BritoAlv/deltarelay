import { customRange, dateInputValue, dateTimeRange, DAY_MS, formatDateTime, lastRange, presetRange, trafficLastUnits, type TrafficLastUnit, type TrafficPreset, type TrafficRange } from "../../lib/traffic.js"
import type { Snapshot } from "../../lib/types.js"
import { readPreferences, readViewParams, replaceViewParams, savePreferences } from "../../lib/preferences.js"
import { requiredById } from "../dom.js"

interface Selection {
  preset: TrafficPreset
  amount: number
  unit: TrafficLastUnit
  start: string
  end: string
}

const presets: readonly TrafficPreset[] = ["24h", "7d", "30d", "90d", "last", "custom", "datetime"]

function resolve(selection: Selection, now: number) {
  if (selection.preset === "last") return lastRange(selection.amount, selection.unit, now)
  if (selection.preset === "custom") return customRange(selection.start, selection.end, now)
  if (selection.preset === "datetime") return dateTimeRange(selection.start, selection.end, now)
  return { range: presetRange(selection.preset, now) }
}

export function mountOverviewRange(root: HTMLElement, onChange: () => void) {
  const get = <T extends HTMLElement>(id: string) => requiredById<T>(root, id)
  const select = get<HTMLSelectElement>("chart-range")
  const relative = get("chart-relative")
  const custom = get("chart-custom")
  const amount = get<HTMLInputElement>("chart-last-amount")
  const unit = get<HTMLSelectElement>("chart-last-unit")
  const start = get<HTMLInputElement>("chart-start")
  const end = get<HTMLInputElement>("chart-end")
  const timestampStart = get<HTMLInputElement>("range-timestamp-start")
  const timestampEnd = get<HTMLInputElement>("range-timestamp-end")
  const dateMode = get<HTMLButtonElement>("range-mode-dates")
  const timestampMode = get<HTMLButtonElement>("range-mode-timestamps")
  const preview = get("range-timestamp-preview")
  const notice = get("overview-range-notice")
  const abort = new AbortController()
  const events = { signal: abort.signal }
  const initial = readViewParams(root.ownerDocument, "range")
  let now = Date.now()
  const requestedPreset = initial.get("range") as TrafficPreset
  const requestedUnit = initial.get("unit") as TrafficLastUnit
  let selection: Selection = {
    preset: presets.includes(requestedPreset) ? requestedPreset : "30d",
    amount: initial.has("last") ? Number(initial.get("last")) : 6,
    unit: trafficLastUnits.includes(requestedUnit) ? requestedUnit : "hours",
    start: initial.get("start") ?? "",
    end: initial.get("end") ?? "",
  }
  const editorMode = readPreferences(root.ownerDocument, "rangeEditor").mode
  let timestamps = selection.preset === "datetime" || (selection.preset !== "custom" && editorMode === "timestamps")
  let initialized = false
  select.value = selection.preset === "datetime" ? "custom" : selection.preset
  amount.value = String(selection.amount)
  unit.value = selection.unit
  if (timestamps) {
    timestampStart.value = selection.start
    timestampEnd.value = selection.end
  } else {
    start.value = selection.start
    end.value = selection.end
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  get("range-timezone").textContent = `Without an offset, times use ${timezone}.`

  function showError(message = "") {
    notice.textContent = message
    notice.hidden = !message
  }

  function syncUrl() {
    replaceViewParams(root.ownerDocument, "range", {
      range: selection.preset === "30d" ? null : selection.preset,
      last: selection.preset === "last" ? String(selection.amount) : null,
      unit: selection.preset === "last" ? selection.unit : null,
      start: selection.preset === "custom" || selection.preset === "datetime" ? selection.start : null,
      end: selection.preset === "custom" || selection.preset === "datetime" ? selection.end : null,
    })
  }

  function updatePreview() {
    const result = dateTimeRange(timestampStart.value, timestampEnd.value, now)
    preview.textContent = result.range ? `Will apply: ${formatDateTime(result.range.start)} → ${formatDateTime(result.range.end)}` : "Enter both timestamps to preview the interpreted range."
  }

  function visibility() {
    relative.hidden = select.value !== "last"
    custom.hidden = select.value !== "custom"
    get("range-date-fields").hidden = timestamps
    get("range-timestamp-fields").hidden = !timestamps
    dateMode.setAttribute("aria-pressed", String(!timestamps))
    timestampMode.setAttribute("aria-pressed", String(timestamps))
    updatePreview()
  }

  function apply(next: Selection, inputs: HTMLInputElement[] = []) {
    const result = resolve(next, now)
    for (const input of [amount, start, end, timestampStart, timestampEnd]) input.removeAttribute("aria-invalid")
    if (!result.range) {
      for (const input of inputs) input.setAttribute("aria-invalid", "true")
      showError(result.error)
      inputs[0]?.focus()
      return
    }
    selection = next
    showError()
    syncUrl()
    onChange()
  }

  select.addEventListener("change", () => {
    showError()
    visibility()
    if (select.value === "last") apply({ ...selection, preset: "last", amount: Number(amount.value), unit: unit.value as TrafficLastUnit }, [amount])
    else if (select.value === "custom") {
      if (!start.value) start.value = dateInputValue(now - 7 * DAY_MS)
      if (!end.value) end.value = dateInputValue(now)
      // Opening an editor doesn't discard the last successfully applied range.
    } else apply({ ...selection, preset: select.value as TrafficPreset })
  }, events)
  for (const [button, mode] of [[dateMode, false], [timestampMode, true]] as const) {
    button.addEventListener("click", () => {
      timestamps = mode
      savePreferences(root.ownerDocument, "rangeEditor", { mode: mode ? "timestamps" : "dates" })
      showError()
      visibility()
    }, events)
  }
  const lastApply = get<HTMLButtonElement>("chart-last-apply")
  const dateApply = get<HTMLButtonElement>("chart-apply")
  const timestampApply = get<HTMLButtonElement>("range-timestamp-apply")
  lastApply.addEventListener("click", () => apply({ ...selection, preset: "last", amount: Number(amount.value), unit: unit.value as TrafficLastUnit }, [amount]), events)
  dateApply.addEventListener("click", () => apply({ ...selection, preset: "custom", start: start.value, end: end.value }, [start, end]), events)
  timestampApply.addEventListener("click", () => apply({ ...selection, preset: "datetime", start: timestampStart.value.trim(), end: timestampEnd.value.trim() }, [timestampStart, timestampEnd]), events)
  for (const input of [timestampStart, timestampEnd]) input.addEventListener("input", updatePreview, events)
  for (const [inputs, button] of [[[amount], lastApply], [[start, end], dateApply], [[timestampStart, timestampEnd], timestampApply]] as const) {
    for (const input of inputs) input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); button.click() }
    }, events)
  }
  visibility()

  return {
    render(snapshot: Snapshot | null, clock?: number): TrafficRange {
      now = clock ?? (snapshot ? Date.parse(snapshot.collected_at) : Date.now())
      if (!initialized && snapshot) {
        initialized = true
        if (selection.preset === "custom" && !selection.start && !selection.end) {
          selection = { ...selection, start: dateInputValue(now - 7 * DAY_MS), end: dateInputValue(now) }
          start.value = selection.start
          end.value = selection.end
        }
        const result = resolve(selection, now)
        if (!result.range) {
          showError(result.error)
          selection = { ...selection, preset: "30d" }
          select.value = "30d"
          visibility()
        }
        syncUrl()
      }
      const range = resolve(selection, now).range ?? presetRange("30d", now)
      get("overview-range-summary").textContent = range.label
      updatePreview()
      return range
    },
    destroy() { abort.abort() },
  }
}
