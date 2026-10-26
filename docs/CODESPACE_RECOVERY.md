# Recover the existing Codespace test deployment

This is an optional recovery procedure for an **already configured** private test
profile, not installation instructions. A fresh clone intentionally contains no
`.runtime/` profile, credentials, Codespace identifier, `recover.sh` wrapper, or
Desktop launcher. For a new computer or VPS, follow [SETUP.md](SETUP.md) instead.
The tracked Python helpers accept an explicit profile and Codespace name; they
never discover or provision the original developer's deployment from this repo.

## Start everything, including Desktop

From the project directory:

```sh
./startup.sh
# Optional: allow 20 minutes of bounded retries on an unreliable connection.
./startup.sh --timeout 1200
# Recover the services only; leave Desktop closed.
./startup.sh --no-desktop
```

`startup.sh` first performs the recovery described below, then launches the
existing isolated Desktop profile from `.runtime/codespace-test/launch-desktop.sh`.
That profile is configured to send selected provider requests through the
recovered local gateway. The script does not start a second copy when that
Desktop profile is already running, and it does not touch your original Desktop
profile or provider credentials. It must run from a graphical session unless
`--no-desktop` is used.

## Recover the services only

Run this instead when Desktop should remain closed:

```sh
.runtime/codespace-test/recover.sh
```

This is an **on-demand** recovery command, not an always-on wake-up loop. Starting
a stopped Codespace resumes GitHub compute usage/billing. It leaves GitHub's idle
policy unchanged. Changing your default idle timeout applies to new Codespaces;
it does not change an existing Codespace's recorded timeout.

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
after readiness; `startup.sh` then launches the isolated Desktop profile if it is
not already running. A completed saved response can be fetched by its request ID;
generation interrupted by suspension is not automatically regenerated. The
existing gateway may deliver previously queued, explicit cancellations once
connectivity returns.

Implementation: `startup.sh` (the full start sequence) plus
`deploy/recover_codespace.py` and its self-contained remote helper
`deploy/recover_relay.py`. The private wrapper only supplies the existing
Codespace name and profile path; `startup.sh` calls that wrapper and then the
private Desktop launcher. For equivalent direct invocation of recovery only:

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
