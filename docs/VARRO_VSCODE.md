# Varro + DeltaRelay in VS Code

Varro attaches to the **same OpenCode v2 service** as Desktop/TUI through the
shared frontend health gate. The gate is a default-on supervised local component
also used by OpenChamber: start `./deltarelay start`/`./startup.sh`, and the
supervisor starts the gate for you. OpenChamber and Varro can attach at the same
time to the same gate and service. VS Code/Varro is opened by you, or from the
dashboard's **Open** action when `vscode.open_command` is configured (see
[Open from the dashboard](#open-from-the-dashboard)).
That action runs the configured command once; the supervisor never starts the
editor automatically, restarts it, or manages it. The gate does not own, start,
stop, restart, or update the OpenCode service, gateway, tunnel/relay, or
provider, and it has no provider fallback.

```text
VS Code / Varro --\
                  \
OpenChamber --------> shared frontend health gate 127.0.0.1:18789
                  /    | health checks             | DeltaRelay plugin
                 /     +-> gateway 127.0.0.1:18788 -> tunnel/relay
Desktop / TUI ---------> same shared OpenCode service
```

OpenChamber is described in [OpenChamber + DeltaRelay](OPENCHAMBER.md). When it
is configured, it is a managed attach-only frontend that starts only from the
dashboard's component controls. OpenCode Desktop is manual-only on the same
basis; normal startup and **Start system** never open either frontend. The gate
is shared, so neither frontend owns or changes the other's lifecycle.

## Quick integration

1. Build and start DeltaRelay normally with `uv run ./deltarelay start` (or
   `./startup.sh`). The supervisor starts the gate at `gate_url` (default
   `http://127.0.0.1:18789`). Do not also start the manual `deltarelay gate`
   command on that port.
2. Install Varro in a dedicated VS Code profile, using a build compatible with
   your VS Code and Node versions (see [Install and configure
   Varro](#install-and-configure-varro)).
3. Keep `varro.server.port` at `18789`, with `varro.server.autoStart` and
   `varro.server.autoUpdate` both `false`. Point Varro at the **gate** port, not
   the OpenCode service port, and never use `"auto"`.
4. Quit every VS Code window that uses that profile, then relaunch it without
   `OPENCODE_SERVER_*` variables when the gate has no password. If you configured
   a separate gate password, set both variables to that password as shown below.
5. Check readiness with `curl -fsS http://127.0.0.1:18789/healthz | jq` (add
   Basic auth when a gate password is configured). `/livez` proves only that the
   gate listener is running; `/healthz` also checks the gateway/relay, OpenCode
   v2 service, and optional workspace plugin.
6. Optional: set `vscode.open_command` in the supervisor configuration and
   restart the supervisor so the dashboard's **Varro in VS Code** card can launch
   that profile. The supervisor runs the command once and does not manage the
   editor afterwards.

The detailed prerequisites, failure behavior, acceptance checks, and rollback
follow.

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

## Shared supervised gate (default)

Generate/configure the supervisor as described in [supervision](SUPERVISION.md),
then start it normally:

```sh
uv run ./deltarelay start --config /private/supervisor.json
```

The supervisor starts the gate on `gate_url` (default
`http://127.0.0.1:18789`) without starting or restarting OpenCode, OpenChamber,
Desktop, the relay, or the tunnel. Gate
liveness is checked locally by `GET /livez` with the private local token.
Attached frontend requests check the local OpenCode service and plugin;
`/healthz` also checks gateway forwarding. The map shows
`Varro in VS Code → Frontend health gate → OpenCode server` and
`OpenChamber → Frontend health gate → OpenCode server` alongside the existing
Desktop path. The gate card supports start, stop, restart, and recover.

New configurations and onboarding include `components.gate`. Existing
configurations with `opencode_service_file` get an in-memory default gate when
they omit it; add `components.gate` to persist custom settings, or
`"gate_default": false` to opt out. An explicit `components.gate` always wins.
Restart the supervisor after adding or changing an explicit gate command; live
managed children are not silently replaced. A synthesized gate is kept owned if
a reload omits it.

To verify the listener without printing the token:

```sh
curl -fsS -H "X-DeltaRelay-Local-Token: $(cat /private/local.token)" \
  http://127.0.0.1:18789/livez
```

`/livez` returns `{"alive":true,"version":1}` and never proxies or probes the
backend. It remains available when `--password-file` protects frontend traffic.

### Failure cases and controls

- **Gate stopped/recover:** OpenChamber and Varro cannot connect; Desktop/TUI and
  the shared OpenCode service are unaffected. Start/recover the gate from the
  dashboard or map. This never starts or stops the backend.
- **Listener failed, backend healthy:** the supervisor may restart the gate
  process. This is the only automatic gate restart policy.
- **Local service or plugin unavailable with a healthy listener:** the gate
  returns 503 with `service_down`, `plugin_unavailable`, or
  `registration_invalid`. The gate stays running and is **not** restarted; fix
  the OpenCode service or plugin independently. The map marks
  `gate → OpenCode` not ready.
- **Relay/VPS or gateway unavailable with a healthy local service:** the gate
  keeps forwarding attached frontends' local session, history, event, filesystem,
  and prompt requests, so OpenChamber and Varro can open and browse sessions even
  though `/healthz` reports 503 `gateway_down`. If the relay is down while the
  local gateway is running,
  the gateway holds the submitted prompt in its existing recovery window, stays
  loading until forwarding resumes, and returns 503 if that window expires. If
  the local gateway itself is down, prompts fail at the plugin (OpenCode retries
  are intentionally disabled), but local sessions still open. The gate is
  **not** restarted. The map keeps the gate and `gate → OpenCode` ready and marks
  `gate → gateway` not ready.
- **Unknown `/livez`** (401/403/404 or version mismatch): shown as unknown, not
  as proof that a restart helps.
- **Port occupied by an unknown owner:** reported, never killed or replaced.

### Rollback

Stop only the gate from the dashboard, or set `"gate_default": false` and restart
the supervisor (or remove the explicit `components.gate`). OpenChamber and Varro
lose their connection; Desktop/TUI and the backend remain untouched. Do not stop
or restart the relay or OpenCode service as part of gate rollback.

## Manual, non-supervisor gate

The following is an alternative for deployments that do not run the DeltaRelay
supervisor. It is mutually exclusive with the supervised gate on the same port:
stop one before starting the other, or choose a different listen port/`gate_url`.

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

For a manual systemd deployment, adjust all paths in
`deploy/deltarelay-gate.service` (it is a non-supervisor option), install the
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

## Open from the dashboard

The Applications card **Varro in VS Code** can open the editor. Add this block to
the private supervisor configuration, then restart the supervisor:

```json
"vscode": {
  "open_command": ["/usr/bin/code", "--profile", "DeltaRelay", "/home/alvaro/proyectos/deltarelay"],
  "env": {"XDG_CONFIG_HOME": "/home/alvaro/proyectos/deltarelay/.runtime/codespace-test/profile/config"}
}
```

Use the same `XDG_CONFIG_HOME` that you used to install Varro in the DeltaRelay
profile, and omit `env` if the profile lives in the default location. The command
is an absolute argv with no shell and no `PATH` lookup. Each **Open** click runs it
once with the supervisor's environment minus OpenCode, token, password, and secret
variables, and minus VS Code IPC variables inherited from an integrated terminal,
so the request reaches the DeltaRelay profile rather than another editor instance.
Open does not start the gate, OpenCode, Desktop, the relay, or the tunnel, and it
works while the system is intentionally stopped. The supervisor does not track,
restart, stop, or observe the editor afterwards: the card keeps showing **Not
observed**. Editor output and launch failures go to `<profile>/control/vscode.log`
and the supervisor journal.

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

`/healthz` combines relay and local readiness. Each forwarded
request/stream/upgrade is gated only on local registration validity, service
`/api/info` v2 readiness, and optional workspace plugin activation. A relay
outage therefore does not block Varro from opening or browsing local sessions;
it is visible on `/healthz`. While the local gateway is running, model requests
wait for its recovery window instead of failing at the gate. A local failure
returns JSON HTTP 503 with
`ready: false`, `error: "backend_unavailable"`, a recovery message, and one of
`registration_invalid`, `service_down`, or `plugin_unavailable`. `/healthz`
uses the same shape and additionally reports `gateway_down` when the gateway is
unreachable, unready, or the VPS is not forwarding.

Local success and full `/healthz` success are cached independently for 2s by
default; failures are not cached. Registration is validated on every request
even during that cache window. For fresher local or health observations use
**`--health-cache 0s`**; the default permits an observation up to 2s old.
Existing streams are not killed on health changes. The existing DeltaRelay
plugin fails closed for generation.

Concurrent requests share an in-progress local probe, and `/healthz` requests
share a full probe, including with caching disabled. Network checks never hold
the gate's state lock; a burst of editor requests waits for one bounded local
probe rather than queueing separate round trips. Canceled waiting requests
return promptly. Forwarded requests have no response-header timeout, so long
generation can run until the client cancels. The 5s health deadline applies only
to readiness probes.

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
2. Relay down, service up: gate `/healthz` returns 503 `gateway_down`, while
   Varro still opens and browses local sessions. A submitted prompt stays
   loading through the gateway's recovery window and completes after the relay
   returns. No direct provider request and no new server process.
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

Stop only the gate: use the dashboard gate controls for a supervised deployment,
or `systemctl --user disable --now deltarelay-gate` for the manual unit. To keep
it from returning, set `"gate_default": false` and restart only the supervisor
(or remove an explicit `components.gate`). Disable/uninstall Varro in its profile,
or remove the three Varro workspace settings **after disabling Varro** (removing
them alone restores auto-start defaults). Remove the example manual unit if
installed. No backend/session/token/cache state is modified by the gate. If you
deliberately pinned the upstream port, restore its prior setting during a
maintenance window with `service set port` and `service restart`; do not do this
during active work. To remove the dashboard Open action, delete the `vscode` block
and restart the supervisor.
