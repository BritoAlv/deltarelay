import type { Session } from "./types.js"
import { savings } from "./metrics.js"

// Prefix spreadsheet formulas in text fields; CSV can be active content.
export function csvCell(value: string | number): string {
  return `"${String(value).replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`
}

export function sessionCsv(sessions: Session[]): string {
  const rows: (string | number)[][] = [
    ["session_id", "upstream", "requests", "active", "failed", "body_bytes", "encoded_upload_bytes", "saved_bytes", "reduction_percent", "last_activity"],
    ...sessions.map((session) => [
      session.id || "unattributed",
      session.upstream,
      session.requests,
      session.active,
      session.failed,
      session.body_bytes,
      session.encoded_upload_bytes,
      session.body_bytes - session.encoded_upload_bytes,
      savings(session.body_bytes, session.encoded_upload_bytes)?.toFixed(2) ?? "",
      session.updated_at,
    ]),
  ]
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
}
