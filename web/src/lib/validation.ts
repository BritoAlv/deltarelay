// Primitives for the two JSON diagnostics boundaries, not UI calculations.
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

export function counters(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => nonnegativeInteger(value[key]))
}

export function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

export function timestamp(value: unknown): value is string {
  // Date.parse alone accepts numbers, date-only strings, and rollover dates
  // such as February 30. Producers use RFC3339 (including Go's nanoseconds).
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return Number(value.slice(8, 10)) <= days[month - 1]! && Number.isFinite(Date.parse(value))
}

export function optionalTimestamp(value: unknown): boolean {
  return value === undefined || timestamp(value)
}

export function nullableTimestamp(value: unknown): boolean {
  return value === null || timestamp(value)
}
