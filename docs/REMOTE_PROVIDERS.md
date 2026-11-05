# Remote-host providers, contract v1

DeltaRelay is not tied to GitHub Codespaces. Any existing machine that runs the
relay and exposes trusted HTTPS or an encrypted tunnel can be used. The remote
relay still implements the [DeltaRelay protocol](PROTOCOL.md); hosting plugins do not
replace uploads, forwarding, durable responses, authentication, or identity pins.
The bundled relay and supervisor currently target Linux/POSIX environments.

A **remote-host provider** is a trusted local executable that describes how to
connect to and optionally manage an existing deployment. It can be written in
any language and live outside this repository. No registration, rebuild, GitHub
account, plugin marketplace, or automatic download is required. Contract v1 does
**not** create machines, install software, initialize stores, or delete resources.
The separate [dashboard first-run setup](REMOTE_SETUP.md) can install the relay
on a selected existing SSH host or Codespace after explicit confirmation, then
save ordinary provider configuration for subsequent recovery.

## Configure an existing host

First complete [SETUP.md](SETUP.md), including relay authentication, SSH host trust
or HTTPS certificate verification, and the gateway's saved `relay-state.json` pin.
Do not remove that pin to make recovery succeed.

1. Copy `deploy/supervisor.example.json` to a private file. Replace all paths and
   create its `profile` directory with mode 700.
2. Copy one of `deploy/providers/*.example.json` to another private file and
   configure your existing host. Make both files mode 600.
3. Select the executable in the supervisor configuration:

```json
{
  "remote": {
    "command": ["/usr/bin/python3", "-B", "/your/checkout/deploy/providers/ssh.py"],
    "config_file": "/home/you/.config/deltarelay/ssh.json"
  }
}
```

This is a configuration **fragment**, not the full supervisor configuration.
`command[0]` must be absolute. Interpreter/script argv is supported; do not put
credentials in argv. `config_file` must be an absolute, owner-readable private
regular JSON file, owned by the current user, with no group/other permissions or
symlink. Executables and their dependencies are explicitly trusted local code,
not sandboxed. Keep credentials in private files or explicitly selected variables.

`relay_url` in the plugin's `connection` result must match the supervisor's
`relay_url` (ignoring a trailing slash). The gateway's `--server` must use this
same stable URL. Allowed origins are trusted HTTPS, or HTTP on `127.0.0.1`,
`localhost`, or `::1` behind an encrypted tunnel. Credentials, paths, queries, and
fragments are forbidden. A plugin cannot redirect the gateway to a different host.

When `remote` is configured, omit `codespace`, `components.tunnel`, and
`components.relay`: two owners of the remote connection/service are an error.
Local dashboard, gateway, and optional OpenCode/Desktop components remain normal
supervisor components.

Check only the read-only plugin operations, then start:

```sh
python3 -B deploy/check_remote_provider.py --config /private/supervisor.json
./startup.sh --config /private/supervisor.json --no-desktop
```

The checker validates schema/version, URL agreement, stable descriptions and
connection specifications, and status. It never launches a tunnel, performs a
model request, or invokes an advertised mutation. A trusted plugin can itself do
anything your account can do; the checker cannot prove that its code is read-only.

Without `--config`, `startup.sh` reads
`${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json`.
It never discovers private test profiles or silently chooses/provisions a remote
host. A missing default configuration starts the separate first-run setup UI.
Local controls start before any plugin invocation, so a broken/offline provider
does not prevent the dashboard from opening.

### Bundled providers

| Executable under `deploy/providers/` | Behavior |
| --- | --- |
| `ssh.py` | Foreground OpenSSH tunnel; optional existing service start/restart commands. No cloud power API. |
| `direct_https.py` | Existing HTTPS relay; no tunnel or administration. |
| `codespaces.py` | Existing Codespace wake/stop, foreground port forward, and recovery of the existing relay deployment. |

**SSH:** `host` is an existing SSH alias or `user@host`; `relay_url` must be an
explicit `http://127.0.0.1:PORT`. `remote_port` defaults to 8787. `ssh` optionally
selects an absolute executable; `ssh_options` adds trusted argv (e.g. `-p`, `2222`).
Batch mode, strict host-key verification, and bounded connection/keepalive options
are supplied before custom options. Establish host trust yourself first; nothing
installs keys or grants sudo permissions.

Optional `start_command` / `restart_command` are **remote argv**, shell-quoted by
the provider, and advertise the corresponding relay capability. When either is
present, `relay_state_file` must be the absolute **remote** path to the existing
store's `mailbox/identity.json` (not the PC's pin). The provider checks that file
against the pinned identity before service management and guards the command with
the same check. Missing, symlinked, or changed identities refuse service startup.
These commands must use that same store and must never initialize/reset it.
The example assumes an already-installed systemd **user** unit; change it to your
actual unit and management method. Remote management requires a POSIX shell and
`head`, not a new public administration endpoint. Omit both commands for
tunnel-only use.

**HTTPS:** configure only `relay_url`. The machine power state is honestly
`unknown`; core authenticated health determines connectivity. TLS verification is
never disabled. Use a custom provider if you also need remote service management.

**Codespaces:** configure `name`, `relay_url`, `remote_directory`, and optionally
`remote_port` (default 18787) / absolute `github_cli`. `remote_directory` is the
existing deployment layout used by `recover_relay.py`, including its saved store,
`relay.token`, `upstreams.json`, and `deltarelay-linux-amd64` binary. This provider
does not install or update those files. A current authenticated `gh` CLI and
remote Python 3 are needed. Available compute is not proof of SSH/relay readiness.

### Environment and deadlines

Plugins and their generated tunnels receive a small environment: `PATH`, `HOME`,
user/locale/timezone, `TMPDIR`, SSH agent, certificate-location, and XDG variables.
Model credentials, OpenCode server selectors, and cloud credentials are not
implicitly passed. A plugin can still access your files: this is hygiene, not
isolation. `remote.pass_env` explicitly selects extra variable names, for example
`["GH_TOKEN"]` for a Codespaces CLI using exported authentication. `remote.env`
supplies explicit string overrides. Neither is sent to the browser.

`remote.timeout_seconds` is an integer from 1 to 300, default 120. Read-only calls
are capped at five seconds. Each invocation has a total deadline, bounded stdin
and stdout, and process-group termination on timeout/cancellation. Bundled
providers keep subprocesses in their invocation's group. Plugins must not
daemonize or escape the group; a process group is not a sandbox. No plugin is
automatically retried inside an invocation. Supervisor recovery applies bounded
backoff and never automatically retries `relay.restart` or `host.stop`.

## Wire contract

The machine-readable envelope/result schemas are in
[`remote-provider-v1.schema.json`](remote-provider-v1.schema.json). Runtime
validation additionally checks private files, origins/ports, capability gating,
and the configured stable URL. Contract v1 is independent of relay protocol v2
and supervisor/dashboard status v2.

One invocation receives exactly one UTF-8 JSON object on **stdin**, followed by
EOF. Write exactly one JSON object to **stdout**, optionally followed by whitespace,
and exit 0. Structured errors also exit 0. Nonzero exit is `provider_failed` even
if stdout contains JSON. No banners, progress output, trailing JSON, duplicate
keys, nonfinite numbers, or unknown fields are accepted. Request and response
limits are each 65,536 bytes. Under supervision, stderr and the actual stdout
response are captured in the private activity journal and displayed in the local
dashboard console; outside supervision stderr is drained without being returned
as a provider result. Never print credentials. Diagnostic output does not relax
stdout validation or change error/retry semantics.

Bundled providers additionally trace nested command execution over an optional
inherited pipe, selected by `DELTARELAY_TRACE_FD`. This leaves the v1 request and
stdout response unchanged and is not required of third-party providers. Each
UTF-8 JSONL diagnostic record has exactly `stream`, `text` and `execution` fields:
`stream` is `event`, `command`, `stdout`, `stderr`, `output`, `exit` or `error`;
`text` is at most 16,384 characters; `execution` is an eight-character lowercase
hex command ID. Records are bounded/validated, credential-masked and rendered as
text. Do not pass the descriptor to daemonized children or use it as a management
channel. A plugin that does not implement it still has its own invocation,
stdout/stderr, timeout and exit status recorded; its silent internal actions are
not invented by the console. The bundled `provider_command` runner implements
the channel automatically.

Request (all five fields required):

```json
{
  "protocol_version": 1,
  "id": "operation-123",
  "method": "status",
  "config_file": "/private/my-host.json",
  "params": {}
}
```

Responses echo the exact integer version and request ID, with **exactly one** of
`result` or `error`:

```json
{"protocol_version":1,"id":"operation-123","result":{"host_state":"running"}}
```

```json
{"protocol_version":1,"id":"operation-123","error":{"code":"unreachable","retryable":true}}
```

### Methods and exact result shapes

| Method | Parameters | Result | Requirement |
| --- | --- | --- | --- |
| `describe` | `{}` | `{"id":"my_host","label":"My host","capabilities":[]}` | Required, read-only. |
| `connection` | `{}` | `{"relay_url":"https://relay.example.com"}` with optional `tunnel` below | Required, read-only. |
| `status` | `{}` | `{"host_state":"unknown"}` | Required, read-only. |
| `relay.ensure` | `{"expected_state_id":"64 lowercase hex digits"}` | `{"state_id":"same identity"}` | Optional, idempotent start of the existing relay; no implicit machine wake or restart of a healthy relay. |
| `relay.restart` | Same as ensure | Same as ensure | Optional, explicitly confirmed disruptive restart. Never part of automatic recovery. |
| `host.wake` | `{}` | `{"host_state":"running"}` or `starting` | Optional, idempotent wake of the existing machine; may resume billing. |
| `host.stop` | `{}` | `{"host_state":"stopped"}` or `stopping` | Optional, idempotent stop, not deletion; preserve persistent storage. |

`id` matches `[a-z][a-z0-9_-]{0,63}`. `label` is 1–80 Unicode characters with no
control characters, rendered as text, never HTML. Capabilities are a unique array
containing only the four optional method names. Required methods are implicit.
The same plugin/config must return stable descriptions and connections during a
supervisor run. Restart the supervisor after configuration changes; do not change
deployment identity, connection specifications, or capabilities mid-run.

Host states are `running`, `stopped`, `starting`, `stopping`, and `unknown`.
Return `unknown` when power state cannot be determined; do not infer stopped from
a network failure. The supervisor polls `status` to confirm asynchronous wake/stop
within a bounded window. All mutations must tolerate repeated invocations after
an uncertain outcome without creating/deleting resources or resetting state.

For tunnels, `connection` adds:

```json
{
  "relay_url": "http://127.0.0.1:8787",
  "tunnel": {
    "command": ["/usr/bin/ssh", "-NT", "-L", "127.0.0.1:8787:127.0.0.1:8787", "your-existing-host"],
    "port": 8787
  }
}
```

This example omits recommended SSH trust/keepalive flags for brevity; use the
bundled SSH provider's defaults in real deployments. `command` is an argv array,
not a shell string. Its executable is absolute and it must run in the foreground.
The URL must be loopback, and `port` must match its effective port. The supervisor
owns its PID file, verified process adoption, logs, cancellation, and restarts.
`connection` must never start the tunnel itself. Direct HTTPS has no tunnel.

### Errors and recovery policy

Only the codes enumerated in the JSON schema are accepted. `retryable` must match
the following classification; a plugin cannot mark an identity/auth/TLS failure
as transient:

- **Transient (`true`):** `unreachable`, `command_timeout`, `command_failed`,
  `provider_timeout`, `provider_failed`, `host_unavailable`, `host_stop_timeout`,
  `relay_ssh_timeout`, `relay_recovery_failed`.
- **Permanent (`false`, block automatic mutations):** `authentication_failed`,
  `tls_verification_failed`, `protocol_mismatch`, `identity_mismatch`,
  `identity_unavailable`, `configuration_error`, `forwarding_disabled`,
  `invalid_provider_response`, `provider_version_mismatch`, `invalid_configuration`,
  `unsafe_private_file`, `invalid_request`, `unsupported_operation`.
- **Policy/cancellation (`false`):** `host_stopped`, `operation_cancelled`.

Unknown error strings and free-form diagnostic fields in the **protocol
response** are rejected; the separate local activity log preserves actual
execution diagnostics without treating them as error codes or policy inputs.
Fix permanent failures explicitly and restart the supervisor;
recovery never weakens verification or resets the store to clear them.

Core recovery checks the host's power state before starting a tunnel that might
implicitly wake it. A stopped host is woken only with saved opt-in or confirmed
manual consent. Once the host is running, recovery first repairs the local tunnel
and gives it a bounded readiness window, then ensures the existing relay only if
necessary. Even if that remote command returns a transient failure, the core
rebuilds and verifies the tunnel before declaring failure: SSH may time out after
successfully starting the relay. Success is established only by core authenticated
`/info` with the existing identity pin. Plugin return values never establish
readiness. No management operation submits a model request or replays a generation.

Automatic wake starts disabled. Manual wake, stop, and restart require explicit
confirmation through the protected local control API. Before stop, the supervisor
persists both automatic reconnect and automatic wake as **off**, even if stopping
fails or times out. It never silently re-enables them on manual wake.

## Implement your own

Start with `examples/remote-provider/provider.py`, a standalone standard-library
example, and its example configuration. Replace its connection/status code with
your infrastructure API or tunnel definition. Advertise optional operations only
when you can honor their safety semantics. You do not need to import DeltaRelay.

Use the read-only checker above, then test your mutations against disposable
infrastructure with your own fixtures. The repository tests use fake executable
plugins, a fake GitHub CLI, and local faults—not real cloud accounts or paid work:

```sh
make recovery-test
# Include the real dashboard/gateway/relay lifecycle against an isolated fake
# GitHub CLI (no cloud account or external internet probe):
make build
DELTARELAY_RECOVERY_TEST_BINARY="$PWD/bin/deltarelay" make recovery-test
go test -race ./...
pnpm check
pnpm test
```

## Supported configuration and status

The supervisor requires `remote`; inline `codespace` settings and separately
configured tunnel/relay components are rejected. Use the bundled Codespaces
plugin for an existing Codespace deployment. Startup does not rewrite private
configuration or automatically restart live services to apply an upgrade.

Supervisor status uses version 2 and exposes `remote` containing only `id`,
`label`, `host_state`, and `capabilities`. Remote power actions target `remote`.
The provider envelope and supervisor configuration retain their independent
version-1 data formats; there are no alternate implementations for older shapes.
