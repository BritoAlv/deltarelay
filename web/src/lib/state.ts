import { Channel } from "./events.js"
import type { ConnectionState } from "./system.js"
import type { Snapshot } from "./types.js"

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
}
