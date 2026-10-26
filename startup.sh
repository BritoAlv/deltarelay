#!/usr/bin/env bash
# Recover the existing Codespace deployment, then open its OpenCode Desktop.
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DELTARELAY_PROFILE:-$ROOT/.runtime/codespace-test}"
PROFILE="${PROFILE%/}"
RECOVER="$PROFILE/recover.sh"
LAUNCH="$PROFILE/launch-desktop.sh"
PIDFILE="$PROFILE/desktop.pid"
DESKTOP_LOG="$PROFILE/logs/desktop.log"
DESKTOP_DIR="$PROFILE/desktop-profile"

usage() {
  cat <<'EOF'
Usage: ./startup.sh [--no-desktop] [recovery options]

Recover the existing private Codespace test deployment and, unless --no-desktop
is given, launch its isolated OpenCode Desktop profile. That profile uses the
recovered local gateway.

Options:
  --no-desktop       Recover relay/tunnel/gateway only; do not start Desktop.
  -h, --help         Show this help.

Recovery options are passed to .runtime/codespace-test/recover.sh, for example:
  --timeout 1200     Allow up to 20 minutes of bounded retries.

The script never starts a second copy when the isolated Desktop profile is
already running. It does not stop services, replay inference, or change tokens,
provider credentials, Codespace idle policy, or port visibility.
EOF
}

launch_desktop=1
recover_args=()
for argument in "$@"; do
  case "$argument" in
    --no-desktop) launch_desktop=0 ;;
    -h|--help) usage; exit 0 ;;
    *) recover_args+=("$argument") ;;
  esac
done

for required in "$RECOVER" "$LAUNCH"; do
  if [[ ! -x "$required" ]]; then
    echo "startup.sh: missing executable helper: $required" >&2
    echo "This launcher requires an existing private profile. For a fresh clone, follow docs/SETUP.md." >&2
    exit 1
  fi
done
if [[ ! -d "$PROFILE/project" ]]; then
  echo "startup.sh: missing existing test project: $PROFILE/project" >&2
  exit 1
fi
mkdir -p -m 700 "$PROFILE/logs"

# Serialize whole startups. recover.sh has its own recovery lock; this one also
# prevents two Desktop launches from racing after an idempotent recovery.
if ! command -v flock >/dev/null 2>&1; then
  echo "startup.sh: flock is required to serialize startup" >&2
  exit 1
fi
exec 9>"$PROFILE/.startup.lock"
if ! flock -n 9; then
  echo "startup.sh: another startup is already running for $PROFILE" >&2
  exit 1
fi

find_desktop_pid() {
  local proc pid cmd
  for proc in /proc/[0-9]*; do
    pid="${proc#/proc/}"
    [[ -r "$proc/cmdline" ]] || continue
    # Electron may rewrite its own argv, replacing NUL separators with spaces.
    # Normalize both forms before looking for the profile argument and app name.
    cmd="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null)" || continue
    [[ " $cmd " == *" --user-data-dir=$DESKTOP_DIR "* ]] || continue
    [[ "$cmd" == *"ai.opencode"* ]] || continue
    if [[ "$cmd" == *"--type="* ]]; then
      continue
    fi
    printf '%s\n' "$pid"
    return 0
  done
  return 1
}

echo "==> Recovering the existing Codespace deployment"
if ((${#recover_args[@]})); then
  "$RECOVER" "${recover_args[@]}" 9>&-
else
  "$RECOVER" 9>&-
fi

if ((!launch_desktop)); then
  echo "Recovery complete. Desktop was not started (--no-desktop)."
  exit 0
fi

if existing_pid="$(find_desktop_pid)"; then
  printf '%s\n' "$existing_pid" >"$PIDFILE"
  echo "OpenCode Desktop is already running for the isolated profile (PID $existing_pid)."
  exit 0
fi

if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "Recovery succeeded, but no graphical session is available (DISPLAY and WAYLAND_DISPLAY are unset)." >&2
  echo "Run startup.sh from your desktop terminal, or use --no-desktop." >&2
  exit 1
fi

echo "==> Starting the isolated OpenCode Desktop profile"
nohup "$LAUNCH" >>"$DESKTOP_LOG" 2>&1 </dev/null 9>&- &
desktop_pid=$!
printf '%s\n' "$desktop_pid" >"$PIDFILE"
sleep 2
if ! kill -0 "$desktop_pid" 2>/dev/null; then
  # A concurrent or undetected existing instance can take over the Electron
  # single-instance handoff and make this new process exit. Re-check before
  # treating that as a startup failure, and never discard a live PID record.
  if existing_pid="$(find_desktop_pid)"; then
    printf '%s\n' "$existing_pid" >"$PIDFILE"
    echo "OpenCode Desktop is already running for the isolated profile (PID $existing_pid; launch handed off)."
    exit 0
  fi
  rm -f "$PIDFILE"
  echo "startup.sh: Desktop exited during startup; see $DESKTOP_LOG" >&2
  exit 1
fi

echo "Ready. OpenCode Desktop is running (PID $desktop_pid) via the recovered gateway."
echo "Desktop log: $DESKTOP_LOG"
