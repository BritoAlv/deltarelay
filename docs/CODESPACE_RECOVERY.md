# Recover the existing Codespace test deployment

This is an optional recovery procedure for an **already configured** private test
profile, not installation instructions. A fresh clone intentionally contains no
`.runtime/` profile, credentials, Codespace identifier, `recover.sh` wrapper, or
Desktop launcher. For a new computer or VPS, follow [SETUP.md](SETUP.md) instead.
The tracked Python helpers accept an explicit profile and Codespace name; they
never discover or provision the original developer's deployment from this repo.

## Start everything, including the dashboard and Desktop

From the project directory:

```sh
./startup.sh
# Automatic retries continue in the background across VPN/network changes.
# Recover the services and start the dashboard; leave Desktop closed.
./startup.sh --no-desktop
# Optional: skip the dashboard (does not stop an existing dashboard).
./startup.sh --no-dashboard
```

`startup.sh` now starts an independent local supervisor and the dashboard at
**http://127.0.0.1:8790** before attempting remote recovery. The dashboard remains
available during outages and offers service Start/Restart controls, persistent
auto-reconnect/auto-wake settings, an always-available manual Wake button, and a
ChatGPT access-token expiry countdown. **[SUPERVISION.md](SUPERVISION.md)** covers
the implementation, security, and reusable SSH/HTTPS VPS configuration.

It adopts the existing gateway on **18788** and the isolated Desktop profile;
neither is restarted just because the VPN changes. Initial Desktop launch uses
the existing private launcher and needs a graphical session. Without one, local
controls still work. `--no-desktop` leaves initial OpenCode/Desktop startup alone.
Your original Desktop profile and provider credentials are never modified.
Automatic Codespace wake is initially off because it resumes GitHub billing;
choose your preference in the dashboard. The old `--timeout` startup option is
accepted for compatibility but no longer bounds continuous monitoring.

Missing/stale dashboard builds are prepared automatically: Go builds the local
`bin/deltarelay` with module/toolchain downloads disabled, and pnpm builds Astro
using **only the offline package cache**. A missing cache or build tool produces
an actionable error, not a network download; use `--no-dashboard` to recover
without it. Existing up-to-date builds need no Go/pnpm invocation. An already
running supervised dashboard is reused. A verified legacy read-only dashboard is
upgraded so it can expose the controls. Startup does **not** replace or restart
the private deployed gateway binary. If it is too old to expose dashboard
diagnostics, startup warns; use the dashboard's explicit Restart action when safe
to begin recording sessions with the rebuilt local gateway.

The dashboard uses the existing profile's `local.token`, with the token kept out
of the browser and process arguments. Its PID is stored in
`.runtime/codespace-test/dashboard.pid`; supervised logs and settings live in
`.runtime/codespace-test/control/`. An unrecognized owner of the chosen port is
never killed or replaced. Set `DELTARELAY_DASHBOARD_PORT=8791` before the first
supervised startup to choose another loopback port. [DASHBOARD.md](DASHBOARD.md) covers
the UI, offline cache prerequisites, and measurement limits. Nothing is published
through a public port forward, and the launcher does not open an extra browser.

## Recover the services only

Run this instead when Desktop should remain closed:

```sh
.runtime/codespace-test/recover.sh
```

This is an **on-demand** recovery command; the dashboard supervisor provides the
continuous loop. Running both at once against the same services is not supported.
This legacy helper always wakes a stopped Codespace and does not consult the
dashboard's auto-wake setting. Starting a stopped Codespace resumes GitHub compute
usage/billing. It leaves GitHub's idle policy unchanged. Changing your default
idle timeout applies to new Codespaces; it does not change an existing
Codespace's recorded timeout.

Recovery uses the installed `gh`, Python 3 (standard library only), and the
existing private test deployment. It does not install or upgrade anything.

1. Check the existing Codespace; start it only if it is stopped, then wait for it.
2. Over authenticated SSH, find the existing store matching the saved local
   protocol-2 relay identity. Start the deployed relay only if it is missing.
3. Reuse or start the private port-forward supervisor and local gateway.
4. Verify the relay identity through the tunnel and run `doctor`.

Existing live processes are not stopped. Missing deployment files, mismatched or
missing identities, an ambiguous store, and unrecognized local port owners cause
recovery to fail closed. It never deletes cache files, clears cancellation records,
regenerates tokens, changes port visibility, weakens SSH/TLS verification, or
recreates the Codespace. The remote relay uses the test profile's documented
2 GiB cache and 10,000 request-record limits.

The retry window defaults to 10 minutes, with bounded connection attempts and
exponential backoff. For an unreliable connection, allow more time:

```sh
.runtime/codespace-test/recover.sh --timeout 1200
```

If recovery times out, rerunning it is safe. It checks again before starting
anything, including when SSH dropped after the remote relay successfully started.
Concurrent recovery commands for the same profile are refused. It does not
force-restart an available but unreachable Codespace.

The recovery step does **not** submit or replay inference, change provider
credentials, restart Desktop, or open another Desktop profile. `recover.sh` stops
after readiness; `startup.sh` instead starts its independent supervisor and leaves
it monitoring connectivity in the background. A completed saved response can be fetched by its
request ID;
generation interrupted by suspension is not automatically regenerated. The
existing gateway may deliver previously queued, explicit cancellations once
connectivity returns.

Implementation: `startup.sh` (the full start sequence) plus
`deploy/recover_codespace.py`, its self-contained remote helper
`deploy/recover_relay.py`, and `deploy/start_dashboard.py`. The private wrapper
only supplies the existing Codespace name and profile path; `startup.sh` calls
that wrapper, the local dashboard helper, and then the private Desktop launcher.
For equivalent direct invocation of recovery only:

```sh
python3 deploy/recover_codespace.py --codespace '<existing-codespace-name>' \
  --profile .runtime/codespace-test
```

The default remote deployment directory is
`~/.local/share/deltarelay/codespace-test`, with `~` resolved on the remote host.
Use `--remote-directory` if your existing deployment is somewhere else; no remote
username or personal home path is built into the helper.

This helper targets the existing test layout and ports **18787/18788**, not an
arbitrary new deployment. Remote startup diagnostics are appended privately to
`recovery-server.log` inside the existing remote deployment. Other logs remain
inside the private local profile. Tokens are read from files, never passed in
command arguments or printed.

Run offline regression tests with `make recovery-test`. They do not contact
GitHub, use real provider accounts, or modify the persistent test deployment.
To also exercise a real local relay stop/recovery and verify preserved identity
and zero repeated chunk uploads, build the binary and run:

```sh
make build
DELTARELAY_RECOVERY_TEST_BINARY="$PWD/bin/deltarelay" make recovery-test
```
