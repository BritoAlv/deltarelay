import { requestInRange, trafficData, type TrafficData, type TrafficRange } from "./traffic.js"
import type { Snapshot } from "./types.js"

export interface OverviewData {
  range: TrafficRange
  traffic: TrafficData
  sessions: number
  activeSessions: number
  running: number
  incompleteSessions: boolean
}

/** One resolved window and one set of byte totals for every overview surface. */
export function overviewData(snapshot: Snapshot, range: TrafficRange, host = ""): OverviewData {
  const sessions = new Set<string>()
  const activeSessions = new Set<string>()
  let running = 0
  let finished = 0
  const now = Date.parse(snapshot.collected_at)
  for (const request of snapshot.history.recent_requests) {
    if (host && (request.host || "local") !== host) continue
    const started = Date.parse(request.started_at)
    const active = request.state === "running" && range.end >= now && started >= range.start && started <= now
    if (!active && !requestInRange(request, range)) continue
    if (!active) finished++
    sessions.add(request.session_id)
    if (active) {
      activeSessions.add(request.session_id)
      running++
    }
  }
  const traffic = trafficData(snapshot, range, host)
  return { range, traffic, sessions: sessions.size, activeSessions: activeSessions.size, running,
    incompleteSessions: snapshot.history.dropped_requests > 0 || snapshot.history.evicted_sessions > 0 || finished < traffic.totals.requests }
}
