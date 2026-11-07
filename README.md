# DeltaRelay

> **Disclaimer — AI-authored project:** All code, documentation, and other
> repository content are written by AI agents. Setup using this repository is
> likewise expected to be performed by an AI agent, with human oversight.
> AI-generated material can contain errors; review commands, configuration, and
> security implications before authorizing changes or deploying the project.

## The problem: uploading the same context again and again

Coding assistants send conversation history, source code, and tool output to a
model API repeatedly as a session grows. Much of each request is unchanged from
the previous one, but a normal full-body upload sends those bytes again. On a
slow or constrained upload connection, large contexts mean repeatedly transferring
data you have already sent.

**DeltaRelay reduces uploads from your PC to a trusted remote host without
changing the model request.** This Go client/server tool sends only content-defined
chunks the remote relay does not already hold. The relay reconstructs the exact
body, verifies its length and SHA-256, and forwards it to the provider. Neither
side summarizes or interprets the conversation.

The OpenCode V2 integration keeps your Desktop UI, project files, tool execution,
sessions, and sign-ins on your PC. Content included in model requests and the
credentials needed to forward them pass through the trusted relay. Provider
responses stream back live; there is no automatic direct-provider fallback.

## Measured results

A snapshot of the author's local dashboard statistics contained the following
**973 completed requests**, started between November 4 and November 7, 2026 (UTC):

| Metric | Measured result |
| --- | ---: |
| Original request bodies | 1,455,929,840 bytes (1.456 GB) |
| Encoded uploads from PC to relay | 27,471,915 bytes (27.47 MB) |
| Upload bytes avoided versus original bodies | 1,428,457,925 bytes (1.428 GB) |
| **Upload reduction** | **98.11%** |

The calculation is `1 - encoded_upload_bytes / original_body_bytes`. Encoded
uploads include manifests, chunk framing, compression, and counted HTTP request
attempts—not just the new text added to a conversation.

This is an observed sample from the retained request history, **not a benchmark
of every workload or the complete deployment history**. Failed, cancelled,
interrupted, and still-running requests are excluded from this sample. Figures
are a fixed snapshot of private local statistics; no prompts, credentials, or
session identifiers are published here. GB and MB use decimal units.

These counters exclude HTTP headers, TLS/TCP/IP overhead, responses, and network
retransmissions. They measure request-body uploads, not packet-level traffic or
speed improvements. Savings combine chunk reuse and compression; the comparison
is against original request bodies, not a separately compressed direct-provider
baseline. **The provider still receives the complete request: this is not a
promise of lower token usage or provider billing.**

For a repeatable synthetic example, a test with 3 MiB of deterministic
incompressible data and a small append produced 3,165,696 encoded upload bytes
cold versus 24,895 after the append (about 99.2% less), with exact reconstruction.
Your results depend on request sizes, edits, cache availability, and compression.

## Requirements

| Use case | Requirements |
| --- | --- |
| Standalone relay and diagnostic CLI | Linux/POSIX environment; Go 1.24+ to build. No external Go modules, database, container runtime, or model API key is needed for the default tests. |
| Dashboard and automatic remote setup | Local Python 3, Node.js 22.12+, pnpm 11+, and the dashboard dependency cache for offline installation. The committed lockfile was verified with pnpm 12.5.1; see [dashboard build requirements](docs/DASHBOARD.md#build-entirely-offline). |
| Remote relay | An existing trusted Linux amd64/arm64 host with Python 3 for automatic setup. Go is not required remotely; the binary is cross-compiled locally. |
| SSH setup | SSH with working noninteractive key/agent authentication and an already-trusted host key. For Codespaces, an authenticated current `gh` CLI and an existing Codespace are also required. |
| OpenCode integration | OpenCode **V2**, an existing working provider connection, and Node.js 22+ for configuration generation and plugin tests. The plugin has no npm dependencies. |
| Optional development tools | A C compiler and supported architecture for `go test -race`; Make for convenience targets; systemd only for optional service examples. |

The remote host must be trusted with request content and forwarded provider
credentials. This is a single-tenant deployment, not a shared public relay.
Automatic setup does not create machines, install system packages, sign in to
providers, or provision public TLS. Resuming a Codespace can incur compute charges.

## Installation and setup

### Clone on a new computer

The checkout can live anywhere. Authenticate to GitHub before cloning this private
repository (for example, use `gh auth login` followed by `gh auth setup-git`, or
use its SSH clone URL with a configured SSH key). Never put a token in the URL:

```sh
git clone https://github.com/BritoAlv/deltarelay.git
cd deltarelay
```

Run the following commands from the repository root. No original development
machine, private runtime directory, or prebuilt binary is required.

Private configuration, tokens, logs, conversation exports, and relay state are
**not distributed through Git**. Keep them outside the checkout or in the ignored
`.runtime/` directory. A private GitHub repository is not a secret store. Review
`git status --short` and `git diff --cached` before committing; do not force-add
ignored files. On another computer, regenerate credentials for a new deployment
or transfer the existing relay token securely if intentionally using the same VPS.

### Build and test

```sh
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
go test -race ./...
go vet ./...
node --test integration/opencode/*.test.mjs
```

`-trimpath` keeps build-machine filesystem paths out of the binary. The OpenCode
plugin has no npm dependencies, so no `npm install` is needed. The optional
installed-OpenCode test additionally requires OpenCode V2 on `PATH`. These
standalone Go/plugin checks do not require Python; automatic setup,
supervision/recovery helpers, and their offline tests (`make recovery-test`) do.

For a different Linux VPS architecture, cross-compile, for example:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/deltarelay-linux-amd64 ./cmd/deltarelay
```

### Set up the remote host

For the recommended dashboard-assisted setup, first make sure the dashboard
dependencies are cached as described in the [dashboard guide](docs/DASHBOARD.md),
then run:

```sh
./startup.sh --no-desktop
```

When the default configuration is missing, open
**http://127.0.0.1:8790/controls → Set up remote host**. Select an existing SSH host
or Codespace and a new private remote directory, then confirm. The dashboard
builds, transfers, and starts the relay and saves fresh private credentials, its
identity pin, and connection configuration. It does not overwrite an existing
deployment or create a machine. Follow [dashboard remote setup](docs/REMOTE_SETUP.md)
for prerequisites and interrupted-setup recovery.

For an existing relay or direct HTTPS, use the manual
[OpenCode Desktop and VPS setup](docs/SETUP.md) instead.

### Activate OpenCode and verify the connection

Follow the [OpenCode setup guide](docs/SETUP.md) to generate the plugin entry for
this checkout, explicitly enable it, and perform the connection and routing
checks. **Building DeltaRelay or setting up a host does not activate the plugin
or change your existing OpenCode configuration.** A working provider account and
its region/IP access restrictions remain your responsibility.

For an already configured deployment, start its dashboard, persistent recovery,
and optional isolated Desktop with:

```sh
./startup.sh --config /private/supervisor.json
```

Default startup reads your XDG configuration. Private credentials and Desktop
profiles are not included in a clone. See [supervision and controls](docs/SUPERVISION.md).
For a model-account-free check of the chunk transfer itself, use the
[quick local trial](#quick-local-trial) below.

## How it works

```text
OpenCode on PC → local gateway → missing chunks over SSH/HTTPS → remote relay → provider
              ← live response stream ←─────────────────────────────────────────────┘
```

1. The PC reads the request body into a private temporary spool while computing
   its hash and content-defined chunk boundaries. Memory use is bounded, not
   proportional to the entire body. The spool is removed on ordinary completion
   or error.
2. `POST /missing` sends a manifest with the complete hash, byte length, and
   ordered chunk hashes/lengths. The relay verifies cache contents before
   reporting which unique chunks are missing.
3. The PC uploads only those chunks using `POST /chunks`. Binary framing avoids
   base64 expansion. Default 256 KiB batches and four concurrent workers avoid a
   network round trip per chunk and reuse HTTP connections.
4. Manifests and batches use gzip at its fastest level **only when it makes the
   payload smaller**. `--no-compression` disables this. Hashes identify the
   original bytes, never their compressed representation.
5. The relay verifies each chunk before atomic persistence, reconstructs the
   body in manifest order, and verifies every chunk, total length, and complete
   SHA-256 before accepting it. The client checks the acknowledgment against the
   original hash and size. A missing/corrupt chunk or incorrect hash cannot
   publish a new body.
6. In the OpenCode integration, the authenticated gateway submits the verified
   body for allowlisted provider forwarding and streams the response back. The
   diagnostic `sync` command uses `POST /assemble` to publish a retained body
   instead; `fetch` can download it to verify exact reconstruction.

Default chunk sizes are 4 KiB minimum, 16 KiB target, and 64 KiB maximum. A
deterministic gear fingerprint chooses boundaries; SHA-256 identifies content.
Insertions near the beginning can resynchronize rather than invalidating every
following chunk as fixed offsets would. Edits, deletions, repeated content,
reordering, binary data, forks, and compaction need no conversation-specific
logic. Small changes can still require uploading a whole affected chunk.

The first request must send all content not already cached. Losing the remote
cache requires sending missing content again, and manifest overhead grows with
the chunk count. The relay reduces the **PC-to-remote-host upload**, not the
complete remote-host-to-provider request.

## Additional features and reference

- [Dashboard and measurement details](docs/DASHBOARD.md)
- [Automatic recovery and service controls](docs/SUPERVISION.md)
- [Architecture and ownership](docs/ARCHITECTURE.md)
- [Relay protocol and recovery contract](docs/PROTOCOL.md)
- [Remote-host providers: SSH, HTTPS, Codespaces, and custom plugins](docs/REMOTE_PROVIDERS.md)
- [Automatic recovery acceptance testing](docs/RECOVERY_TESTING.md)

The sections below cover dashboard operation, standalone diagnostics, transport
options, limits, security, and development tests.

### Web dashboard

The optional **Astro + TypeScript** dashboard shows per-session bandwidth savings,
active and recent requests, cache reuse, multi-day upload traffic, VPS/storage/
mailbox health, pending cancellations, and observed provider results. Failed and
client-cancelled requests are counted separately. Traffic
ranges cover 24 hours, 7, 30, or 90 days, or a custom date range, with composition
and trend views for bandwidth saved and relay cache reuse. The dashboard is split
into Overview, Sessions, System controls, and System health pages; a separate
Measurement page traces a retained gateway session from original body to encoded
wire bytes, request by request. Its session browser can list the local OpenCode
session catalog by title, day, project, and model, while only sessions with
gateway measurements remain traceable. With gateway request capture enabled (the default),
selecting a request exposes the actual decoded body, ordered chunk availability,
prepared upload batches, counted HTTP attempts, and the exact savings calculation.
Each page polls only the API it needs and has its own refresh/pause state.
Optional supervisor integration adds a live system connection map, per-component
Start/Recover/Restart actions, automatic network recovery, capability-based remote
host wake/stop controls, system shutdown, and a ChatGPT access-token expiry
countdown. The map shows Desktop, the OpenCode server and plugin, gateway,
transport, Ethernet/Wi-Fi/VPN path, remote host, relay, storage, provider, and the
local dashboard/supervisor control plane separately. A process being alive is not
reported as a working connection.
Automatic recovery is the normal mode: interface, address, route, and DNS changes
trigger connection checks; only the broken part is repaired and then verified.
The dashboard and supervisor stay running after system shutdown, so recovery can
be resumed without a terminal. A private bounded journal remains on disk for
support, but the browser no longer renders a log console.
It distinguishes **no internet** from an **unreachable VPS**. It is local; gateway
tokens stay in Go, not in browser storage. No UI/chart library, CDN, remote font,
or database is required. Dependencies are pinned for an offline pnpm build.
Request-evidence capture is on by default and stores request payloads in the
private `.runtime/dashboard-captures` directory. Because those payloads can
contain prompts, source code, tool output, and other secrets, pass
`--capture-dir ""` to disable capture. Captures are exposed only through the
loopback dashboard; see [measurement details](docs/DASHBOARD.md).

```sh
pnpm install --offline --frozen-lockfile --trust-lockfile
pnpm check
pnpm test
pnpm test:browser        # focused DOM smoke tests; also builds the static page
pnpm build
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
./bin/deltarelay dashboard --local-token-file /path/to/private/local.token
```

With your gateway running, open **http://127.0.0.1:8790**. Rebuild and restart an
older gateway to enable session collection. New gateways save bounded metadata
in `.runtime/dashboard-stats.json` by default; previous logs are not imported.
**[Dashboard setup, offline builds, and measurement details](docs/DASHBOARD.md)**
explain the local token, cache requirements, development mode, and security model.
Savings mean reduced uploads, **not** a promised provider-billing discount.

**[Automatic recovery, service controls, and token expiry](docs/SUPERVISION.md)**
cover VPN switching and private configuration for both deployment types. Without
a configured supervisor socket, service controls remain disabled.

### Quick local trial

Choose a long random token and set the **same value in both terminals**. Do not
commit it or put it in command-line arguments. One way to generate a value is
`openssl rand -hex 32`; save it securely rather than generating separate tokens
on each side.

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

The second synchronization should report `uploaded_chunks: 0`. It still uploads
manifest/control metadata; "no repeated chunks" does **not** mean zero network
traffic. Change the input and synchronize it again to measure reuse.

Each successful invocation outputs one JSON statistics object, including the
complete-body `hash`. To verify the reconstruction yourself:

```sh
./bin/deltarelay fetch --hash '<hash-from-sync>' --output reconstructed.json
cmp request.json reconstructed.json
```

`fetch` refuses to overwrite an existing destination. Downloading the full body
is a diagnostic operation, not part of the regular upload protocol.

Use `--input -` (the default) to read from stdin. Run a subcommand with `-h` for
its flags. The whole-operation timeout defaults to four hours and is adjustable
with, for example, `--timeout 1h`.

### PC to VPS

#### Recommended first deployment: SSH tunnel

On the VPS, securely set `DELTARELAY_TOKEN` and run:

```sh
./deltarelay serve --listen 127.0.0.1:8787 --data /path/to/private/deltarelay-data
```

On your PC:

```sh
ssh -N -L 8787:127.0.0.1:8787 your-user@your-vps
```

Then run `sync --server http://127.0.0.1:8787` on your PC. SSH encrypts the network
hop; the service is not exposed publicly. No token is placed in the URL.

#### Direct HTTPS

The server can terminate TLS using a certificate trusted by your PC:

```sh
./deltarelay serve --listen :8787 --data /path/to/private/deltarelay-data \
  --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem
```

Then use `sync --server https://relay.example.com:8787`. Certificate verification
is never disabled. A properly configured HTTPS reverse proxy is another option.

Non-loopback plaintext HTTP is rejected by the client unless `--allow-http` is
explicitly passed. That flag exposes conversation content and the bearer token
to the network: do not use it over the public internet. The server's default
listen address is loopback; do not expose a plaintext listener publicly.

### Controlling resynchronization

An initial synchronization necessarily uploads all unique content. If the VPS
loses its cache, those missing chunks necessarily need transferring again.

To prevent a surprise large resynchronization, set a raw missing-content budget:

```sh
./bin/deltarelay sync --input request.json --max-upload-bytes 262144
```

If more than 256 KiB of chunks are missing, the operation stops **before any
chunk upload**. Control metadata has already been sent. `--max-upload-bytes 0`
allows cache hits only. The default, `-1`, permits initial synchronization.
The budget measures uncompressed missing chunk bytes, not encoded HTTP traffic.

There is no direct-provider bypass or alternative full-body upload endpoint.
Transient network failures are retried automatically for up to one hour
(`--retry-window`). Each retry re-checks which chunks the relay already holds, so
only missing data is sent. Permanent errors (authentication, changed relay
identity, integrity failures) are never retried. Provider generation is never
retried by the transport layer; see [PROTOCOL.md](docs/PROTOCOL.md).

### Statistics

| JSON field | Meaning |
| --- | --- |
| `hash`, `body_bytes` | SHA-256 and length of the complete original body |
| `capture_id` | Optional link to a private evidence capture; absent means content was not retained |
| `chunks`, `unique_chunks` | Ordered references and distinct chunks in this body |
| `uploaded_chunks` | Chunks in successfully completed logical upload batches; recovery can mean not every listed frame was retransmitted |
| `uploaded_chunk_bytes` | Raw bytes in those logical batches; the evidence inspector shows actual counted attempt consumption |
| `missing_chunk_bytes` | Raw bytes required by inventory, including when a budget rejects the upload |
| `reused_body_bytes` | Body bytes represented by chunks present at inventory time |
| `request_body_bytes_sent` | Encoded request-body bytes consumed by Go's HTTP transport, including manifests, framing, and gzip where used |
| `requests`, `duration_ms` | HTTP request attempts and complete operation time |

`request_body_bytes_sent` is **not** a packet-level network counter: HTTP headers,
TLS/TCP/IP overhead, responses, and retransmissions are excluded. On a failed
transfer, transport buffering can also mean it differs from bytes actually
received by the VPS. Partial progress statistics are still printed on failure;
unacknowledged persisted chunks are not counted as acknowledged uploads.

### Protocol and storage

All relay routes require `Authorization: Bearer <token>`. There is one API, with
unversioned URLs and no compatibility aliases. See **[docs/PROTOCOL.md](docs/PROTOCOL.md)** for the complete, provider-independent
specification: identity pinning, durable response mailbox, resumable downloads,
retention, cancellation, and failure states.

| Route | Purpose |
| --- | --- |
| `GET /info` | Protocol, relay state identity, capabilities, limits |
| `POST /missing`, `POST /chunks`, `POST /assemble` | Chunk inventory, upload and body assembly |
| `GET /bodies/{sha256}` | Ranged, verified body download |
| `PUT /requests/{id}` | Idempotent submission; the only operation that dispatches to the provider |
| `GET /requests/{id}` | Request state (`accepted`, `running`, `completed`, `failed`, `cancelled`, `interrupted`) |
| `GET /requests/{id}/response?offset=N` | Saved provider bytes from an offset |
| `POST /requests/{id}/ack` | Confirm receipt; releases storage, keeps duplicate protection |
| `POST /requests/{id}/cancel` | Explicit cancellation |

The loopback gateway exposes `/proxy`, `/dashboard`, `/inspection/...`, `/healthz`,
and `/metrics`. The browser dashboard uses same-origin `/api/...` endpoints.
Upgrade all components together; startup does not translate old configurations or
restart running services to apply an upgrade. Current identity pins, saved
responses, cache, and replay claims are never reset.

Recovering a saved answer needs only its request ID:

```sh
./bin/deltarelay request status --id '<request-id>'
./bin/deltarelay request fetch --id '<request-id>' --output ./answer.sse --ack
```

The batch format is `DRLY0001`, a big-endian uint32 chunk count, then frames of
32 raw hash bytes, a big-endian uint32 decoded size, and that many content bytes.
Order and repeated chunks belong to the manifest, not the upload batch.

Limits bound decoded and encoded request sizes, chunk counts, batch sizes, and
server concurrency. Defaults: 256 MiB per body, 65,536 chunk references, 8 MiB per
manifest, 16 MiB per framed batch, 1,024 chunks per batch, and eight concurrent
server requests. The body limit may be lowered with `--max-body-bytes`.

Storage is sharded by SHA-256 under `chunks/` and `bodies/`. Files are written
privately, synced, and atomically renamed on the same filesystem; directory
entries are synced before success is acknowledged. Acknowledged chunks survive
ordinary restarts. Unexpected leftover `.pending-*` files from a hard crash are
ignored. Corrupt cached chunks are treated as missing and can be repaired.

### Security and current boundaries

- Single trusted client/tenant per token and data directory. This is not a
  multi-tenant service; anyone holding the token can access that store.
- Token comparison is constant-time. Redirects are not followed, so the client
  will not forward its bearer token to a redirected endpoint.
- No request-body or token logging. Cache files and temporary spools contain
  **plaintext**, with private filesystem permissions, not encryption at rest.
  A hard-killed PC process can leave a spool; use an encrypted disk and a private
  `TMPDIR` if required. Cleanup does not promise secure erasure.
- Persistent cache defaults to a 10 GiB cap; the replay journal defaults to
  100,000 records. Neither is automatically evicted. Capacity failures stop
  requests rather than bypass the relay. Run one server per data directory.
- Normal forwarding uses anonymous verified body spools, not retained full
  conversations. Diagnostic `sync` still stores each distinct complete body.
- Cancellation propagates through both hops to the provider. Arbitrary blocking
  standalone input readers must themselves support stopping.
- No guarantee of provider token/KV-cache hits or lower provider billing. This
  tool reduces PC-to-VPS transfers, not the full VPS-to-provider request.
- The included V2 plugin forces selected model providers to HTTP and disables
  automatic retries while enabled. Live account, region, VPS access and plugin
  activation still require the setup checks; tests do not use your real accounts.
- No automatic public TLS provisioning, privileged installation, multi-tenant
  isolation, cache garbage collector, or packet-level traffic accounting.

### Tests

Run the complete offline matrix, including shared contract fixtures, Python
supervision tests, dashboard type/library tests, the static build, and browser
smoke tests, with `make verify`. It performs the offline pnpm install from the
documented package store as its first dashboard step. The matrix uses temporary
local services and mocked providers only; it never requires a real model
account, private runtime profile, or live deployment. The installed-OpenCode
integration (`make opencode-test`) and performance comparisons
(`make baseline-benchmark`) remain explicit opt-ins.

```sh
make verify
go test -v ./internal/client -run TestDeltaRoundTripAndRestart
go test ./internal/chunker -run '^$' -bench BenchmarkSplit -benchmem
go test ./internal/chunker -run '^$' -fuzz FuzzRoundTrip -fuzztime 10s
node --test integration/opencode/*.test.mjs
pnpm test:browser
DELTARELAY_TEST_OPENCODE=1 go test -v ./internal/gateway -run TestInstalledOpenCodePlugin -count=1
```

The tests exercise exact reconstruction, real HTTP client/server transfers,
upload savings, insertion resynchronization, deletion/fork/summary-like bodies,
empty and binary inputs, compression, restart persistence, corruption, malformed
manifests, truncated batches, resumable progress, upload budgets, authentication,
redirect refusal, concurrency limits, cancellation, and safe file export.
End-to-end gateway tests cover immediate SSE/tool-event streaming, exact original
provider requests, preserved credentials, idle timeouts, cancellation, redirect
refusal, and duplicate-request rejection. The opt-in test runs the actual
installed OpenCode against a mock provider with isolated configuration.
