# Network recovery and dashboard controls

`uv run ./deltarelay start` starts an independent Python 3 supervisor, the local Go dashboard,
and the shared frontend health gate **before** attempting remote recovery. Closing
the browser or terminal does not stop supervision. Nothing is installed at login,
no VPN settings are changed, and no inference or automatic direct-provider
fallback is introduced.

The gate is a supervised **local** component shared by OpenChamber and
Varro/VS Code, not a remote-provider plugin. It is default-on: a new
configuration includes `components.gate`, and an existing configuration with
`opencode_service_file` gets a safe gate component synthesized in memory when it
omits one. The private configuration file is not rewritten. Add
`"gate_default": false` to opt out; an explicit `components.gate` always wins.
The supervisor only starts from an existing absolute `deltarelay` dashboard or
gateway command; it never guesses an executable, service-manager command, shell,
or `PATH` lookup. See [OpenChamber + DeltaRelay](OPENCHAMBER.md) and
[Varro + VS Code](VARRO_VSCODE.md) for the attach-only paths.

Remote hosting is extensible through the versioned, language-independent
[remote-host provider contract](REMOTE_PROVIDERS.md). The bundled SSH, direct
HTTPS, and Codespaces providers manage existing deployments only. The dashboard
uses provider capabilities, not a hardcoded hosting vendor, for power controls.
For first-time installation on a selected SSH host/Codespace, the separate,
explicit [dashboard setup flow](REMOTE_SETUP.md) builds and installs the relay;
normal provider recovery still never initializes a store.

## Configure an existing remote host

```sh
uv run ./deltarelay start --config /private/supervisor.json
# Leave OpenCode and the managed frontend alone while starting local controls:
uv run ./deltarelay start --config /private/supervisor.json --no-frontend
# --no-desktop remains a supported alias for --no-frontend.
# Stop local services and the remote host, confirming remote shutdown:
uv run ./deltarelay stop --config /private/supervisor.json --yes
```

Run from the checkout with uv and Python 3.14 already installed. The launcher has
no Python dependencies and uv is configured offline with interpreter downloads
disabled. `--color auto|always|never` controls the styled startup stages;
auto uses plain text for redirected output, `NO_COLOR`, and dumb terminals.
Startup reports local readiness, not a promise that the remote host is connected.
The original `startup.sh` remains supported and uses the same supervisor.

Copy the current supervisor example and choose an executable `remote` provider
as described in [REMOTE_PROVIDERS.md](REMOTE_PROVIDERS.md). An explicit provider
is required. Without `--config`, startup reads
`${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json`. It never discovers
private test profiles. If the default configuration is missing, startup generates
local onboarding configuration and exposes the confirmed remote-setup form, not
automatic remote recovery. Existing configuration is never overwritten.
Set the dashboard address in that file; the example uses port 8790.

Codespaces use the bundled `deploy/providers/codespaces.py` plugin, just like
SSH and HTTPS deployments. Its private provider file accepts an optional
absolute `github_cli` path. Use a current GitHub CLI; the launcher never
downloads or upgrades it. The provider supplies the foreground tunnel command.

The controller adopts verified existing gateway, tunnel, and frontend processes.
It does not automatically replace running services to apply code changes.
Upgrade the relay, gateway, plugin, supervisor, and dashboard together, retaining
the existing identity pins, cache, replay journal, and response mailbox. Only
one manager should own each deployment's services; unknown port owners are never
killed or replaced. Controls do not depend on the gateway's `/dashboard` route.

## Regular SSH or HTTPS VPS

First complete [SETUP.md](SETUP.md), including SSH host trust and a working
gateway. Its `--state-dir` must contain the existing `relay-state.json` identity
pin; a missing pin is an error, never permission to silently adopt a new store.

Copy `deploy/supervisor.example.json` into a **private, untracked** file, replace
every placeholder, and make it mode 600. Create the configured `profile` directory
privately (mode 700). The sample now uses the SSH provider: also copy and configure
`deploy/providers/ssh.example.json` as its private `remote.config_file`. See
[provider configuration](REMOTE_PROVIDERS.md#configure-an-existing-host). Then:

```sh
./startup.sh --config /absolute/path/to/vps.local.json --no-frontend
```

All local paths in the configuration are absolute. `profile` stores only private
controller metadata/logs and the configured state; the example intentionally uses
the same identity/state directory as the gateway. Each component can use:

- `command`, `pid_file`, optional loopback `port`, and optional `directory` / `env`:
  a persistent local child owned/adopted by this controller.
- `start_command`, `restart_command`, `stop_command`, optional `status_command` /
  `env`: existing service-manager commands, such as SSH to a preconfigured
  systemd service. A component controlled only by service-manager commands needs
  an explicit `stop_command` before **Shut down system** is enabled; the
  supervisor never guesses a process to kill. `status_command` is used for
  lifecycle checks and must not mutate state.
- Optional `match` arguments for an executable that rewrites its argv (Desktop)
  or that must be distinguished by profile arguments (OpenChamber). Do not use
  broad process matches.
- Optional top-level `opencode_directory` (absolute path): enables a read-only
  OpenCode plugin-status check for that exact location. Without it, the map shows
  plugin loading as unknown. Configuration alone is not proof that the plugin
  loaded, and plugin status is not proof that provider access works.
- Optional top-level `gate_url` (default `http://127.0.0.1:18789`): a literal
  loopback `http://` origin with an explicit port, no credentials, path, query,
  or fragment. Required when `components.gate` is present. Optional top-level
  `gate_default` defaults to `true`; only `false` opts out of in-memory gate
  synthesis. An explicit `components.gate` always wins.
- Optional top-level `vscode` object for the dashboard's **Open** action on
  Varro in VS Code: `open_command` is an absolute argv (no shell, no PATH lookup),
  and optional `env` adds string variables. Each click runs the command once; the
  editor is never tracked, restarted, or stopped afterwards. Restart the supervisor
  after changing it.

The synthesized gate exists only for the running supervisor's lifetime. To
customize its command later, add an explicit `components.gate` and restart the
supervisor; a live managed child is never silently replaced. Until then, omitting
`components.gate` from a reload keeps the synthesized gate owned, consistent with
other managed components.

Commands are trusted local configuration, **not browser inputs**. Never put
tokens/passwords in command arguments. The SSH provider's example remote commands
assume an already-installed **user** unit. Change them to your existing service and
authorized noninteractive management method; the root service example in
`deploy/deltarelay-server.service` is not a user unit. No sudo permissions,
services, or SSH keys are installed automatically. Service-manager start commands
must be idempotent and must never create/reset the relay's store.

For direct HTTPS, select `deploy/providers/direct_https.py`, configure its private
file with the HTTPS `relay_url`, and set the supervisor URL and gateway's `--server`
to that same origin. Certificate verification remains mandatory; this provider
does not advertise service/power management. A custom provider can add explicit
authenticated management without a new public relay administration endpoint.
The `remote` provider exclusively owns the tunnel and relay; do not also declare
`components.tunnel` or `components.relay`.

Omit OpenCode and frontend components to leave them unmanaged, or configure only
the specific isolated profile you want controlled. In particular, do not
accidentally point service commands at another OpenCode profile. An optional
Desktop entry uses its existing launcher in `command`, a profile-specific `match`,
and a private `pid_file`. An optional OpenChamber entry uses
`deploy/openchamber/start-openchamber.sh`, the profile-specific `match` shown in
[OpenChamber + DeltaRelay](OPENCHAMBER.md#supervised-launch), and a private
`pid_file`. Both frontends need the supervisor to inherit a graphical session.

The frontends are `openchamber` and `desktop`. Both are manual-only: configuring
either lists it as a managed component that starts only from its dashboard
control. Normal supervisor startup, **Start system**, and automatic recovery
never open a frontend. A stopped frontend stays stopped until you start it, and
both can be open at once. Installing the OpenChamber package does not configure
or start it.

OpenChamber is attach-only through the shared gate. It never starts, stops,
restarts, or updates OpenCode, and the gate never owns the OpenCode service.
Startup order is `dashboard`, `gate`, `gateway`, `opencode`; no frontend is
launched. **Shut down system** stops `gate` first, then `openchamber`, `desktop`,
`opencode`, `gateway`, and `tunnel`, so attached frontends lose access before
the backend is stopped. A frontend the user closes is not automatically
restarted; its component Start action brings it back.

Component IDs are `dashboard`, `gate`, `gateway`, `opencode`, `desktop`, and
`openchamber`, plus the remote-provider `tunnel`/`relay` where configured. The
new UI label is **OpenChamber**.

`--no-frontend` skips the initial OpenCode launch and leaves it out of automatic
startup for that persisted intent. Its older alias `--no-desktop` has the same
effect. Neither flag starts or stops a frontend, disables the dashboard/gate, or
makes the supervisor own the backend.

Do not simultaneously let systemd and the supervisor launch separate foreground
copies on the same port. To retain an existing service manager, configure its
start/restart/status commands instead of a foreground `command`. The supervisor
reports an unrecognized occupied port rather than replacing its owner.

## Component topology and recovery contract

System controls includes a live topology map of the whole deployment. The request
paths are Desktop → OpenCode server (loaded DeltaRelay plugin) → local gateway →
transport → relay → external model provider, and, for attached frontends,
OpenChamber or VS Code/Varro → shared frontend health gate → the same OpenCode
server. The map also shows network/host prerequisites
and relay-owned storage. A separate control path shows the dashboard browser,
dashboard service, supervisor, and remote-host adapter. Nodes and their connections
are reported independently:
two running processes are never presented as proof that their traffic path works.

Solid **PROCESS** boxes enclose each process and its components, in both the
request and control paths. The loaded plugin belongs to the OpenCode server;
cache and saved responses are relay-owned persistent files that survive process
restarts. The remote-host adapter is an on-demand executable, not a permanent
server. Dashed boundaries identify hosts, networking, direct HTTPS paths, and
external services rather than processes. A configured tunnel gets a process
boundary; direct HTTPS does not. The model provider stays outside the relay and
remote-host boundaries. Arrow colors distinguish model-request flow from checks,
recovery, and management, independently of readiness or live request activity.
The dashboard's **Architecture** tab shows this map read-only; lifecycle state and
actions are on the **Controls** tab.

Each node publishes its own desired state, observed lifecycle, readiness,
current activity, evidence timestamp, and supported actions. The Controls view
supports `start`, `recover`, `restart`, and `stop` where configured, plus
`wake`/`stop` for a remote host that advertises those capabilities. Read-only
nodes (model provider, relay storage, plugin state without a configured OpenCode
location) do not invent lifecycle actions. A process that is running but whose API has not
answered is shown as **Running · unverified**, not **Ready**.

Recovery uses the same model. A component adapter owns one resource and never
starts a peer as a hidden side effect. The coordinator observes current facts,
executes one permitted action, refreshes observations, and then decides the next
step:

1. Check the authenticated relay path before changing anything.
2. Establish the remote-provider contract and host power state where relevant.
3. Repair only the local transport if it is the broken prerequisite.
4. Ensure the existing remote relay only when the verified path still fails.
5. Rebuild the transport when a forwarder may have exited, then verify the
   authenticated relay again.
6. Start the gateway only after the connection is usable.

A successful command is an action outcome, not readiness. The coordinator
verifies the adapter's observable result, including after an SSH/startup timeout
whose remote effect is uncertain. Interrupted checkpoints are never replayed as a
queue of commands. Authentication, TLS, protocol, identity, and forwarding
errors block automatic mutations instead of being "fixed" by restarts. No
recovery path resets credentials, clears cache/mailbox state, disables
verification, or submits a model request.

Only one service-changing operation executes at a time. Read-only observation
continues when safe, and the Controls view shows the active component with a
spinner and the exact action in progress. Conflicting operations are serialized serially;
duplicate browser submissions with the same request ID are ignored. Components
that are not part of the repair stay running.

## Shared frontend health gate

The gate listens on `gate_url` and is the attach point for OpenChamber and
Varro/VS Code. It is not a provider proxy and never owns the OpenCode service.
Desktop/TUI continues to connect directly to the same service. Lifecycle
ownership is deliberately split:

- **Listener/process readiness** comes from the gate's local `/livez` endpoint,
  authenticated with the supervisor's local token. It performs no backend probe.
- **Local access readiness** is derived from the OpenCode `/api/info` check and,
  when `opencode_directory` is configured, the DeltaRelay plugin check. It gates
  attached frontends' forwarded requests, so local sessions remain available
  during a relay outage. Local reasons are `service_down` and
  `plugin_unavailable`.
- **Complete model-path readiness** adds gateway readiness and relay forwarding.
  It is reported by the gate's `/healthz` and the `gate → gateway` edge. Relay
  reasons are ordered `gateway_down`, then `service_down`, then
  `plugin_unavailable`.

Supervisor repair policy is gate-only: start a stopped gate; restart a running
gate whose `/livez` check fails; never restart a healthy listener merely because
the relay is unavailable or `/healthz` returns 503. Local service/plugin failure
is shown on the gate card and on the `gate → OpenCode` edge with the listener
**Ready**. During a relay outage the gate and `gate → OpenCode` stay ready;
`gate → gateway` is not ready, and the card explains that attached frontends can
open sessions while, with the local gateway running, prompts wait for recovery.
An unknown `/livez`
response (401/403/404 or a version mismatch) is reported as unknown, not used as
proof that a restart would help. An unrecognized port owner is reported and
never killed.

`Start system` starts the gate after the dashboard and before the backend
components. `Shut down system` stops the gate first, then the existing
OpenChamber/Desktop/OpenCode/gateway/tunnel order, so attached frontends lose
access immediately and the backend is left untouched. `--no-frontend` (and its
alias `--no-desktop`) and `--no-dashboard` do not disable the gate. The map
exposes gate-only start, stop, restart, and recover controls. Stopping the gate
affects OpenChamber and Varro only: Desktop/TUI and the shared OpenCode service
continue. OpenChamber has component start/stop/restart controls and attaches
through the gate; VS Code has no lifecycle controls, and its **Open** action only
launches the configured editor once.

Manual `deltarelay gate` or the example systemd unit remains available for a
non-supervisor deployment. It is mutually exclusive with the supervised gate on
the same port; stop one before starting the other. Do not run both.

## Automatic network recovery

Automatic recovery is the normal operating mode. The supervisor monitors Linux
`RTNETLINK` link, IPv4/IPv6 address, route, policy-rule, and DNS changes. It also
fingerprints interface state/carrier, addresses, IPv4/IPv6 routes, and resolver
configuration, so a missed netlink event still triggers a check. This covers:

- Wi-Fi network changes and roaming.
- Ethernet connect/disconnect and Wi-Fi ↔ Ethernet switches.
- VPN activation/deactivation and VPN split-route changes.
- Address or DNS changes with no interface state change.
- A full Internet outage followed by any working path returning.

Network monitoring is read-only: it does not select interfaces, change routes,
restart a VPN, flush DNS, or require an interface name in configuration. A
network hint schedules an immediate health check; it does **not** unconditionally
restart services. If the relay remains reachable, nothing is restarted. If the
connection is actually broken, only the necessary transport/relay steps run,
then authenticated relay health must pass before recovery is considered done.

The existing debounce and 2–30 second backoff still apply. A route change is a
strong hint, so the first failed probe after the change may initiate recovery
without waiting for three generic failures. During a total outage the supervisor
waits and retries; when a usable Ethernet, Wi-Fi, or VPN route returns, it
reconnects automatically. A running frontend, the OpenCode server, and the
gateway are left running unless their own local readiness has independently
failed; frontends are never opened automatically. The dashboard may be closed;
recovery continues.

This does not promise zero interruption: changing a route can drop active TCP
connections. DeltaRelay's request ID and durable response resume remain the
recovery contract for in-flight work, and a provider generation is never
silently repeated. If every available route is blocked by policy or credentials
are invalid, the map reports the actual blocker instead of bypassing it.

## Dashboard behavior

- The map and inspector replace the separate Services list and browser log
  console. The ChatGPT access-token countdown remains. Controls poll the
  supervisor every second while this page is open; the supervisor continues at
  its own schedule when the page is closed.
- **Automatic recovery** is on initially. Probes run every five seconds with a
  two-second network timeout. A running-but-dead forward is rebuilt, not just an
  exited process. Recovery gives each rebuilt link a 30-second readiness window
  (at most 16 probes). If remote relay startup was needed, it rebuilds the tunnel
  again (some forwarders exit on a refused remote connection) and verifies
  authenticated relay health before reporting success. A transient SSH/startup
  failure also gets this final verification: the relay may have started despite
  the SSH timeout. If verification still fails, the actual recovery error remains
  visible.
- **Automatic remote-host wake** is off initially and appears only when the
  provider supports wake. Both settings persist privately per profile. Enabling
  auto-wake asks for billing confirmation; it can resume compute with the browser
  closed.
- **Start system** resumes an intentionally stopped stack or performs a complete
  manual repair. It starts the configured background services, including the
  gate, respects per-component desired state and
  `--no-frontend`/`--no-desktop`, resumes automatic recovery, and then repairs the
  connection. Neither frontend is opened by **Start system**; use its component
  Start action. It asks for confirmation because
  starting/waking remote compute may incur charges. Enabling automatic wake is
  not implied. A gate start failure is shown on the gate card but does not turn
  the rest of `Start system` into a failure; scheduled repair and the card retry
  remain available.
- **Gate controls** are on the Connection card and map; lifecycle actions are
  enabled only when the gate is configured. An unconfigured gate is shown as
  **Not configured** rather than a stopped process. Restart/recover repair the
  listener, not the backend. Gate stop and
  restart never signal OpenCode, OpenChamber, Desktop, the relay, the tunnel, or
  the provider. The `OpenChamber` and `Varro in VS Code` map nodes show the
  attach-only paths; OpenChamber is a managed component with start/stop/restart
  controls, while the VS Code node is external and read-only. Its Applications
  card shows **Not observed**, offers **Open** only when `vscode.open_command` is
  configured, and has no start, restart, or stop controls.
- **Recover** on a node repairs that resource and its necessary prerequisites.
  Starting one node does not silently start the whole stopped stack. **Restart**
  always requires explicit confirmation; **Start** is idempotent. Restarting a
  remote relay or gateway can interrupt active requests and already billed work.
  There is no cache clear, credential reset, response ACK, or replay action.
- **Shut down VPS…** is available only when the provider advertises `host.stop`.
  It saves the remote intent as stopped and disables automatic reconnect/wake
  before stopping the managed local tunnel and requesting shutdown. A network
  change or supervisor restart cannot immediately wake it again. Saved files,
  tokens, relay cache, and responses are preserved.
- **Shut down system…** stops the gate first, then managed OpenChamber/Desktop,
  OpenCode service, gateway, and tunnel, then the VPS when supported. It always
  keeps the dashboard and supervisor running, so **Start system** is available
  afterwards; it never
  powers off your PC. Stopped intent is persisted before the first stop command
  and survives partial failures, timeouts, network changes, and supervisor
  restarts. If a service-manager component has no declared `stop_command`, the
  button is disabled and names the components that need one rather than guessing
  with broad process matching.
- A stop **does not wait for a recovery operation to succeed**. It persists the
  stopped intent, disables recovery/wake, cancels recovery commands, and then
  takes the mutation lane. This prevents a recovery in progress from waking or
  reconnecting to compute after shutdown. **Shutdown in progress** and
  **Shutdown unconfirmed — compute charges may continue** are distinct states;
  only a successful provider power observation reports **Remote shutdown
  confirmed**.
- `./deltarelay stop [--remote-only] [--yes] [--timeout SECONDS]` uses this same
  operation. It never starts a supervisor as a fallback. An accepted stop leaves
  recovery and wake off even when confirmation fails.
- The connection panel shows current reachability, recovery phase, attempts, last
  successful check, and the next scheduled retry. The last recovery failure
  remains visible during retry backoff instead of being replaced by a generic
  reachability failure. A provider's **Available/running** state is not proof
  that SSH, the tunnel, or the relay is reachable.
- **VPS unreachable** and **no internet** are reported separately. During a relay
  outage the supervisor checks an external HTTPS endpoint
  (`internet_check_url`, default `https://example.com/`) and shows either **No
  internet** or **VPS unreachable**. The check runs at most every 15 seconds,
  sends no relay/provider credentials, and makes no model request. A successful
  relay check confirms Internet reachability without the external probe.
- The private, bounded supervisor journal remains at
  `<profile>/control/activity.jsonl` for offline diagnostics and the cursor-only
  `GET /api/system/journal` endpoint. The browser no longer renders it.
- The supervisor also writes a private `state-history.jsonl` transition log
  (mode 600, transitions plus periodic heartbeats) without an age, record-count,
  or file-size limit, so its full timeline survives restarts. A legacy `.1`
  backup from earlier bounded versions is still read.
  `GET /api/system/history` exposes only a bounded aggregate — per-bucket seconds,
  totals, exact transition intervals (at most 6,000), coverage, and the current
  state — for the dashboard's **State lanes** and **Composition** charts. Its only
  accepted inputs are integer `start`, `end`, and `bucket`
  seconds; it rejects spans over 3,660 days and more than 2,000 buckets. It
  contains no commands, paths, credentials, or probe output. A missing heartbeat
  gap is recorded as **off**; a previously observed state is never extended
  across a period when the supervisor was not running.
- Stale supervisor status disables lifecycle actions and marks observed evidence
  stale. Manual refresh still works. An unavailable dashboard→supervisor edge
  does not make an otherwise reachable relay look healthy.

A committed stop is not undone by startup. If the remote host was intentionally
stopped, the map says so; use **Start system**/wake explicitly to resume. A
remote stop action saves automatic reconnect and wake as off, even if the stop
later fails or times out.

A 404 after an upgrade is not an internet outage. The current relay health route
is `/info`, and the OpenCode plugin submits to the gateway's `/proxy`. Deploy
matching revisions on both machines and update any private copied plugin directory;
reload only the affected OpenCode profile. Do not delete the identity pin or relay
store, or add a direct-provider fallback. See the [404 setup check](SETUP.md#disable-or-troubleshoot).

## ChatGPT access-token countdown

The dashboard's `--opencode-service-file` points to the **correct profile's**
private OpenCode V2 service registration (usually
`$XDG_STATE_HOME/opencode/service.json`). Configure the isolated profile's path
explicitly. `--auth-integration` defaults to `openai`.

Go reads that registration without editing it, authenticates only to its loopback
endpoint, reads the active integration credential's `expires` metadata using the
supported OpenCode API, and returns only status, expiry and observation time.
Credentials stay server-side; no access/refresh tokens, service password, account
labels, or credential IDs are sent to the browser or logs. Redirects and ambient
HTTP proxies are disabled. This reader never starts OpenCode, resolves/refreshes
OAuth, touches SQLite, or sends a provider generation.

The UI updates the countdown each second and rereads metadata at most every ten
seconds. An expired access token is labeled **awaiting refresh**, not automatically
"sign in again": OpenCode may refresh it on the next request. A reported
`needs_auth` connection is labeled **Sign-in required**. API keys and unknown
expiry timestamps get an honest unavailable state, not a guessed deadline. A
failed read retains the last known expiry explicitly marked stale.

## Security, state, and tests

The supervisor uses a mode-600 Unix socket inside a mode-700 `control/` directory.
The dashboard exposes only predefined actions/settings, not a shell or arbitrary
proxy. Writes require same-origin JSON POSTs and a random per-dashboard control
nonce held only in browser memory. Existing loopback Host, Origin, CSP and
cross-site protections remain in place. This is a single-user local tool, not a
multi-user authorization boundary. Never expose either API publicly.

Settings and per-service logs live in `profile/control/`. The supervisor also
writes a private, rotating `activity.jsonl` journal (8 MiB plus one 8 MiB backup,
mode 600). Disk writes are batched outside recovery/state locks; an explicit
warning reports storage failure or queue overflow while bounded memory history
remains available. The latest 2,000 records are available through the cursor API;
on restart these are recovered from the retained files. For a CLI view, use
`tail -F /your/private/profile/control/activity.jsonl`. The journal has no
arbitrary path parameter, shell input or command execution endpoint.

Diagnostics remain in the private journal for offline support; the browser map
uses structured topology and recovery steps rather than rendering arbitrary
command output. The existing action/status failure codes remain fixed. Known
relay/local token values, configured credential fields, secret environment
values, service registration passwords and common credential syntax are masked
**before** journaling. ANSI/control sequences are removed. Do not assume
application output is secret-free: paths, stack traces and other private
diagnostic data are preserved. Review logs before copying/sharing, never expose
the dashboard publicly, and never print credentials from service/provider
commands. The original per-service log files remain private and may contain
unredacted application output.

Subprocess output is line-buffered (a partial line appears at EOF); lines over
16 KiB are omitted with an explicit marker, not allowed to grow memory without
bound. Existing long-running service log files are followed from the current EOF
without reimporting old content; their stdout/stderr is already merged and is
labeled as such. Collection can only observe output routed to these files, not a
detached external service manager's private journal. Bundled executable providers
send real nested command traces on a separate diagnostic pipe, preserving their
strict JSON stdout contract. Other providers' emitted stdout/stderr and invocation
boundaries are visible, but uninstrumented internal work cannot be inferred.

Build and deploy matching component revisions before restarting the services
when safe. Unsupported status shapes fail closed; no configuration or history
adapters are run and no private files are reset.

PID adoption and
signals require the expected owner's arguments and process birth time. A verified
process that ignores graceful shutdown is force-stopped after a bounded timeout;
a recycled PID, unrecognized port owner, or unrelated process is never signaled.
Stopping the supervisor leaves existing services running; rerun `startup.sh` to
resume monitoring. Remote/provider and profile configuration is read at controller
startup and requires a supervisor restart. Component lifecycle definitions are
re-read on safe ticks: a newly configured action can be added without stopping
live services, while replacing/removing an owner of an already running child is
refused rather than silently creating a second owner. Runtime code is organized
in `deploy/supervision/`; `deploy/supervisor.py` remains the supervisor executable
and `deploy/start_supervisor.py` is the launcher entry point.

The sanitized `topology` block is contract version 1 inside the existing
supervisor/dashboard status version 2 envelope. Older supervisors are still
accepted with read-only status but no map actions. Unknown topology fields and
private adapter details are stripped at the Go boundary. The relay wire protocol,
remote-provider contract, and durable storage formats are unchanged.

```sh
go test -race ./...
go vet ./...
make recovery-test
node --test integration/opencode/*.test.mjs
pnpm check
pnpm test
pnpm build
```

For the live Wi-Fi/Ethernet/VPN, interruption, shutdown, and independent
OpenCode tester matrix, see [recovery acceptance testing](RECOVERY_TESTING.md).

Tests use local faults and mock providers, not real VPN toggles or paid accounts.
They exercise stale/live control isolation, token privacy, TLS/identity failures,
hang recovery, backoff, persisted wake policy, explicit manual wake, and verified
process ownership. Existing transport tests verify upload and response recovery
without regenerating provider requests.
