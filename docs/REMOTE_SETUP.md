# Set up a remote host from the dashboard

For a new installation, run from the checkout:

```sh
./startup.sh --no-desktop
```

If the default private supervisor configuration does not exist, startup creates
local onboarding configuration and opens the dashboard services without attempting
remote recovery. Visit **http://127.0.0.1:8790/controls**, choose **SSH host** or
**GitHub Codespace**, enter its existing SSH alias/`user@host` or Codespace name,
and select a **new** private remote directory. Confirm **Set up remote host…**.
There is no need to hand-write provider configuration, generate tokens, copy a
binary, or initialize an identity pin.

## Requirements and scope

- Local Go, Python 3, Node/pnpm and the dashboard's offline dependency cache.
- An existing Linux amd64/arm64 host with Python 3. Go is not needed remotely.
- For SSH: working noninteractive key/agent authentication and an already-trusted
  host key. Host-key verification is never disabled. Custom SSH configurations
  belong in your normal SSH alias; the form also accepts a numeric SSH port.
- For Codespaces: a current authenticated `gh` CLI and an existing Codespace.
  Confirmation authorizes resuming this selected machine, which can incur compute
  charges. If the CLI uses exported `GH_TOKEN`/`GITHUB_TOKEN`, those variable names
  are explicitly selected for subsequent provider recovery; values stay private.

Setup does not create a VM/Codespace, install packages, grant sudo, manage TLS, open
a public listener, sign in to model providers, or modify OpenCode configuration.
For an existing relay or direct HTTPS, use the manual [setup](SETUP.md) and
[provider configuration](REMOTE_PROVIDERS.md). Existing supervisor files are reused
unchanged; startup never replaces an existing deployment with onboarding defaults.

## What happens after confirmation

1. A read-only SSH preflight checks the platform and destination. Authentication,
   preflight, and local build failures leave the form editable.
2. Go cross-compiles the matching Linux binary locally, with module downloads off.
3. Setup saves a private pending record with the selected destination and fresh
   relay identity before attempting a remote write. It generates or reuses the
   private relay token without printing it. The local gateway token is never sent
   to the remote host.
4. A bounded, allowlisted archive containing the binary, relay token, upstream
   allowlist, and recovery helper travels over SSH stdin, never command arguments.
   The remote installer accepts only a new private directory or a matching marker
   from this exact interrupted setup. Existing deployments, symlinked paths,
   changed credentials, and different identities are refused, not overwritten.
5. The relay starts as an unprivileged detached process, listening only on remote
   loopback. Its authenticated `/info` must match the new identity and enable
   forwarding. No model generation is used as a health check.
6. Setup saves the local identity pin and private provider/supervisor configuration,
   establishes the local tunnel, verifies authenticated health again, and starts
   the local gateway. Future startup uses normal recovery of this same deployment.

The remote directory holds `deltarelay`, `relay.token`, `upstreams.json`,
`recover_relay.py`, `cache/`, PID/log files, and setup metadata. No systemd service
is installed. The supervisor can start/restart that existing relay after a host
restart, preserving cache, saved responses, and replay protection.

## Progress and interrupted setup

The map and setup status show actual progress, errors, and the responsible
component. The operation runs in the independent supervisor, so closing the page
does not cancel it. Refresh shows the current state; it does not submit another
installation.

After a transfer may have begun, **Resume remote setup…** uses the same destination,
token, and identity. It will not switch to another host after an uncertain result.
Fix the reported network/dependency problem, then resume. If the remote files have
changed, setup fails rather than resetting them. After configuration is saved,
automatic recovery handles ordinary connectivity failures; the map offers a
per-component **Recover** only for manual troubleshooting.

Generated local files use the XDG configuration/state directories:

- `${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json`, tokens, allowlist.
- `${XDG_STATE_HOME:-$HOME/.local/state}/deltarelay/relay-state.json`.
- The profile's private `control/setup-pending.json`, `setup-provider.json`, and
  activity journal. The browser receives only nonsecret status/destination fields.

The write API is the loopback-only, same-origin `POST /api/system/setup`, protected
by the dashboard's in-memory control nonce and explicit confirmation. It accepts
only the fixed host/directory/port schema, not shell commands or uploaded scripts.
First-time installation is separate from the recovery-only provider v1 contract;
automatic recovery never installs software or initializes replacement stores.
