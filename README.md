# DeltaRelay

> **AI-authored project:** Repository content is written by AI agents, and setup
> is intended for an AI agent with human oversight. Review commands, configuration,
> and security implications before deploying.

## Stop uploading the same context again and again.

**Send missing chunks. Rebuild the exact request. Verify it with SHA-256.**

DeltaRelay reduces repeated uploads from your PC to a trusted remote host. The
relay reconstructs the request body and checks its SHA-256 and byte length against
the original before forwarding it to the model provider. It does not summarize
or modify requests.

The OpenCode V2 integration keeps your UI, files, tools, sessions, and sign-ins
local. Responses stream back through the relay, with no automatic direct-provider
fallback.

## 445.3 MiB of request bodies. 14.4 MiB uploaded.

**96.8% less uploaded** in the dashboard's captured 24-hour window below.

![Dashboard upload composition and cache-reuse charts: 445.3 MiB original, 14.4 MiB uploaded, 430.9 MiB saved, and 94.9% cache reuse.](docs/images/dashboard-savings.png)

Actual local dashboard capture, November 7, 2026 (UTC), with rounded display
values. The chart reports finished requests only: 595 requests, including
5 failed and 15 cancelled in that window. **This is an observed sample, not a
benchmark or a speed guarantee.**

Reduction is `1 - encoded upload bytes / original body bytes`. It combines chunk
reuse and compression, includes upload control metadata, and excludes HTTP
headers, TLS/TCP/IP overhead, responses, and network retransmissions. The baseline
is the original body, not a separately compressed direct upload. Results depend
on the workload and cache availability. **The provider still receives the full
request; this mechanism does not reduce token usage or provider billing.**
See [measurement details](docs/DASHBOARD.md).

## Same request. Verified before forwarding.

1. **On your PC:** compute the original request body's SHA-256 and byte length,
   and split it into content-defined chunks.
2. **Across the connection:** upload only chunks the relay is missing.
3. **On the VPS/remote host:** verify the chunks, rebuild the body in order, and
   compare its SHA-256 and length with the original manifest.
4. **Only after verification:** forward the reconstructed body to the provider.
   An integrity mismatch stops the request.

## Your workspace stays local. The relay handles the upload.

![Actual dashboard architecture map showing local OpenCode components, encrypted tunnel, remote relay and storage, model provider, and the independent dashboard and recovery control plane.](docs/images/dashboard-architecture.png)

Actual dashboard map captured November 7, 2026 (UTC), using GitHub Codespaces as
the remote host. Status labels are observations at capture time—not a claim that
every connection is verified. The map distinguishes the model-request path from
checks, recovery, and management. Request content and forwarding credentials still
pass through the trusted relay. See [architecture](docs/ARCHITECTURE.md).

## Requirements

- **Build:** Go 1.24+ in a Linux/POSIX environment.
- **Dashboard:** Python 3, Node.js 22.12+, pnpm 11+, and cached dependencies for
  [offline installation](docs/DASHBOARD.md#build-entirely-offline).
- **Launcher:** uv and an existing Python 3.14 installation; downloads are disabled.
- **Remote setup:** An existing trusted Linux amd64/arm64 host with Python 3,
  noninteractive SSH authentication, and a trusted host key. Codespaces also
  requires an authenticated current `gh` CLI and an existing Codespace.
- **OpenCode integration:** OpenCode V2, a working provider connection, and Node.js
  22+. The plugin has no npm dependencies.

## Setup

```sh
git clone https://github.com/BritoAlv/deltarelay.git
cd deltarelay
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
```

After preparing the [dashboard dependencies](docs/DASHBOARD.md), start setup:

```sh
uv run ./deltarelay start --no-desktop
```

Open **http://127.0.0.1:8790/controls → Set up remote host** and select an existing
SSH host or Codespace and a new private remote directory. Setup builds and
transfers the relay and saves private credentials and connection configuration.
It does not create machines, install system packages, or provision public TLS.
See the [remote setup guide](docs/REMOTE_SETUP.md).

Next, follow the [OpenCode setup guide](docs/SETUP.md) to enable the plugin and
verify routing. **Building the project or setting up a host does not activate the
plugin.** That guide also covers manual setup and direct HTTPS.

For an existing deployment:

```sh
uv run ./deltarelay start --config /private/supervisor.json
```

Without `--config`, startup reads your XDG configuration. Credentials and Desktop
profiles are not included in a clone. See [supervision and controls](docs/SUPERVISION.md).

## Quick local trial

No model account is needed. Set the **same long random token** in both terminals
(generate one with `openssl rand -hex 32`).

Terminal 1:

```sh
export DELTARELAY_TOKEN='<same-long-random-token>'
./bin/deltarelay serve --data ./data --listen 127.0.0.1:8787
```

Terminal 2, using any request-body file:

```sh
export DELTARELAY_TOKEN='<same-long-random-token>'
./bin/deltarelay sync --input request.json
./bin/deltarelay sync --input request.json
```

The second sync should report `uploaded_chunks: 0`; control metadata is still
sent. To check the reconstructed body yourself, use the `hash` returned by sync:

```sh
./bin/deltarelay fetch --hash '<hash-from-sync>' --output reconstructed.json
sha256sum request.json reconstructed.json
cmp request.json reconstructed.json
```

The SHA-256 values should match, and `cmp` should exit successfully with no output.
Use a new output path: `fetch` refuses to overwrite an existing file. Change the
input and sync again to measure reuse; use a subcommand's `-h` for options.

## Security and limitations

- Trust the remote host with request content and forwarded provider credentials.
  This is a single-tenant relay, not a shared public service.
- Use SSH or verified HTTPS. Do not expose a plaintext listener publicly.
- Cache files, temporary spools, and diagnostic captures contain plaintext.
  Dashboard request capture is enabled by default; use `--capture-dir ""` to
  disable it. See [dashboard security](docs/DASHBOARD.md).
- Keep tokens, configuration, and logs outside Git, either outside the checkout
  or in ignored `.runtime/`. Never commit secrets or place tokens in URLs.
- A cold or lost cache requires uploading missing content again. Storage is
  bounded but not automatically evicted; capacity failures stop requests rather
  than bypassing the relay.

## Development

Run the complete offline test matrix with:

```sh
make verify
```

This requires the cached dashboard dependencies and a C compiler for Go race
tests. Tests use local services and mock providers, not real model accounts.
Installed-OpenCode tests (`make opencode-test`) and performance comparisons
(`make baseline-benchmark`) are opt-in.

## Documentation

- [OpenCode Desktop and VPS setup](docs/SETUP.md)
- [Automatic remote setup](docs/REMOTE_SETUP.md)
- [Dashboard, offline builds, and measurements](docs/DASHBOARD.md)
- [Automatic recovery and service controls](docs/SUPERVISION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Protocol, storage, limits, and recovery](docs/PROTOCOL.md)
- [Remote-host providers](docs/REMOTE_PROVIDERS.md)
- [Recovery acceptance testing](docs/RECOVERY_TESTING.md)
