#!/usr/bin/env bash
# Start local controls before remote recovery; no network dependency for the UI.
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DELTARELAY_PROFILE:-}"
args=()
config=0
while (($#)); do
  case "$1" in
    --no-desktop|--no-dashboard) args+=("$1"); shift ;;
    --config)
      (($# >= 2)) || { echo 'startup.sh: --config needs a private JSON file' >&2; exit 1; }
      args+=(--config "$2"); config=1; shift 2 ;;
    --timeout)
      (($# >= 2)) || { echo 'startup.sh: --timeout needs seconds' >&2; exit 1; }
      echo 'Recovery now runs continuously with bounded attempts; --timeout is no longer needed.' >&2
      shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./startup.sh [--no-desktop] [--no-dashboard] [--config /private/profile.local.json]

Start/reuse the persistent local supervisor and dashboard before network recovery.
--config selects an existing remote-host deployment and optional provider plugin.
By default use $XDG_CONFIG_HOME/deltarelay/supervisor.json (or ~/.config/...);
DELTARELAY_PROFILE and the existing private Codespace profile remain supported.
No new deployment is provisioned.
Builds use Go and the offline pnpm cache; nothing is downloaded.

The supervisor survives closing the terminal or browser. Dashboard settings select
automatic reconnect and remote-host auto-wake (off initially, because billing may resume).
Wake/Stop appear only when supported. Restarts never erase tokens, cache, or history.
--no-desktop skips the initial OpenCode/Desktop launch.
--no-dashboard skips a new dashboard launch; existing services are left running.
Dashboard defaults to http://127.0.0.1:8790 (DELTARELAY_DASHBOARD_PORT overrides it
when the default private supervisor configuration is first generated).
EOF
      exit 0 ;;
    *) echo "startup.sh: unknown option: $1" >&2; exit 1 ;;
  esac
done
if ((!config)); then
  if [[ -n "$PROFILE" ]]; then
    args+=(--profile "$PROFILE")
  elif [[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json" ]]; then
    args+=(--config "${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json")
  elif [[ -f "$ROOT/.runtime/codespace-test/supervisor.local.json" || -f "$ROOT/.runtime/codespace-test/tunnel-supervisor.sh" ]]; then
    args+=(--profile "$ROOT/.runtime/codespace-test")
  else
    echo 'startup.sh: configure an existing remote host with --config /private/supervisor.json; see docs/REMOTE_PROVIDERS.md' >&2
    exit 1
  fi
fi
exec python3 -B "$ROOT/deploy/start_supervisor.py" --project "$ROOT" \
  --port "${DELTARELAY_DASHBOARD_PORT:-8790}" "${args[@]}"
