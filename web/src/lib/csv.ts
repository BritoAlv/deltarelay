import type { Session } from "./types.js"
import { savings, sessionHost, type SessionView } from "./metrics.js"

// Prefix spreadsheet formulas in text fields; CSV can be active content.
export function csvCell(value: string | number): string {
  return `"${String(value).replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`
}

export interface SessionCsvUsage {
  apiKeys: string
  inputTokens: number | null
  outputTokens: number | null
  latestContext: number | null
  peakContext: number | null
}

export function sessionCsv(sessions: (Session | SessionView)[], usage: (session: Session | SessionView) => SessionCsvUsage | undefined = () => undefined): string {
  const rows: (string | number)[][] = [
    ["session_id", "hosts", "upstream", "requests", "active", "failed", "legacy", "cancelled", "body_bytes", "encoded_upload_bytes", "saved_bytes", "reduction_percent", "last_activity", "api_key_labels", "input_tokens", "output_tokens", "latest_context_tokens", "peak_context_tokens"],
    ...sessions.map((session) => {
      const measured = usage(session)
      return [
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
        measured?.apiKeys ?? "",
        measured?.inputTokens ?? "",
        measured?.outputTokens ?? "",
        measured?.latestContext ?? "",
        measured?.peakContext ?? "",
      ]
    }),
  ]
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
}
