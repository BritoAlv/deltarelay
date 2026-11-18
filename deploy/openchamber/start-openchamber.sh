#!/usr/bin/env bash
# Attach-only OpenChamber Desktop launcher.
#
# OpenChamber is a frontend only. This script points it at the DeltaRelay
# frontend health gate and never starts, stops, restarts, or updates OpenCode.
set -euo pipefail
umask 077

STATE="${DELTARELAY_OPENCHAMBER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/deltarelay/openchamber}"
GATE_URL="${DELTARELAY_GATE_URL:-http://127.0.0.1:18789}"
AUTH_FILE="${DELTARELAY_LOCAL_AUTH_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/local.token}"
GATE_AUTH_FILE="${DELTARELAY_GATE_AUTH_FILE:-}"
APP="${DELTARELAY_OPENCHAMBER_BINARY:-/opt/OpenChamber/openchamber}"

fail() {
  printf 'OpenChamber launcher: %s\n' "$1" >&2
  exit "${2:-75}"
}

[[ "$STATE" = /* ]] || fail 'DELTARELAY_OPENCHAMBER_STATE must be an absolute path' 76
case "$GATE_URL" in
  http://127.0.0.1:*|http://localhost:*|'http://[::1]:'*) ;;
  *) fail 'DELTARELAY_GATE_URL must be a loopback http origin with an explicit port' 75 ;;
esac
[[ "$GATE_URL" != */ ]] || GATE_URL="${GATE_URL%/}"
[[ -x "$APP" ]] || fail "OpenChamber Desktop is not installed at $APP" 1
command -v curl >/dev/null 2>&1 || fail 'curl is required for the gate preflight' 75
[[ -r "$AUTH_FILE" ]] || fail "missing DeltaRelay local token file: $AUTH_FILE" 75

# Do not inherit selectors, credentials, or a different OpenChamber instance.
while IFS= read -r variable; do
  case "$variable" in
    OPENCODE_*|OPENCHAMBER_*|*_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD)
      unset "$variable"
      ;;
  esac
done < <(compgen -e)
unset APPIMAGE ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_ENV LD_PRELOAD LD_LIBRARY_PATH

STATE_HASH="$(printf '%s' "$STATE" | sha256sum | cut -c1-8)"
SHORT_TMP="${XDG_RUNTIME_DIR:-/tmp}/deltarelay-oc-$STATE_HASH"
mkdir -p -- "$STATE/xdg/config" "$STATE/xdg/data" "$STATE/xdg/state" "$STATE/xdg/cache" \
  "$STATE/data" "$STATE/desktop" "$STATE/logs" "$SHORT_TMP"
chmod 700 -- "$STATE" "$STATE/xdg" "$STATE/xdg/config" "$STATE/xdg/data" \
  "$STATE/xdg/state" "$STATE/xdg/cache" "$STATE/data" "$STATE/desktop" \
  "$STATE/logs" "$SHORT_TMP"

TOKEN="$(tr -d '\r\n' < "$AUTH_FILE")"
[[ -n "$TOKEN" ]] || fail "DeltaRelay local token file is empty: $AUTH_FILE" 75

# Keep the token out of argv; curl reads the header from stdin.
if ! { printf 'header = "X-DeltaRelay-Local-Token: %s"\n' "$TOKEN"; } |
  curl -fsS --max-time 2 --config - "$GATE_URL/livez" >/dev/null; then
  fail 'DeltaRelay frontend health gate is not ready; OpenChamber was not launched' 75
fi

export XDG_CONFIG_HOME="$STATE/xdg/config"
export XDG_DATA_HOME="$STATE/xdg/data"
export XDG_STATE_HOME="$STATE/xdg/state"
export XDG_CACHE_HOME="$STATE/xdg/cache"
export TMPDIR="$SHORT_TMP"
export OPENCHAMBER_DATA_DIR="$STATE/data"
export OPENCHAMBER_DESKTOP_USER_DATA_DIR="$STATE/desktop"
export OPENCHAMBER_HOST=127.0.0.1
export OPENCODE_HOST="$GATE_URL"
export OPENCODE_SKIP_START=true

if [[ -n "$GATE_AUTH_FILE" ]]; then
  [[ -r "$GATE_AUTH_FILE" ]] || fail "missing gate password file: $GATE_AUTH_FILE" 75
  GATE_PASSWORD="$(tr -d '\r\n' < "$GATE_AUTH_FILE")"
  [[ -n "$GATE_PASSWORD" ]] || fail "gate password file is empty: $GATE_AUTH_FILE" 75
  export OPENCODE_SERVER_PASSWORD="$GATE_PASSWORD"
fi

printf 'OpenChamber launcher: gate=%s state=%s pid=%s\n' "$GATE_URL" "$STATE" "$$" >&2
exec "$APP" --user-data-dir="$STATE/desktop" "$@"
