# DeltaRelay

A Go client/server tool for **lossless incremental uploads of model API requests**.
The PC sends only content-defined chunks the VPS does not already hold. The VPS
reconstructs the exact body and verifies its length and SHA-256 before publishing
it. Neither side interprets or summarizes the conversation.

Includes an authenticated local gateway, allowlisted VPS forwarding, live response
streaming, cancellation, persistent replay protection, resource limits, and an
OpenCode V2 plugin. Files, tools and sign-ins stay local. There is no automatic
direct-provider fallback.

**Start here: [OpenCode Desktop and VPS setup](docs/SETUP.md).** Deployment and
plugin activation are explicit; building the tool does not change your existing
OpenCode configuration or session routing. The setup guide explains verification
and remaining live-provider/deployment requirements.

The `sync`/`fetch` commands below remain useful standalone diagnostic tools.

## Clone on a new computer

The checkout can live anywhere. Authenticate to GitHub before cloning this private
repository (for example, use `gh auth login` followed by `gh auth setup-git`, or
use its SSH clone URL with a configured SSH key). Never put a token in the URL:

```sh
git clone https://github.com/BritoAlv/deltarelay.git
cd deltarelay
```

Run the commands below from the repository root. No original development machine,
Codespace, private runtime directory, or prebuilt binary is required. Build locally,
then follow [the setup guide](docs/SETUP.md) to generate fresh credentials, configure
your own VPS, and generate the OpenCode plugin entry for this checkout.

- [OpenCode Desktop and VPS setup](docs/SETUP.md)
- [Architecture, ownership, and compatibility boundaries](docs/ARCHITECTURE.md)
- [Relay protocol and recovery contract](docs/PROTOCOL_V2.md)
- [Remote-host plugins: contract, SSH/HTTPS/Codespaces providers, and examples](docs/REMOTE_PROVIDERS.md)
- [Sanitized implementation and testing history](docs/SESSION_LOG.md)
- [Refactor Phase 0: compatibility, regression, and performance baseline](docs/REFACTOR_BASELINE.md)
- [Refactor Phase 1: shared contracts and semantic ownership](docs/REFACTOR_PHASE1.md)
- [Refactor Phase 2: client transport consolidation](docs/REFACTOR_PHASE2.md)
- [Refactor Phase 3: modular supervision and state ownership](docs/REFACTOR_PHASE3.md)
- [Refactor Phase 4: provider-job service and shared request validation](docs/REFACTOR_PHASE4.md)
- [Refactor Phase 5: shared filesystem primitives](docs/REFACTOR_PHASE5.md)
- [Refactor Phase 6: nonblocking telemetry persistence](docs/REFACTOR_PHASE6.md)
- [Refactor Phase 7: feature-oriented dashboard and browser regressions](docs/REFACTOR_PHASE7.md)
- [Refactor Phase 8: thin CLI, aligned defaults, and architecture guide](docs/REFACTOR_PHASE8.md)
- [Optional recovery for an existing private Codespace profile](docs/CODESPACE_RECOVERY.md)

Private configuration, tokens, logs, conversation exports, and relay state are
**not distributed through Git**. Keep them outside the checkout or in the ignored
`.runtime/` directory. A private GitHub repository is not a secret store. Review
`git status --short` and `git diff --cached` before committing; do not force-add
ignored files. On another computer, regenerate credentials for a new deployment
or transfer the existing relay token securely if intentionally using the same VPS.

`./startup.sh --config /private/supervisor.json` starts persistent recovery for an
**already configured** remote host, its local dashboard, and optional isolated
Desktop. [Remote-host providers](docs/REMOTE_PROVIDERS.md) support SSH computers,
HTTPS VPS deployments, Codespaces, or your own executable plugin in any language.
Controls come up before remote recovery; wake/stop appear only when supported,
and automatic wake starts off. Default startup reads your XDG configuration or
an existing private Codespace profile for compatibility. Private credentials and
Desktop profiles are not included in a clone. Use the setup guide, not that
script, to provision a new VPS. See [supervision and controls](docs/SUPERVISION.md).

## Build and test

Requires a Linux/POSIX environment and Go 1.24 or newer. Node.js 22+ is used for
plugin tests and the configuration generator; Make is optional. The race detector
also requires a C compiler and a Go-supported race-detector architecture. The
Go binary uses only the standard library: no external modules, database, container
runtime, or model API key is needed to build and run the default tests. Deployment
examples target Linux; systemd is optional and SSH is needed for tunnel deployments.

```sh
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
go test -race ./...
go vet ./...
node --test integration/opencode/*.test.mjs
```

`-trimpath` keeps build-machine filesystem paths out of the binary. The OpenCode
plugin has no npm dependencies, so no `npm install` is needed. The optional
installed-OpenCode test additionally requires OpenCode V2 on `PATH`. Python 3
is only needed for optional supervision/recovery helpers and their offline tests
(`make recovery-test`).

Run the complete offline matrix, including shared contract fixtures, Python
supervision tests, dashboard type/library tests, the static build, and browser
smoke tests, with one command:

```sh
make verify
```

It performs the offline pnpm install from the documented package store as its
first dashboard step. The matrix uses temporary local services and mocked
providers only; it never requires a real model account, a private runtime
profile, or a live deployment. The installed-OpenCode integration
(`make opencode-test`) and performance comparisons (`make baseline-benchmark`)
remain explicit opt-ins.

For a different Linux VPS architecture, cross-compile, for example:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/deltarelay-linux-amd64 ./cmd/deltarelay
```

## Web dashboard

The optional **Astro + TypeScript** dashboard shows per-session bandwidth savings,
active and recent requests, cache reuse, multi-day upload traffic, VPS/storage/
mailbox health, pending cancellations, and observed provider results. Traffic
ranges cover 24 hours, 7, 30, or 90 days, or a custom date range, with composition
and trend views for bandwidth saved and relay cache reuse. A separate Measurement
page traces a retained session from original body to encoded wire bytes, request
by request.
Optional supervisor integration adds service Start/Restart controls, automatic
network recovery, capability-based remote host wake/stop controls, and a ChatGPT
access-token expiry countdown.
It distinguishes **no internet** from an **unreachable VPS**. It is local; gateway
tokens stay in Go, not in browser storage. No UI/chart library, CDN, remote font,
or database is required. Dependencies are pinned for an offline pnpm build.

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

## Quick local trial

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

## PC to VPS

### Recommended first deployment: SSH tunnel

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

### Direct HTTPS

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

## Controlling resynchronization

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
retried by the transport layer; see [PROTOCOL_V2.md](docs/PROTOCOL_V2.md).

## How it works

1. The PC reads the body into a private temporary spool while computing its hash
   and content-defined boundaries. Memory use is bounded, not proportional to
   the entire body. The spool is removed on ordinary completion or error.
2. `POST /v1/missing` sends a versioned manifest with the complete hash, byte
   length, and ordered chunk hashes/lengths. The VPS verifies cache contents
   before reporting which unique chunks are missing.
3. The PC uploads only those chunks using `POST /v1/chunks`. Binary framing
   avoids base64 expansion. Default 256 KiB batches and four concurrent workers
   avoid a network round trip per chunk and reuse HTTP connections.
4. Both manifests and batches use gzip at its fastest level **only when it makes
   the payload smaller**. `--no-compression` disables this. Hashes identify the
   original bytes, never their compressed representation.
5. The VPS verifies each chunk before atomic persistence. `POST /v1/assemble`
   reconstructs chunks in the manifest's order into a temporary file, verifies
   every chunk, total length, and complete SHA-256, then atomically publishes it.
6. An incorrect body hash, unavailable chunk, or corrupt chunk cannot publish a
   new body. The client also checks that the server acknowledgment matches the
   original hash and size.

Default chunk sizes are 4 KiB minimum, 16 KiB target, and 64 KiB maximum. The
deterministic gear fingerprint chooses boundaries; SHA-256 identifies content.
Insertions near the beginning can resynchronize rather than invalidating every
following chunk as fixed offsets would. Edits, deletions, repeated content,
reordering, binary data, forks, and compaction need no conversation-specific
logic. Small changes can still require uploading a whole affected chunk.

### Statistics

| JSON field | Meaning |
| --- | --- |
| `hash`, `body_bytes` | SHA-256 and length of the complete original body |
| `chunks`, `unique_chunks` | Ordered references and distinct chunks in this body |
| `uploaded_chunks` | Chunks in successfully acknowledged upload batches |
| `uploaded_chunk_bytes` | Raw bytes in those acknowledged batches |
| `missing_chunk_bytes` | Raw bytes required by inventory, including when a budget rejects the upload |
| `reused_body_bytes` | Body bytes represented by chunks present at inventory time |
| `request_body_bytes_sent` | Encoded request-body bytes consumed by Go's HTTP transport, including manifests, framing, and gzip where used |
| `requests`, `duration_ms` | HTTP request attempts and complete operation time |

`request_body_bytes_sent` is **not** a packet-level network counter: HTTP headers,
TLS/TCP/IP overhead, responses, and retransmissions are excluded. On a failed
transfer, transport buffering can also mean it differs from bytes actually
received by the VPS. Partial progress statistics are still printed on failure;
unacknowledged persisted chunks are not counted as acknowledged uploads.

A repeatable test with 3 MiB of deterministic incompressible data and a small
append produced 3,165,696 encoded upload bytes cold versus 24,895 after the append
(about 99.2% less), with exact reconstruction. This is a synthetic measurement,
not a promised reduction for every workload or provider. Manifest overhead is
still proportional to the chunk count.

## Protocol and storage

All routes require `Authorization: Bearer <token>`. The relay contract is version 2;
see **[docs/PROTOCOL_V2.md](docs/PROTOCOL_V2.md)** for the complete, provider-independent
specification: identity pinning, durable response mailbox, resumable downloads,
retention, cancellation, and failure states.

| Route | Purpose |
| --- | --- |
| `GET /v2/info` | Protocol, relay state identity, capabilities, limits |
| `POST /v2/missing`, `POST /v2/chunks`, `POST /v2/assemble` | Chunk inventory, upload and body assembly |
| `GET /v2/bodies/{sha256}` | Ranged, verified body download |
| `PUT /v2/requests/{id}` | Idempotent submission; the only operation that dispatches to the provider |
| `GET /v2/requests/{id}` | Request state (`accepted`, `running`, `completed`, `failed`, `cancelled`, `interrupted`) |
| `GET /v2/requests/{id}/response?offset=N` | Saved provider bytes from an offset |
| `POST /v2/requests/{id}/ack` | Confirm receipt; releases storage, keeps duplicate protection |
| `POST /v2/requests/{id}/cancel` | Explicit cancellation |
| `GET /healthz`, `POST /v1/forward` (legacy) | Diagnostics and the previous forwarding path, kept for compatibility |

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

## Security and current boundaries

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

## Tests

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
