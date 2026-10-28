# Network recovery and dashboard controls

`startup.sh` starts an independent Python 3 supervisor and the local Go dashboard
**before** attempting remote recovery. Closing the browser or terminal does not
stop supervision. Nothing is installed at login, no VPN settings are changed,
and no inference or automatic direct-provider fallback is introduced.

## Existing private Codespace profile

```sh
./startup.sh
# Leave OpenCode/Desktop alone while starting local controls and network recovery:
./startup.sh --no-desktop
```

On first use, the launcher adapts the existing profile into a mode-600
`.runtime/codespace-test/supervisor.local.json`. It reads the Codespace selection
from the existing tunnel wrapper, not from committed machine-specific settings.
It requires the existing token files, pinned relay identity, deployment, and
offline build tools/cache. It does not provision a new Codespace or copy accounts.
The first generated dashboard port defaults to 8790; set
`DELTARELAY_DASHBOARD_PORT` before that first launch to choose another port.
Subsequent launches use the saved configuration. `DELTARELAY_PROFILE` selects a
different already-configured profile.

The controller adopts verified existing gateway, tunnel and Desktop processes.
It upgrades a positively identified old **read-only dashboard** on startup, but
does not restart a live gateway, remote relay, or OpenCode to apply new code.
Use the dashboard's explicit Restart action when that is safe. Restarts of the
gateway use the newly built local binary and preserve its state/history paths.
Unknown port owners are never killed or replaced. The existing gateway must
support `/v1/dashboard` to show session statistics; controls do not depend on it.

The old `recover.sh` remains a deliberate, bounded, on-demand command and can
still wake a stopped Codespace. It does not consult the dashboard's auto-wake
policy. Do not run legacy stop/recovery scripts concurrently with dashboard
management. Only one manager should own a deployment's services.

## Regular SSH or HTTPS VPS

First complete [SETUP.md](SETUP.md), including SSH host trust and a working
gateway. Its `--state-dir` must contain the existing `relay-state.json` identity
pin; a missing pin is an error, never permission to silently adopt a new store.

Copy `deploy/supervisor.example.json` into a **private, untracked** file, replace
every placeholder, and make it mode 600. Create the configured `profile` directory
privately (mode 700). Then:

```sh
./startup.sh --config /absolute/path/to/vps.local.json --no-desktop
```

All paths in the configuration are absolute. `profile` stores only private
controller metadata/logs and the configured state; the example intentionally uses
the same identity/state directory as the gateway. Each component can use:

- `command`, `pid_file`, optional loopback `port`, and optional `directory` / `env`:
  a persistent local child owned/adopted by this controller.
- `start_command`, `restart_command`, optional `status_command` / `env`: existing
  service-manager commands, such as SSH to a preconfigured systemd service.
- Optional `match` arguments for an executable that rewrites its argv (Desktop),
  or `adopt_match` for a known legacy launcher. Do not use broad process matches.

Commands are trusted local configuration, **not browser inputs**. Never put
tokens/passwords in command arguments. The sample remote commands assume an
already-installed **user** unit. Change them to your existing service and
authorized noninteractive management method; the root service example in
`deploy/deltarelay-server.service` is not a user unit. No sudo permissions,
services, or SSH keys are installed automatically. Service-manager start commands
must be idempotent and must never create/reset the relay's store.

For direct HTTPS, change `relay_url` and the gateway's `--server` to the HTTPS
origin and omit `tunnel`. Certificate verification remains mandatory. To manage
the remote relay, retain explicit authenticated SSH/service-manager commands;
there is no new public relay administration endpoint. Without those commands,
remote management is shown as **Not configured**.

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

- **Automatic reconnect** is on initially. Probes run every five seconds with a
  two-second network timeout. Three consecutive transient failures initiate
  recovery. A running-but-dead forward is rebuilt, not just an exited process.
  Failed attempts back off from 2 to 30 seconds, observed on the probe schedule.
- **Automatic Codespace wake** is off initially. Both settings persist privately
  per profile. Enabling auto-wake asks for billing confirmation; it can resume
  GitHub compute even with the browser closed.
- **Wake Codespace** is always displayed and is usable regardless of the
  auto-wake setting. It is disabled for non-Codespace profiles, stale status, or
  an operation already in progress. Manual wake also asks for billing confirmation.
- **Recover all** starts configured local services and repairs connectivity.
  It respects auto-wake; use the explicit Wake button if the Codespace is asleep.
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
`$XDG_STATE_HOME/opencode/service.json`). The default Codespace adapter supplies
its isolated profile path. `--auth-integration` defaults to `openai`.

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

Settings and per-service logs live in `profile/control/`. Subprocess diagnostics
are private; browser error messages contain only safe codes. PID adoption and
signals require the expected owner's arguments and process birth time. A verified
process that ignores graceful shutdown is force-stopped after a bounded timeout;
a recycled PID, unrecognized port owner, or unrelated process is never signaled.
Stopping the supervisor leaves existing services running; rerun `startup.sh` to
resume monitoring. Configuration is read at controller startup, not live-reloaded.

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
