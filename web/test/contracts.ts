import { readFileSync } from "node:fs"

export interface ContractCase {
  name: string
  fixture?: string
  supervisor_fixture?: string
  boundary?: string
  valid: boolean
  changes?: { path: string; value?: unknown; remove?: boolean; copies?: number }[]
}

// Tests run from .test-build/test/, independently of the caller's working dir.
export function readContract(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../testdata/contracts/${name}`, import.meta.url), "utf8"))
}

export function contractCases(name: string): ContractCase[] {
  return readContract(name) as ContractCase[]
}

export function contractPayload(c: ContractCase, fallback: string): unknown {
  const value = readContract(c.fixture ?? fallback)
  for (const change of c.changes ?? []) {
    const parts = change.path.split(".")
    // The test-only mutation format targets object fields, traversing arrays by
    // numeric index. It never ships in the dashboard bundle.
    let parent = value as Record<string, unknown>
    for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>
    const key = parts.at(-1)!
    if (change.remove) delete parent[key]
    else if (change.copies) parent[key] = Array.from({ length: change.copies }, () => structuredClone((parent[key] as unknown[])[0]))
    else parent[key] = structuredClone(change.value)
  }
  return value
}
