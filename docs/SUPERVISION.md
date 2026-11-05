# Network recovery and dashboard controls

`startup.sh` starts an independent Python 3 supervisor and the local Go dashboard
**before** attempting remote recovery. Closing the browser or terminal does not
stop supervision. Nothing is installed at login, no VPN settings are changed,
and no inference or automatic direct-provider fallback is introduced.

Remote hosting is extensible through the versioned, language-independent
[remote-host provider contract](REMOTE_PROVIDERS.md). The bundled SSH, direct
HTTPS, and Codespaces providers manage existing deployments only. The dashboard
uses provider capabilities, not a hardcoded hosting vendor, for power controls.
For first-time installation on a selected SSH host/Codespace, the separate,
explicit [dashboard setup flow](REMOTE_SETUP.md) builds and installs the relay;
normal provider recovery still never initializes a store.

## Configure an existing remote host

```sh
./startup.sh --config /private/supervisor.json
# Leave OpenCode/Desktop alone while starting local controls and network recovery:
./startup.sh --config /private/supervisor.json --no-desktop
```

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

The controller adopts verified existing gateway, tunnel, and Desktop processes.
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
./startup.sh --config /absolute/path/to/vps.local.json --no-desktop
```

All local paths in the configuration are absolute. `profile` stores only private
controller metadata/logs and the configured state; the example intentionally uses
the same identity/state directory as the gateway. Each component can use:

- `command`, `pid_file`, optional loopback `port`, and optional `directory` / `env`:
  a persistent local child owned/adopted by this controller.
- `start_command`, `restart_command`, optional `status_command` / `env`: existing
  service-manager commands, such as SSH to a preconfigured systemd service.
- Optional `match` arguments for an executable that rewrites its argv (Desktop).
  Do not use broad process matches.

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

Omit OpenCode/Desktop components to leave them unmanaged, or configure only the
specific isolated profile you want controlled. In particular, do not accidentally
point service commands at another OpenCode profile. An optional Desktop entry
uses its existing launcher in `command`, a profile-specific `match`, and a private
`pid_file`. Desktop needs the supervisor to inherit a graphical session.

Do not simultaneously let systemd and the supervisor launch separate foreground
copies on the same port. To retain an existing service manager, configure its
start/restart/status commands instead of a foreground `command`. The supervisor
reports an unrecognized occupied port rather than replacing its owner.

## Dashboard behavior

- **System activity** is the primary, read-only execution console on System
  controls. It tails the supervisor journal every second independently of the
  five-second status cards. It shows actual command argv, working directories,
  process IDs, stdout/stderr, exit codes/signals, timeouts and elapsed time—not
  descriptions reconstructed from failure codes. Internal HTTP probes are
  explicitly logged as HTTP operations, including response status or the actual
  network exception, rather than invented terminal commands. Scheduled checks,
  process adoption, settings changes, state transitions, recovery triggers,
  policy skips, readiness checks and retry/backoff decisions are recorded too.
  Startup collection begins before remote discovery and continues with no browser
  open. Each record identifies its UTC time, component, trigger and operation;
  command execution IDs link invocation, output and exit records. After an action
  is accepted, the page reveals and follows the console; an explicitly paused log
  stays paused (recording continues) until **Resume log** is clicked.
- **Follow** controls scrolling; scrolling up turns it off. **Pause log** pauses
  browser reads only, never supervision/recording. Search and component filtering
  apply to loaded records; **Copy visible** copies the filtered view and
  **Download loaded log** exports all loaded records. **Load earlier** retrieves
  earlier retained history. The page keeps at most 2,000 records and reports gaps
  when its cursor has rotated out. Refreshing or restarting the dashboard does not
  discard the supervisor's history. Page-level Pause pauses both status and log
  reads; manual Refresh still reads both. An unavailable journal does not disable
  otherwise fresh service controls or erase the last displayed output.
- **Open OpenCode Desktop**, beside Refresh, starts the configured isolated Desktop
  launcher without restarting other services, recovering the VPS, or waking a
  Codespace. It is available after `--no-desktop` startup and works without a
  reachable VPS. It is disabled when Desktop is already running/starting, its
  launcher is not configured, status is stale, or another service operation is
  in progress. The supervisor must inherit a graphical session; launch failures
  are shown beside the button. Existing sessions and credentials are preserved.
- **Automatic reconnect** is on initially. Probes run every five seconds with a
  two-second network timeout. Three consecutive transient failures initiate
  recovery. A running-but-dead forward is rebuilt, not just an exited process.
  Recovery gives each rebuilt link a 30-second readiness window (at most 16
  probes), so a cold forward is not abandoned after a few immediate connection
  refusals. If remote relay startup was needed, it rebuilds the tunnel again
  (some forwarders exit on a refused remote connection) and verifies authenticated
  relay health before reporting success. A transient SSH/startup failure also gets
  this final verification: the relay may have started despite the SSH timeout.
  If verification still fails, the actual recovery error remains visible.
  Authentication, TLS, protocol, and identity errors at any readiness check stop
  recovery without further service changes.
  Failed attempts back off from 2 to 30 seconds, observed on the probe schedule.
- **Automatic remote-host wake** is off initially and appears only when the
  provider supports wake. Both settings persist privately per profile. Enabling
  auto-wake asks for billing confirmation; it can resume compute with the browser closed.
- **Wake remote host** appears only for a wake-capable provider and works regardless
   of auto-wake. It is disabled for stale status or an operation already in progress.
   Manual wake requires explicit billing confirmation in the UI and control API.
   It performs the complete connection operation even with automatic reconnect
   disabled: wait for the host to run, rebuild its local tunnel, ensure the existing
   relay only if necessary, and verify authenticated health. A provider's
   **Available/running** response is not connection success. Progress remains
   active while the tunnel/relay starts; a failed SSH readiness check cannot skip
   the tunnel step and leave the dashboard stranded. Neither automatic setting
   is changed by a manual wake.
- **Stop remote host…** appears only for a stop-capable provider and asks for
  confirmation before stopping the existing machine. Active requests may be interrupted and provider work
  may already be billed. Automatic reconnect and wake are both saved as **off**
  before stopping the managed local tunnel and requesting shutdown, so recovery
  cannot immediately wake it again, even after restarting the supervisor. These
  settings remain off if shutdown fails or times out. Progress stays visible until
  the provider confirms **stopped** (up to two minutes); the machine is not deleted
  and saved files, tokens, relay cache, and responses are preserved. The dashboard
  and other local services stay running. Use **Wake remote host** to resume and
  re-enable recovery settings as needed; manual wake does not change them.
  Stop is disabled for stale status, an operation in progress, or a machine already confirmed stopped.
- **Recover all** starts configured local services and repairs connectivity.
  It respects auto-wake; use the explicit Wake button if the remote host is asleep.
- Each configured component has **Start / Restart** controls, plus **Restart all**.
  Starts are idempotent; restarts always require explicit confirmation. Dashboard
  restart is performed by the independent supervisor, so it can come back itself.
  Restarting a remote relay or gateway can interrupt active requests and already
  billed work. There is no cache clear, credential reset, response ACK, or replay
  button. No service action sends a new model request.
- The connection panel shows current reachability, recovery phase, attempts, last
  successful check, safe failure codes, and the next scheduled retry. It remains
  useful when the gateway's statistics endpoint is unavailable. Sample-data mode
  disables all real service controls.
  The last recovery failure remains visible during retry backoff instead of being
  replaced by a generic reachability failure. A Codespace's **Available** state is
  not proof that its SSH service or relay is reachable.
- **VPS unreachable** and **no internet** are reported separately. When the relay
  probe fails with a network error, the supervisor checks an external HTTPS
  endpoint (`internet_check_url`, default `https://example.com/`) and shows
  either **No internet** (Wi-Fi, Ethernet, VPN, or default route) or **VPS
  unreachable** (local internet works, but the relay/tunnel/remote host did not
  respond). The check runs only during a relay outage, at most every 15 seconds,
  sends no relay/provider credentials, and makes no model request. A successful
  relay check confirms internet reachability without the external probe.
- If the host is running but the tunnel is stopped, check **Automatic reconnect**.
  A remote-stop action saves it as off, even if the stop later fails; waking the
  host or running startup again does not re-enable it. Use **Recover all** for a
  one-time repair or explicitly turn reconnect back on. This does not enable
  automatic wake. The connection explanation shows when recovery is paused.

A 404 after an upgrade is not an internet outage. The current relay health route
is `/info`, and the OpenCode plugin submits to the gateway's `/proxy`. Deploy
matching revisions on both machines and update any private copied plugin directory;
reload only the affected OpenCode profile. Do not delete the identity pin or relay
store, or add a direct-provider fallback. See the [404 setup check](SETUP.md#disable-or-troubleshoot).

Network recovery never restarts a healthy gateway merely because a tunnel failed.
The existing Go request recovery retains the same request ID, uploads only missing
chunks, and resumes the durable response at its last delivered offset. Pauses are
unavoidable during a route change; an already-connected RPC can take up to its
configured stall timeout to notice a blackholed TCP connection. Recovery is bounded
by caller cancellation, retry windows, mailbox retention, and provider/job limits.
Restarted gateway callers cannot transparently recover their old local HTTP
connection; use existing saved-response recovery instead of blindly resending.

Permanent authentication, certificate, protocol, or relay-identity errors are
shown rather than "fixed" by restarts or state changes. Remote Codespace recovery
uses the saved store and its server lock; it never initializes a replacement store.

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

Diagnostics are now deliberately visible through the loopback dashboard, while
the existing action/status failure codes remain fixed. Known relay/local token
values, configured credential fields, secret environment values, service
registration passwords and common credential syntax are masked **before**
journaling. ANSI/control sequences are removed and the browser renders output
as text, not HTML. Do not assume arbitrary application output is secret-free:
paths, stack traces and other private diagnostic data are preserved. Review logs
before copying/sharing, never expose the dashboard publicly, and never print
credentials from service/provider commands. The original per-service log files
remain private and may contain unredacted application output.

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
resume monitoring. Configuration is read at controller startup, not live-reloaded.
Runtime code is organized in `deploy/supervision/`; `deploy/supervisor.py` remains
the supervisor executable and `deploy/start_supervisor.py` is
the launcher entry point.

```sh
go test -race ./...
go vet ./...
make recovery-test
node --test integration/opencode/*.test.mjs
pnpm check
pnpm test
pnpm build
```

Tests use local faults and mock providers, not real VPN toggles or paid accounts.
They exercise stale/live control isolation, token privacy, TLS/identity failures,
hang recovery, backoff, persisted wake policy, explicit manual wake, and verified
process ownership. Existing transport tests verify upload and response recovery
without regenerating provider requests.
