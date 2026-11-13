import type { Session } from "./types.js"
import { savings, sessionHost, type SessionView } from "./metrics.js"

// Prefix spreadsheet formulas in text fields; CSV can be active content.
export function csvCell(value: string | number): string {
  return `"${String(value).replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`
}

export function sessionCsv(sessions: (Session | SessionView)[]): string {
  const rows: (string | number)[][] = [
    ["session_id", "hosts", "upstream", "requests", "active", "failed", "legacy", "cancelled", "body_bytes", "encoded_upload_bytes", "saved_bytes", "reduction_percent", "last_activity"],
    ...sessions.map((session) => [
      session.id || "unattributed",
      (session as SessionView).hosts?.join(", ") ?? sessionHost(session),
      session.upstream,
      session.requests,
      session.active,
      session.failed,
      session.legacy ?? 0,
      session.cancelled,
      session.body_bytes,
      session.encoded_upload_bytes,
      session.body_bytes - session.encoded_upload_bytes,
      savings(session.body_bytes, session.encoded_upload_bytes)?.toFixed(2) ?? "",
      session.updated_at,
    ]),
  ]
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
}
