# Per-host profiles and Codespace organization

DeltaRelay keeps one private profile directory per remote host or GitHub
Codespace. Switching hosts changes a single active-profile pointer; the
supervisor, local token, OpenCode profile, gateway address, and plugin
configuration stay the same.

Everything described here is private runtime state. Keep the profile root
outside Git and never commit tokens, account wrappers, identity pins, captures,
or personal host names.

## Layout

```text
.runtime/
  codespace-profile/              # shared local profile: OpenCode, Desktop, control
  current -> codespaces/alpha     # active remote host; the only switching pointer
  accounts/
    <account>.gh                  # optional private GitHub CLI account wrapper
  codespaces/
    alpha/
      provider.json               # provider kind, host name, remote directory
      relay.token                 # shared PC <-> remote relay secret
      state/relay-state.json      # pinned remote relay identity
      stats.json                  # dashboard history for this host
      captures/                   # dashboard request captures for this host
    beta/
      ...
```

- `provider.json`, `relay.token`, `state/relay-state.json`, and the state
  directory are private regular files/directories (`0600` files, `0700`
  directories).
- `stats.json` and `captures/` are per host. A new host starts with empty
  history; existing hosts keep their own history.
- `relay.token` and `state/relay-state.json` must never be shared between
  profiles. A relay identity belongs to exactly one deployment.
- The shared local profile contains `local.token`, `upstreams.json`, the
  OpenCode/Desktop configuration, and supervisor journals. It is not tied to a
  remote host.

The supervisor configuration points through the pointer:

```json
{
  "relay_token_file": "/absolute/path/.runtime/current/relay.token",
  "relay_state_file": "/absolute/path/.runtime/current/state/relay-state.json",
  "remote": {
    "command": ["/usr/bin/python3", "-B", "/absolute/path/deploy/providers/codespaces.py"],
    "config_file": "/absolute/path/.runtime/current/provider.json"
  },
  "components": {
    "gateway": {
      "command": [
        "/absolute/path/bin/deltarelay", "gateway",
        "--token-file", "/absolute/path/.runtime/current/relay.token",
        "--state-dir", "/absolute/path/.runtime/current/state",
        "--stats-file", "/absolute/path/.runtime/current/stats.json",
        "--capture-dir", "/absolute/path/.runtime/current/captures"
      ]
    }
  }
}
```

Future hosts are added under `codespaces/`; the supervisor file does not need
to be edited again.

## Selecting a profile

```sh
./deltarelay use --list
./deltarelay use alpha
```

`use` validates the target profile, stops only the local gateway and remote
connection, stops the local supervisor, atomically repoints `.runtime/current`,
then starts the local supervisor and verifies the new connection. It does not
stop the previous remote host or delete any profile.

To update the pointer without starting services:

```sh
./deltarelay use alpha --no-start
```

The default supervisor configuration is
`${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json`. Use `--config`
when the private supervisor file lives elsewhere.

## GitHub account selection

A Codespace provider may run the GitHub CLI without changing the globally
active `gh` account. Put a private executable wrapper under `.runtime/accounts/`
and reference it from that profile's `provider.json`:

```json
{
  "name": "<codespace-name>",
  "relay_url": "http://127.0.0.1:18787",
  "remote_port": 18787,
  "remote_directory": "/home/codespace/.local/share/deltarelay/<profile>",
  "github_cli": "/absolute/path/.runtime/accounts/<account>.gh"
}
```

Example wrapper:

```sh
#!/bin/sh
set -eu
GH=/absolute/path/to/gh
GH_TOKEN=$("$GH" auth token --user <github-account>) || exit 1
export GH_TOKEN
# Do not exec here: the supervisor verifies the tunnel process by its wrapper
# argv. The wrapper stays in front and waits for the GitHub CLI.
"$GH" "$@"
```

The wrapper resolves its own token for each invocation. Do not put tokens in
argv, provider configuration, repository files, or the wrapper itself. Do not
commit wrappers or account names. The globally active account is unaffected.

## Creating a new profile

1. Complete remote setup for the new host, as described in
   [remote setup](REMOTE_SETUP.md), or install the relay manually as described
   in [OpenCode setup](SETUP.md).
2. Create `.runtime/codespaces/<name>/` with mode `0700`.
3. Save the host's provider configuration as `provider.json` with mode `0600`.
4. Write a new `relay.token` and `state/relay-state.json` for that deployment
   with mode `0600`. Never reuse another host's token or identity.
5. Select it with `./deltarelay use <name>`.

Installing a relay or changing a profile does not activate the OpenCode plugin;
that remains a separate local step. See [OpenCode setup](SETUP.md).

## Security and cleanup

- Treat every profile as containing secrets: relay tokens, capture files, and
  request history. Keep the profile directory private and out of Git.
- A host's cache and saved responses live on the remote host, not in the local
  profile. Removing a local profile does not remove the remote deployment.
- Removing a profile is an explicit operator action. DeltaRelay never deletes
  profiles automatically.
- The dashboard request-capture directory contains plaintext prompts and
  responses. Use `--capture-dir ""` in the gateway command to disable captures
  for a profile if required.
