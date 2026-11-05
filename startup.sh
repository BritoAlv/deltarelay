#!/usr/bin/env bash
# Start local controls before remote recovery; no network dependency for the UI.
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
args=()
config=0
while (($#)); do
  case "$1" in
    --no-desktop|--no-dashboard) args+=("$1"); shift ;;
    --config)
      (($# >= 2)) || { echo 'startup.sh: --config needs a private JSON file' >&2; exit 1; }
      args+=(--config "$2"); config=1; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./startup.sh [--no-desktop] [--no-dashboard] [--config /private/profile.local.json]

Start/reuse the persistent local supervisor and dashboard before network recovery.
--config selects a private remote-host deployment and its provider plugin.
By default use $XDG_CONFIG_HOME/deltarelay/supervisor.json (or ~/.config/...);
if missing, open first-run remote setup in the dashboard's System controls.
Remote installation requires selecting a host and explicitly confirming setup.
Builds use Go and the offline pnpm cache; nothing is downloaded.

The supervisor survives closing the terminal or browser. Dashboard settings select
automatic reconnect and remote-host auto-wake (off initially, because billing may resume).
Wake/Stop appear only when supported. Restarts never erase tokens, cache, or history.
--no-desktop skips the initial OpenCode/Desktop launch.
--no-dashboard skips a new dashboard launch; existing services are left running.
Configure the dashboard address in the private supervisor configuration.
EOF
      exit 0 ;;
    *) echo "startup.sh: unknown option: $1" >&2; exit 1 ;;
  esac
done
if ((!config)); then
  args+=(--config "${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json" --setup)
fi
exec python3 -B "$ROOT/deploy/start_supervisor.py" --project "$ROOT" "${args[@]}"
