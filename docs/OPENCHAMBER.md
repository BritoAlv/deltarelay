# OpenChamber + DeltaRelay

OpenChamber Desktop is an optional graphical frontend for the **same OpenCode
v2 service** used by OpenCode Desktop and TUI. It attaches through the shared
frontend health gate; it never starts, stops, restarts, or updates OpenCode. The
checked package is **OpenChamber Desktop 2.7.2**, installed from its Debian
`.deb` at `/opt/OpenChamber/openchamber`.

When `components.openchamber` is configured with a launchable command, the
supervisor manages it as an attach-only component but never opens it
automatically. Start it from the dashboard's **OpenChamber** controls whenever
you need it. A configured OpenCode Desktop remains the default auto-start
frontend. Installing the package alone does not configure or start it.

```text
OpenChamber Desktop --\
                       \
Varro / VS Code --------> shared frontend health gate 127.0.0.1:18789
                       /    | /livez: listener + local token
                      /     | forwarded requests: OpenCode v2 + plugin
                     /      +--> gateway 127.0.0.1:18788 --> tunnel/relay
                    /                                         --> provider
OpenCode Desktop / TUI ---------> same profile OpenCode v2 service
```

OpenChamber's own UI/API server listens on an internal loopback port (for
example `127.0.0.1:57123`). That is **not** the gate and **not** the OpenCode
service.
Never use that port in supervisor or plugin configuration.

## What it does and does not manage

| Area | Behavior |
| --- | --- |
| Frontend | Renders OpenChamber's project, session, prompt, diff, and file UI against the shared OpenCode service. |
| OpenCode lifecycle | **Never** starts, stops, restarts, or updates OpenCode. The launcher only checks that the gate is listening. |
| Gate | Requires the shared frontend health gate. It does not start or repair the gate; the supervisor owns that process. |
| DeltaRelay | Never owns the gateway, tunnel, relay, provider connection, relay identity pin, or response storage. |
| Provider credentials | The shared OpenCode service owns authentication and provider state. DeltaRelay routing and the plugin's provider allowlist are unchanged. |
| Updates | Updates its own installed `.deb` only. It does not update OpenCode, DeltaRelay, or any other package. |
| Projects and trust | Keeps its own project list and folder-trust decisions. They are not shared automatically with OpenCode Desktop. |

OpenChamber is attach-only. If it cannot reach the gate, it must not start a
private OpenCode server as a fallback.

## Prerequisites

- Ubuntu/Debian on the architecture matching the downloaded package (the checked
  package is `linux-amd64`), with a graphical session. The supervisor must inherit
  `DISPLAY` or `WAYLAND_DISPLAY`; a systemd user unit without them reports
  `graphical_session_required`.
- A working DeltaRelay supervisor with:
  - the shared frontend health gate at a literal loopback origin (default
    `http://127.0.0.1:18789`);
  - an OpenCode v2 service registration for the same isolated profile;
  - the private local token used to authenticate `/livez`.
- `curl`, used by the launcher's gate preflight.
- `apt` for installation, and `polkit` (`pkexec`) only if you use the app's own
  update UI.
- A private local token file, mode `0600`, readable by your user. Do not put the
  token itself in the supervisor configuration or on a command line.
- A private token file is not the same as an optional gate password. The default
  loopback gate has no client password; see [Security](#security).

The launcher preflights `/livez`, which proves only that the gate listener and
local token work. It does not prove that OpenCode or the relay path is healthy.
With OpenCode down, OpenChamber may open but forwarded requests fail with 503;
with the relay down, local sessions remain usable while prompts wait inside the
gateway's recovery window (see [Varro + VS Code](VARRO_VSCODE.md#health-and-failure-semantics)).

## Install and verify the package

Download the official `.deb` and its published SHA-256 value from the same
trusted release source. Compare the digest before installing:

```sh
cd ~/Downloads
sha256sum OpenChamber-<version>-linux-amd64.deb
# If the release publishes a checksum file:
sha256sum -c OpenChamber-<version>-linux-amd64.deb.sha256
```

The Linux packages are **unsigned**. A matching SHA-256 verifies transfer
integrity against the value you obtained; it is not a cryptographic signature or
publisher identity check. Do not accept a checksum from an unrelated mirror.

Install with `apt`, not `dpkg -i`, so package dependencies are resolved:

```sh
sudo apt install ./OpenChamber-<version>-linux-amd64.deb
dpkg-query -W -f='${Package} ${Version}\n' openchamber
test -x /opt/OpenChamber/openchamber
```

The package installs the application under `/opt/OpenChamber` and a desktop
entry. It does **not** install an `openchamber` command on `PATH`. Use the
absolute binary path; the launcher defaults to
`/opt/OpenChamber/openchamber`.

There is **no OpenChamber apt repository**. `apt upgrade` and
`unattended-upgrades` do not update it. Only the app's own update path or a
manual `.deb` install does.

## Supervised launch

Add the component to the **private** supervisor configuration. Its component ID
is `openchamber` and its dashboard label is **OpenChamber**. Replace every
placeholder with an absolute path and keep the file mode `0600`:

```json
"openchamber": {
  "command": ["/abs/path/deltarelay/deploy/openchamber/start-openchamber.sh"],
  "match": ["/opt/OpenChamber/openchamber", "--user-data-dir=/abs/path/<profile>/openchamber/desktop"],
  "pid_file": "/abs/path/<profile>/openchamber.pid",
  "env": {
    "DELTARELAY_OPENCHAMBER_STATE": "/abs/path/<profile>/openchamber",
    "DELTARELAY_GATE_URL": "http://127.0.0.1:18789",
    "DELTARELAY_LOCAL_AUTH_FILE": "/abs/path/private/local.token"
  }
}
```

`command` must be an absolute argv; it is not a shell command. `match` is the
profile-specific process identity: the installed binary **and** the exact
`--user-data-dir` argument. Do not shorten it to the binary alone; that could
adopt or signal another OpenChamber profile.

The launcher:

1. Rejects a non-absolute state path and a non-loopback gate URL.
2. Removes inherited `OPENCODE_*`, `OPENCHAMBER_*`, API-key, token, secret, and
   password variables, plus `APPIMAGE`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`,
   `NODE_ENV`, `LD_PRELOAD`, and `LD_LIBRARY_PATH`.
3. Creates isolated XDG and OpenChamber state directories with mode `0700`.
4. Reads the local token, checks `GET /livez` with
   `X-DeltaRelay-Local-Token`, and refuses to launch if the gate is not ready.
5. Exports `OPENCODE_HOST=<gate>`, `OPENCODE_SKIP_START=true`, and
   `OPENCHAMBER_HOST=127.0.0.1`, then execs
   `/opt/OpenChamber/openchamber --user-data-dir=<state>/desktop`.

The local token is passed to `curl` through its config stdin, not as a command
argument. The token value never belongs in the supervisor JSON.

If the gate uses its optional separate password, add
`"DELTARELAY_GATE_AUTH_FILE": "/abs/path/private/gate-password"` to `env`. The
launcher reads that file and exports `OPENCODE_SERVER_PASSWORD` for forwarded
requests. Keep the password file mode `0600`; do not pass it in argv. The
`/livez` preflight still uses the local token, not the gate password.

Restart the supervisor after adding the component, then start it normally:

```sh
uv run ./deltarelay start --config /private/supervisor.json
```

Normal startup and **Start system** start `dashboard`, `gate`, `gateway`,
`opencode`, then the default frontend (Desktop when configured) when its desired
state is running. OpenChamber is manual-only: it is never started by normal
startup or **Start system**. Use the OpenChamber component's **Start** action in
the dashboard. A manually started Desktop is an explicit per-component choice
and is not undone by adding OpenChamber.

To start local controls and recovery without launching OpenCode or Desktop, use
`--no-frontend` (or its older alias `--no-desktop`):

```sh
uv run ./deltarelay start --config /private/supervisor.json --no-frontend
```

This skips the **initial** OpenCode and Desktop launch and leaves both managed
frontends out of automatic startup for that persisted intent. It does not stop
an already running OpenChamber or Desktop, and it does not disable the gate or
dashboard. OpenChamber is manual-only even without this flag.

## Isolated state

The launcher keeps all mutable state under the configured profile:

```text
<profile>/openchamber/
  xdg/
    config/        XDG_CONFIG_HOME
    data/          XDG_DATA_HOME
    state/         XDG_STATE_HOME
    cache/         XDG_CACHE_HOME
  data/            OPENCHAMBER_DATA_DIR
    settings.json          project list and app settings
    opencode-trust.json    folder-trust decisions
    ...                    auth stores, device identity, other app data
  desktop/         OPENCHAMBER_DESKTOP_USER_DATA_DIR and --user-data-dir
    Cookies, Local Storage, caches, Electron profile
    logs/main.log          Electron main-process log
  logs/            launcher-created log directory (optional app output)
```

The temporary directory is deliberately **outside** the profile and short:

```text
${XDG_RUNTIME_DIR:-/tmp}/deltarelay-oc-<first 8 hex characters of sha256(state)>
```

It is mode `0700`. The launcher sets `TMPDIR` to it before starting Electron.
The deterministic hash keeps the path stable for the same state directory, so
the Chromium single-instance socket stays consistent across launches.

### Why both OpenChamber data paths matter

`OPENCHAMBER_DATA_DIR` is the application data root. It holds `settings.json`
(including the project list), `opencode-trust.json`, auth/device state, and other
OpenChamber files. If unset, OpenChamber defaults to `~/.config/openchamber`.

`OPENCHAMBER_DESKTOP_USER_DATA_DIR` is Electron's `userData` root, and
`--user-data-dir` is the Chromium/Electron profile switch. They hold cookies,
local storage, caches, window state, and the single-instance lock. The launcher
sets **both** to `<state>/desktop` so the app and desktop layers agree.

Setting only one would split application state from browser state, could leave
cookies and the singleton in the default profile, and could let a second
OpenChamber instance run against a different profile. Always start through the
launcher; do not construct a partial environment by hand.

## Start, focus, stop, and close

- **Start:** the supervisor starts the launcher, which preflights the gate and
  execs the app. If the verified process is already running, Start is a no-op.
- **Focus:** OpenChamber uses Electron's single-instance lock for the same
  `--user-data-dir`. Running the same launcher again exits the second process
  and asks the existing instance to focus or open its main window. A second
  profile or a different `TMPDIR` defeats that handoff; see
  [Troubleshooting](#troubleshooting).
- **`--background`:** append `--background` to the component's `command` if the
  managed start should open no window. The process still runs and can be raised
  from the tray or by launching the same profile again. The fragment above
  starts with a normal window.
- **Close/tray:** on Linux, closing the last window quits by default. Enable
  **Minimize to tray** in OpenChamber's settings to make close hide the window;
  the tray icon can restore it. Quit may ask for confirmation when OpenChamber
  has its own active tunnel or scheduled tasks. On quit it logs
  `Skipping OpenCode shutdown (external server)` and does not signal the
  OpenCode service.
- **Stop:** use the dashboard component control. The supervisor sends SIGTERM
  to the verified process group, waits up to 8 seconds, and force-stops a hung
  verified process. The gate, gateway, and OpenCode service are not stopped.
  A frontend you close yourself is not automatically restarted; use Start when
  you want it back.

Stopping the OpenChamber component does not change the startup policy.
OpenChamber is never auto-started; a stopped component stays stopped until you
use its **Start** action in the dashboard. Desktop, when configured, remains the
default auto-start frontend and is not affected.

## Verify the attach path

Run these checks without stopping the backend. Replace the private paths.

```sh
# Gate listener and token. Do not paste secrets into reports or enable xtrace.
printf 'header = "X-DeltaRelay-Local-Token: %s"\n' \
  "$(tr -d '\r\n' < /private/local.token)" |
  curl -fsS --config - http://127.0.0.1:18789/livez

# Full local/relay readiness (optional, may be 503 when the relay is down).
# Add the gate's Basic auth when a separate gate password is configured.
curl -fsS http://127.0.0.1:18789/healthz | jq

# Supervisor output for the component.
tail -n 50 /abs/path/<profile>/control/openchamber.log

# OpenChamber's own Electron log.
tail -n 50 /abs/path/<profile>/openchamber/desktop/logs/main.log
```

Expected evidence:

- The launcher prints
  `OpenChamber launcher: gate=http://127.0.0.1:18789 state=... pid=...`.
- The app log contains
  `Using external OpenCode server at http://127.0.0.1:18789 (skip-start mode)`
  and `Detected OpenCode port: 18789`.
- A separate line such as
  `OpenChamber server listening on 127.0.0.1:57123` is OpenChamber's internal UI
  server. It is not the gate and not a second OpenCode server.
- `/livez` returns `{"alive":true,"version":1}`. `/healthz` reports the shared
  OpenCode service and plugin, and gateway readiness when used.

Check that no bundled OpenCode process was started:

```sh
pgrep -af '/opt/OpenChamber/openchamber.*--user-data-dir=/abs/path/<profile>/openchamber/desktop'
pgrep -af '/opt/OpenChamber/resources/opencode-cli/opencode' || true
```

The first command may show renderer/helper processes as well as the main
process; that is normal. The second command should show nothing. OpenChamber
ships a bundled CLI under `resources/opencode-cli`, but skip-start mode must not
run it.

Confirm there is no second OpenCode server by comparing the existing private
service registration before and after launch:

```sh
jq '{pid, url, version}' /abs/path/<profile>/state/opencode/service.json
```

The PID, URL, and version must be unchanged. Do not restart the service to make
the check pass.

Interactive checks:

1. The same workspace sessions and provider models are visible in OpenChamber,
   Desktop, and TUI.
2. A short prompt completes and produces a matching gateway/dashboard request
   count.
3. File edits open native diffs and file links work.
4. The folder-trust prompt appears once for a new project. Confirm the path
   before trusting it.
5. Continue a session created in Desktop/TUI in OpenChamber, then reopen it in
   Desktop/TUI: session identity and history remain the same.
6. Close or stop OpenChamber; the gate, OpenCode service, gateway, and any
   relay/tunnel remain running. The log shows the external-server skip message.
7. Run the same launcher again; the existing window is focused rather than a
   second process being created for the same profile. A supervisor Start while
   the process is verified running is a no-op.

Projects are frontend-local. OpenChamber stores its list under
`OPENCHAMBER_DATA_DIR/settings.json`; Desktop has its own. Add the same
directories in OpenChamber if you want them listed there. The shared service
still provides the same sessions for the same workspace.

## Frontend startup policy

| Configured components | Auto-start choice |
| --- | --- |
| `desktop` launchable, with or without `openchamber` | OpenCode Desktop |
| `openchamber` only | None; start OpenChamber from the dashboard |
| Neither | None; the gate remains available for Varro/manual attach |

OpenChamber is manual-only. Adding `components.openchamber` makes it available
in Controls, but normal startup and **Start system** never launch it; use its
**Start** action. Desktop remains the default auto-start frontend when
configured. Both frontends can be open at once because they attach to the same
shared service.

To use both:

1. Start OpenCode Desktop normally, or from the dashboard's component controls.
2. Start OpenChamber from the dashboard's **OpenChamber** controls when you
   want it.

Neither owns the shared OpenCode service, and closing one must not stop the
other. Removing `components.openchamber` does not delete its profile state.

Do not remove or rewrite `components.desktop` merely to test OpenChamber.
Installing the `.deb` is not configuration; it neither adds the component nor
starts the app.

## Updates, rollback, and state preservation

OpenChamber updates only itself. The safe manual path is:

1. Stop only the OpenChamber component from the dashboard. Leave the gate,
   OpenCode, gateway, and relay running.
2. Download the official `.deb` for the target version.
3. Verify its published SHA-256.
4. Install it:

   ```sh
   sudo apt install ./OpenChamber-<version>-linux-amd64.deb
   ```

   To return to an older version, make the downgrade explicit:

   ```sh
   sudo apt install --allow-downgrades ./OpenChamber-<older>-linux-amd64.deb
   ```

5. Start the OpenChamber component again.
6. Recheck the skip-start log line, the gate `/livez`, the service PID, and a
   short prompt.

The app also has an in-app update path: **Settings → OpenChamber → About**.
Checking and downloading there does not install anything by itself. Installing
asks for administrator authentication through `pkexec` and runs `apt` on the
downloaded `.deb`; the package is unsigned, so this is an explicit privileged
action. The app then quits its own background services, relaunches,
and is re-adopted by the supervisor through the profile-specific `match`. The
relaunch is outside the wrapper. Confirm the new process still reports
skip-start mode; if it does not, stop the component and start it again.

There is **no dashboard update button and no automatic privileged updater**.
The dashboard does not download or install packages. Do not expect `apt upgrade`
to update OpenChamber: no OpenChamber apt repository exists.

Rollback does not require deleting state. The package lives under
`/opt/OpenChamber`; `<profile>/openchamber` is separate and normally survives a
package install, upgrade, or downgrade. Keep a private backup if the state is
important, but treat the backup as secret material. Removing the package may
remove `/opt/OpenChamber`; it does not make `<profile>/openchamber` safe to
publish or copy to another machine.

If an update fails before installation, the app attempts to relaunch the
current version. If the package is installed but the relaunch does not attach
correctly, stop the component and start it from the supervisor. If the `.deb`
was extracted or repackaged instead of installed, the updater refuses to run;
reinstall the official package.

## Troubleshooting

### Socket path too long

Electron/Chromium creates a Unix single-instance socket under `TMPDIR`. A long
profile path can exceed the socket-path limit:

```text
FATAL:chrome/browser/process_singleton_posix.cc:337] Socket path too long: ...
```

The app exits immediately or cannot hand off to the existing instance. Start
through `deploy/openchamber/start-openchamber.sh`; it uses a short, hashed
runtime path. If `XDG_RUNTIME_DIR` itself is very long, point it at a shorter
private runtime directory (normally `/run/user/<uid>`) or move the profile to a
shorter absolute path. Do not set `TMPDIR=<profile>/tmp` or any other long path.

### Gate down or token mismatch

The launcher exits with status 75 and
`DeltaRelay frontend health gate is not ready; OpenChamber was not launched`.
Start or recover the gate from the supervisor; verify `/livez` with the same
private local token. A 401/403 means the token file is wrong or unreadable; a
connection failure means the listener is down. Do not bypass the launcher by
running `/opt/OpenChamber/openchamber` directly, because that may start a private
OpenCode server.

`/livez` success does not guarantee `/healthz` success. If the gate is up but
OpenCode or the plugin is unavailable, the gate returns 503 to forwarded
requests. Fix the service or plugin; do not restart the gate merely because the
relay is down.

### OpenChamber launched its own OpenCode

Symptoms include a new `opencode` process under
`/opt/OpenChamber/resources/opencode-cli`, a changed service registration, or a
log without `Using external OpenCode server ... (skip-start mode)`. Common
causes are launching from the desktop entry, running the `/opt` binary directly,
or a relaunch that lost the launcher environment.

Stop the incorrectly launched frontend, keep the shared service running, then
start the component from the supervisor. Verify `OPENCODE_HOST` and
`OPENCODE_SKIP_START` in the managed process environment without printing
secrets. Do not delete the service registration or restart OpenCode to repair a
frontend launch mistake.

### Duplicate instance

Electron's single-instance lock is per profile (and depends on a stable
`TMPDIR`). Two processes can coexist if they use different `--user-data-dir` or
a different temporary directory that puts the singleton socket elsewhere. A
mismatched `OPENCHAMBER_DATA_DIR` can also split settings and trust from the
window profile. Check:

```sh
pgrep -af '/opt/OpenChamber/openchamber'
```

Keep one state path and one runtime temp path. Stop the extra process through
the supervisor or your desktop session, not with a broad `pkill` pattern. A
second profile is a separate frontend, not a second OpenCode service; it still
attaches to the same gate and service if configured correctly.

### Update failure or polkit

If the in-app update does not show a privilege prompt, there may be no polkit
agent in the session, or `pkexec` may be unavailable. Check `pkexec` and the
desktop authentication agent, then use the manual `apt install` path above.
Errors such as `Neither dpkg nor apt command found`, an unsigned-package
warning, or a refused package type mean the environment cannot use the in-app
installer; do not work around them by disabling authentication or extracting the
package.

An update that installs but comes back without the attach environment should be
stopped and started from the supervisor. Do not run an OpenChamber from a
different package copy or a different `--user-data-dir` as an update workaround.

### Wayland focus or rendering

On Wayland, the compositor may refuse focus-stealing, so a second launch or tray
action does not raise the window. Use the taskbar/tray, or an X11 session if
your compositor cannot focus it. A warning such as
`'--ozone-platform=wayland' is not compatible with Vulkan` is diagnostic and
does not by itself mean the attach path failed. Do not change gate or OpenCode
configuration to address a compositor focus issue.

### `openchamber` on PATH vs `/opt/OpenChamber/openchamber`

Do not rely on an `openchamber` command being on `PATH`. The package installs
the application at `/opt/OpenChamber/openchamber`; the launcher and `match` use
that absolute path. A different `openchamber` found on `PATH` may be an
extracted or repackaged build with different state and no updater. If you
intentionally relocate the binary, update both `command` and `match` to the
exact absolute path and the profile-specific `--user-data-dir`.

## Security

- **Loopback only.** The launcher sets `OPENCHAMBER_HOST=127.0.0.1`, the gate URL
  must be a loopback `http://` origin with an explicit port, and the gate is
  loopback-only. Do not expose the gate, OpenChamber's internal UI server, the
  gateway, or OpenCode publicly. Do not enable LAN access to work around a
  connection failure.
- **Unsigned package.** Linux `.deb` packages are unsigned. SHA-256 checks
  integrity, not publisher identity. Review the release source, the checksum,
  and the privileged `pkexec` command before installing or updating. Do not
  disable apt authentication globally.
- **Private state.** `<profile>/openchamber` can contain OpenChamber device
  signing/encryption keys (`relay-identity.json`), auth stores, cookies, project
  lists, folder-trust decisions, and logs. It is not the DeltaRelay relay
  identity pin, but it is still sensitive. Keep directories mode `0700`, files
  mode `0600`, and never commit or upload the state directory.
- **Do not copy identity or trust blindly.** Copying `relay-identity.json`,
  `opencode-trust.json`, cookies, or auth state between machines or profiles can
  grant unintended folder access, reuse pairing keys, or make two frontends
  look like one. Start a fresh state and re-pair/re-trust deliberately.
- **Tokens stay out of argv and configuration values.** `DELTARELAY_LOCAL_AUTH_FILE`
  is a path, not a token. The launcher reads it privately. Never print the
  token, the gate password, or service registration passwords in logs, bug
  reports, or shell tracing.
- **Shared machine.** With the default gate there is no client password: any
  local process that can reach loopback can use the gate. Configure the gate's
  `--password-file` and `DELTARELAY_GATE_AUTH_FILE` when other local users are
  not trusted.
- **No backend ownership.** Nothing in the OpenChamber path may reset DeltaRelay
  identity, clear cache or saved responses, change provider routing, or start a
  second OpenCode server.

## Acceptance checklist

- [ ] The `.deb` installed successfully and `dpkg-query` reports 2.7.2 (or the
      intended version); the published SHA-256 matched.
- [ ] `/opt/OpenChamber/openchamber` exists and is the path used by the private
      component `command`/`match`.
- [ ] The supervisor configuration uses absolute paths, mode `0600`; the local
      token file is mode `0600` and is not in the JSON.
- [ ] `components.openchamber` is launchable; `match` includes the exact
      profile-specific `--user-data-dir`.
- [ ] A normal start launches Desktop and not OpenChamber; OpenChamber opens
      only from its dashboard **Start** action. `--no-frontend` (or
      `--no-desktop`) skips the initial Desktop launch while leaving the
      dashboard and gate running.
- [ ] The app log shows `Using external OpenCode server ... (skip-start mode)`
      and the gate URL; the internal UI port is not used as a gate or service
      port.
- [ ] No `/opt/OpenChamber/resources/opencode-cli/opencode` process appears; the
      OpenCode service PID/URL/version registration is unchanged.
- [ ] `/livez` succeeds with the local token; `/healthz` reflects the shared
      service/plugin and relay path without restarting the gate.
- [ ] OpenChamber shows the same workspace sessions and providers; a prompt
      increments the gateway/dashboard counters without a direct provider path.
- [ ] The folder-trust prompt works; projects can be added in OpenChamber even
      though they are not automatically shared with Desktop.
- [ ] Running the launcher again while OpenChamber is running focuses the
      existing instance; a supervisor Start is a no-op and does not create a
      second process. Stopping it leaves OpenCode, the gate, and the gateway
      untouched.
- [ ] Closing the window follows the configured tray behavior; a full quit logs
      `Skipping OpenCode shutdown (external server)`.
- [ ] Desktop still starts by default and OpenChamber starts only from its
      component control; removing `components.openchamber` leaves both
      frontends' state intact.
- [ ] Update, downgrade, and ordinary package removal leave
      `<profile>/openchamber` in place; no apt repository or dashboard update
      button was assumed.
- [ ] State directories are private and no token, device key, or trust file was
      copied into Git or another profile.
