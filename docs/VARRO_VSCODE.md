# Varro + DeltaRelay in VS Code

Varro attaches to the **same OpenCode v2 service** as Desktop/TUI through a
loopback health gate. It does not own, start, stop, restart, or update that service.
The supervisor, gateway, tunnel/relay, and profile service must be started
**independently**. The gate never starts them and has no provider fallback.

```text
VS Code / Varro -> gate 127.0.0.1:18789 -> profile OpenCode shared service
                    | health checks             | DeltaRelay plugin
                    +-> gateway 127.0.0.1:18788 -> tunnel/relay
Desktop / TUI --------------------------> same shared service
```

## Prerequisites and direct-attach check

Use OpenCode v2 and Varro with attach-only/v2 support. The downloaded package
checked for this implementation is **koltyakov.varro 0.34.6**. It declares
VS Code >=1.107.0 and Node ^22.22.2 or >=24.15.0. Its package settings support
explicit ports, `autoStart: false`, and `autoUpdate: false`.

Do not restart a service with active Desktop/TUI sessions just to pin a port.
The gate follows dynamic ports/passwords in the profile registration. If you
want a fixed upstream port, schedule a maintenance window first:

```sh
.runtime/codespace-test/profile-opencode.sh service get port
.runtime/codespace-test/profile-opencode.sh service set port 4096
.runtime/codespace-test/profile-opencode.sh service restart
.runtime/codespace-test/profile-opencode.sh service status
```

Before interactive gate acceptance, verify Varro can attach directly. Temporarily
set `varro.server.port` to the port in the profile's `service.json`, with
`varro.server.autoStart` and `varro.server.autoUpdate` both false. Fully quit
VS Code first (a reused process may retain its old extension-host environment):

```sh
OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD="$(jq -r .password \
  .runtime/codespace-test/profile/state/opencode/service.json)" \
  code --profile DeltaRelay /home/alvaro/proyectos/deltarelay
```

Confirm the same workspace sessions/providers, a relayed prompt, and native
file diff/open-file actions. No new OpenCode server should appear. Never print
the password, enable shell tracing, or put credentials in workspace settings.
If direct attach fails, diagnose it before relying on the gate.

## Build and run the gate

```sh
go build -o bin/deltarelay ./cmd/deltarelay
./bin/deltarelay gate \
  --listen 127.0.0.1:18789 \
  --service-file .runtime/codespace-test/profile/state/opencode/service.json \
  --gateway http://127.0.0.1:18788 \
  --local-token-file .runtime/codespace-test/local.token \
  --workspace-directory /home/alvaro/proyectos/deltarelay \
  --health-cache 2s
```

Use the **actual** profile registration, not a copied snapshot: rotation must be
visible. The file must be regular, mode 0600 or stricter, and contain a v2
version, positive PID, nonempty password, and a literal-loopback HTTP origin
with explicit port. The PID is only identity metadata; the gate never signals it.
No URL credentials, path prefixes, queries, fragments, HTTPS, or remote hosts
are accepted. Both IPv4 and IPv6 loopback are supported.

Omit `--workspace-directory` to skip the plugin check; otherwise the gate
requires the `deltarelay` plugin to be active at that exact location. The token
loader follows existing CLI conventions: an explicit private token file takes
precedence over `DELTARELAY_LOCAL_TOKEN`, without fallback on invalid files.

For systemd, adjust all paths in `deploy/deltarelay-gate.service`, install the
binary at the unit's `ExecStart` path, then:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/deltarelay-gate.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now deltarelay-gate
journalctl --user -u deltarelay-gate -f
```

There is deliberately **no dependency that starts/stops the backend**. Restart
policies apply only to the gate. Keep the gate and shared service loopback-only;
never expose them publicly.

## Install and configure Varro

Install the downloaded VSIX in a dedicated VS Code profile:

```sh
code --profile DeltaRelay --new-window /home/alvaro/proyectos/deltarelay
code --profile DeltaRelay --install-extension /path/to/varro.vsix
```

The first command creates the profile if needed. VS Code uses
`$XDG_CONFIG_HOME/Code` when `XDG_CONFIG_HOME` is set. Use the same environment
when installing and launching, or explicitly supply `--user-data-dir` to both.

In the local setup prepared here, the dedicated profile lives under
`.runtime/codespace-test/profile/config/Code`, not the normal desktop VS Code
configuration. Launch it with `sh .runtime/codespace-test/start-varro.sh`.
That editor-only launcher does not start the gate or any backend process.

Some downloads are named `Microsoft.VisualStudio.Services.VSIXPackage`; copy
that ZIP-format package to a `.vsix` filename before using the CLI installer.
The repository's `.vscode/settings.json` supplies:

```json
{
  "varro.server.autoStart": false,
  "varro.server.autoUpdate": false,
  "varro.server.port": 18789
}
```

Keep the same settings in the dedicated profile's **User settings** if you open
other workspaces, so Varro cannot default to managing a server there. Never use
`"auto"` as the port. Explicit ports do not fall back to another port. Older
Varro builds may label autoStart deprecated/debug-only; confirm behavior against
your installed build. Version 0.34.6 documents attach-only explicitly.

The default gate has no client password: quit VS Code after the direct-attach
check, remove `OPENCODE_SERVER_*` from its launch environment, and launch:

```sh
env -u OPENCODE_SERVER_USERNAME -u OPENCODE_SERVER_PASSWORD \
  code --profile DeltaRelay /home/alvaro/proyectos/deltarelay
```

The gate discards client Authorization and injects the current service password.
For optional local authentication, add `--password-file /private/gate-password`
(private regular file, mode 0600). This is a **separate gate password**, not the
rotating service password. Launch a fresh VS Code process with:

```sh
OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD="$(cat /private/gate-password)" \
  code --profile DeltaRelay /home/alvaro/proyectos/deltarelay
```

With this flag, `/healthz` also requires Basic auth. The default unprotected
loopback endpoint is accessible to other local processes, just like the local
editor; use gate authentication on shared machines.

## Health and failure semantics

```sh
curl -fsS http://127.0.0.1:18789/healthz | jq
curl -fsS http://127.0.0.1:18789/api/info | jq .version
```

`GET /healthz` is local, never proxied. Successful health looks like:

```json
{
  "ready": true,
  "gateway": {"ready": true, "forwarding": true},
  "service": {"ready": true, "version": "2.2.6"},
  "plugin": {"ready": true, "id": "deltarelay"}
}
```

Each new request/stream/upgrade is gated on authenticated gateway readiness and
VPS forwarding, service `/api/info` v2 readiness, and optional workspace plugin
activation. Failure returns JSON HTTP 503, with `ready: false`,
`error: "backend_unavailable"`, a recovery message, and one of:

- `registration_invalid`: missing/invalid/unsafe registration
- `gateway_down`: gateway unreachable, unready, or VPS not forwarding
- `service_down`: service unreachable, incompatible, or unauthorized
- `plugin_unavailable`: plugin missing, inactive, or unverifiable

Success is cached for 2s by default; failures are not cached. Registration is
validated on every request even during that cache window. For immediate
relay-down detection on the next request use **`--health-cache 0s`**; the default
permits a readiness observation up to 2s old. Existing streams are not killed
on health changes. The existing DeltaRelay plugin fails closed for generation.

Concurrent requests share an in-progress health probe, including with caching
disabled. Network checks never hold the gate's state lock; a burst of editor
requests waits for one bounded probe rather than queueing separate relay round
trips. Canceled waiting requests return promptly. Forwarded requests have no
response-header timeout, so long generation can run until the client cancels.
The 5s health deadline applies only to readiness probes.

Health GET probes re-read registration and retry once after connection/auth
failure. Forwarded requests are **never replayed**, including GETs and requests
with idempotency keys. If the service rotates between health and forwarding,
that request fails with 503; the next request/reconnect uses fresh registration.
This avoids duplicate generation. HTTP methods, bodies, paths, queries, SSE,
and WebSocket upgrades pass through; hop-by-hop and client credentials do not.
Bodies are not buffered. Logs contain method, path (no query), status, elapsed
time including health checks through response headers, and health reason;
never prompts/auth/tokens/bodies.

## Acceptance checks

Automated, without changing the running backend:

```sh
go test -race ./internal/gate ./cmd/deltarelay
go test ./...
```

Interactive checks (schedule disruptions; **do not stop an actively used
Desktop/TUI backend**):

1. Backend up: health ready, Varro connected, same workspace sessions, OpenAI
   and OpenCode Go models available. A short prompt increments gateway/dashboard
   counters; file edits open native diffs and file links open in VS Code.
2. Relay down, service up: after cache expiry (or with caching disabled), gate
   returns 503 `gateway_down`; reloaded Varro cannot connect/submit prompts.
   No direct provider request and no new server process.
3. Service down: 503 `service_down` or `registration_invalid`; Varro must not
   start a server. With both down, repeat and confirm no new process.
4. Restart service/rotate password: gate follows the new registration, then
   Varro reconnects (reload if necessary), without a stale 401 loop.
5. Gate down: Varro fails to connect, with no upstream-port/local-server fallback.
6. Continue a TUI/Desktop-created session in Varro, then reopen in TUI/Desktop:
   session identity and history remain the same.

Inspect `profile-opencode.sh service status`, process listings, and
`.runtime/codespace-test/control/gateway.log` before/after. UI prompt visibility,
native diffs, and same-session continuity need actual editor acceptance, not
just HTTP tests. Automated fixtures exercise failures without stopping services.

## Attach-only limitations

Manage server lifecycle, provider authentication, and global config from the
supervisor, CLI, Desktop, or TUI—not Varro. Attach-only does not provide:

- server start/restart/stop/update, local provider installation/login/logout;
- file-based global config/credential editing/watching, model routing/provider
  disabling, global `AGENTS.md`, or local v1-history import;
- project-persistent “Allow always” (use once/session/restart-scoped choices);
- local CLI terminal-session opening/export and Ask-agent startup injection;
- local-database usage reports beyond 250 sessions or local provider quota checks;
- a custom upstream URL/HTTPS setting (the gate supplies a fixed loopback port).

Capabilities vary by Varro/API version: 0.34.6 supports v2 server-side session
export and quota endpoints where available. Session token/cost reporting remains
available. Chat, sessions, providers/models, agents, skills, MCP discovery,
permissions, native diffs, and file opening use the shared service. This bridge
does not change which traffic the existing DeltaRelay plugin relays.

## Rollback

Stop only the gate (`systemctl --user disable --now deltarelay-gate` if used).
Disable/uninstall Varro in its profile, or remove the three Varro workspace
settings **after disabling Varro** (removing them alone restores auto-start
defaults). Remove the example unit if installed. No backend/session/token/cache
state is modified by the gate. If you deliberately pinned the upstream port,
restore its prior setting during a maintenance window with `service set port`
and `service restart`; do not do this during active work.
