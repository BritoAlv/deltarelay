import { Channel } from "./events.js"
import type { AuthStatus, ConnectionState, GoAllowance } from "./system.js"
import type { OpenCodeSessions, Snapshot } from "./types.js"

export interface SystemObservation {
  /** Authenticated relay state derived from the independent supervisor. */
  connection: ConnectionState
  /** Supervisor observation time, if the last poll succeeded. */
  collectedAt: string | null
  /** Browser receipt time for the last supervisor poll. */
  receivedAt: number | null
  /** True when the supervisor endpoint failed or returned stale metadata. */
  stale: boolean
  /** Whether the supervisor manages service controls for this profile. */
  managed: boolean
  /** OpenCode OAuth metadata, when the system poll has it. */
  auth: AuthStatus | null
  /** OpenCode Go allowance, when the local service reports it. */
  go: GoAllowance | null
}

// Five-second system polling can legitimately miss one or two ticks during a
// slow operation. Beyond this window the observation is no longer "fresh" and
// must not be presented as a live connection state.
export const SYSTEM_OBSERVATION_MAX_AGE_MS = 15_000

export const systemObservations = new Channel<SystemObservation | null>()

export function observationConnection(observation: SystemObservation | null, now = Date.now()): ConnectionState {
  if (!observation || observation.stale || observation.receivedAt === null) return "unknown"
  if (now - observation.receivedAt > SYSTEM_OBSERVATION_MAX_AGE_MS) return "unknown"
  return observation.connection
}

export interface DashboardViewState {
  snapshot: Snapshot | null
  stale: boolean
  paused: boolean
  busy: boolean
  error: string
  system: SystemObservation | null
  /** Selected remote-host label; empty means all hosts. */
  host: string
  /** Optional local OpenCode session catalog used by the measurement page. */
  catalog?: OpenCodeSessions | null
  /** Catalog-specific failure, kept separate from gateway snapshot staleness. */
  catalogError?: string
}
