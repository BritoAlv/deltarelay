# Architecture and ownership

This document is the short map of DeltaRelay's packages, data/control flows,
lifecycle ownership, dependency direction, and compatibility boundaries. It
describes the implementation after the architecture-refactor program; the
normative relay contract remains [PROTOCOL_V2.md](PROTOCOL_V2.md), and observed
defaults/precedence remain recorded in
[REFACTOR_BASELINE.md](REFACTOR_BASELINE.md).

## Non-negotiable boundaries

- Request bodies are reconstructed exactly; provider response bytes, SSE
  framing, and tool events are never rewritten.
- A request ID is durably claimed before provider dispatch. Neither transport
  retries nor recovery can automatically generate a second provider response.
- Relay identity is fail-closed. Existing stores, journals, mailbox records,
  fingerprints, and cancellation checkpoints are not migrated or reset.
- Provider generation and legacy forwarding are never wrapped in generic
  retries. Retries apply only to reads or operations whose idempotency the
  protocol enforces.
- Optional dashboard statistics are not durable mailbox storage.
- Request-evidence capture is separate from metadata statistics: it is enabled
  by default, stores request-side payloads only on private local disk, and is
  served only through validated read-only inspection routes. An empty
  `--capture-dir` disables it.
- The Go runtime is standard-library-only; the dashboard is static and
  framework-light.

## Package ownership

| Package / path | Owns |
| --- | --- |
| `cmd/deltarelay` | CLI parsing, environment/file precedence, loopback validation, component composition, and HTTP listener shutdown. |
| `internal/protocol` | Wire versions and constants, request-ID validity, manifest/batch framing, relay capabilities, and mailbox payload types. |
| `internal/chunker` | Content-defined chunk boundaries and chunker configuration. |
| `internal/transfer` | The semantic transfer-statistics value shared by the client and telemetry. |
| `internal/client` | PC-side spooling, chunk inventory/upload, relay RPC attempts, retry policy, response resumption, checkpoints, and the offline cancellation outbox. |
| `internal/upstream` | Destination allowlist matching, DNS/private-network rejection, header filtering, and the provider HTTP client. |
| `internal/fsx` | Narrow filesystem mechanics: directory syncing, atomic replacement, JSON writes, and exclusive creation. Callers keep their own durability and overwrite policies. |
| `internal/inspection` | Private request/attempt evidence capture, bounded retention and quota accounting, crash checkpoints, and validated read-only inspection routes. |
| `internal/store` | Content-addressed chunk/body cache, verification, assembly, and cache quota accounting. |
| `internal/journal` | Exclusive, durable provider-dispatch claims and replay refusal. |
| `internal/mailbox` | Relay identity, request tombstones/status, checksummed response frames, retention, ACK/expiry reclamation, and response storage limits. |
| `internal/server` | VPS HTTP routes, provider-request validation/fingerprints, the request/job service, provider concurrency, cancellation, shutdown, and legacy streaming. |
| `internal/gateway` | Loopback OpenCode gateway authentication, provider proxying, request concurrency, metadata-only accounting, and request capture attachment. |
| `internal/telemetry` | Bounded in-memory session/request history and its optional background persistence worker. |
| `internal/dashboard` | Local diagnostics proxy, static-asset serving, browser-origin protection, the narrow supervisor-control bridge, and optional local-only OpenCode session metadata for the measurement browser. |
| `testdata/contracts` | Sanitized cross-language fixtures consumed by Go, Python, and TypeScript tests. |
| `deploy/supervision` | Importable Python configuration, observable state, process ownership, probes, recovery policy, and control API. |
| `deploy/*.py`, `deploy/providers` | Executable compatibility entry points, provider plugins, remote recovery helpers, and provider contract checking. |
| `integration/opencode` | OpenCode V2 plugin that routes selected providers through the local gateway without automatic retries. |
| `web` | Static Astro dashboard, feature controllers, pure library helpers, and DOM-level browser tests. |

## Dependency direction

Production imports point from composition and transport layers toward protocol,
value-type, and filesystem-mechanics packages. There are no package cycles.

```text
cmd/deltarelay
  ├── internal/server ──> store, mailbox, journal, upstream, protocol
  ├── internal/gateway ─> client, inspection, telemetry, upstream, transfer, protocol
  ├── internal/client ──> chunker, fsx, inspection, upstream, transfer, protocol
  └── internal/dashboard ─> inspection

internal/inspection ────> fsx, protocol, transfer
internal/telemetry ─────> fsx, transfer
internal/store ─────────> fsx, protocol
internal/journal ───────> fsx, protocol
internal/mailbox ───────> fsx, protocol
internal/chunker ───────> protocol
internal/upstream ──────> protocol
internal/transfer ──────> (no internal imports)
```

The client does not import the gateway or VPS server implementation. The
gateway does not receive relay-store paths or mailbox internals. The dashboard
never receives relay or provider authentication credentials. When capture is
enabled (the default), it can read captured request bodies, which may themselves
contain secrets as documented in [DASHBOARD.md](DASHBOARD.md).

## Data plane

### Chunk upload and diagnostic sync

1. `client` spools the body to a private temporary file while the chunker emits
   content-defined boundaries and the complete SHA-256.
2. `POST /v2/missing` returns the unique chunks the relay lacks.
3. `POST /v2/chunks` uploads only missing content in bounded batches, with
   adaptive gzip and re-inventory after ambiguous batch failures.
4. `POST /v2/assemble` verifies every chunk, total length, and whole-body hash
   before publishing the body; `server` delegates persistence to `store`.

### Durable provider request

1. The local gateway (or `sync`) submits provider metadata plus the manifest to
   `PUT /v2/requests/{id}`.
2. `server.jobService` acquires a provider slot, durably claims the ID in the
   journal, reconstructs the request body from verified chunks, and dispatches
   through the allowlisted `upstream` policy.
3. The response is stored synchronously as checksummed mailbox frames before it
   is advertised. The PC resumes from `GET /v2/requests/{id}/response?offset=N`.
4. An ACK releases payload storage only after the client verifies and publishes
   its local file. The tombstone and replay protection remain.
5. Cancellation is explicit. An offline client keeps a private outbox and
   retries only the cancellation command, never generation.

Legacy `POST /v1/forward` shares validation, header normalization, and
fingerprint construction with durable submission, but keeps a request-scoped
streaming lifetime and does not create a durable response.

### Dashboard and supervision control

- Browser diagnostics request same-origin `/api/dashboard`; the Go dashboard
  authenticates its own `GET /v1/dashboard` to the gateway. Gateway tokens never
  enter browser storage.
- With the default `--capture-dir`, the gateway attaches request evidence to a
  metadata observation. An empty `--capture-dir` disables capture. The dashboard
  proxies only validated read-only `/api/inspection` routes, and the capture
  store keeps its own retention independent of the statistics file. Provider
  response bodies are not captured.
- With `--opencode-service-file`, the dashboard may read the local OpenCode V2
  `/api/session` catalog and expose only sanitized, local-only session metadata
  through `/api/opencode/sessions`. Messages, content, credentials, cost, token
  counts, permissions, and full paths never cross that boundary. The catalog is
  optional and failure falls back to gateway-retained sessions.
- `/api/system` and approved control POSTs go to the optional private supervisor
  Unix socket. They do not depend on gateway availability. Controls remain
  disabled when the supervisor is absent, stale, unmanaged, or does not support
  the action.
- The supervisor composes configuration, process ownership, probes, recovery
  policy, provider plugins, and the control API in `deploy/supervision`.
  Compatibility entry points under `deploy/` remain executable for existing
  private configurations.

## Lifecycle ownership

| Owner | Start / stop responsibility |
| --- | --- |
| `cmd/deltarelay` | Parses flags, constructs components, defers cleanup, and uses one `runHTTPServer` helper for context-driven graceful shutdown. TLS selection, listener timeouts, header limits, and component `Close` calls stay explicit at each command. |
| `server.Server` / `jobService` | Refuses new admission after shutdown, cancels running jobs, closes the mailbox, waits for terminal job records, and releases all provider slots. |
| Legacy forward handler | Ties provider streaming to the requesting HTTP request; it is not part of job-service background execution. |
| `client.Client` | Stops the cancellation-outbox worker and closes idle HTTP connections. Persisted pending cancellations remain for the next start. |
| `gateway.Gateway` | Closes the telemetry recorder and capture store after HTTP shutdown so their bounded final flushes can run. |
| `telemetry.Recorder` | One worker per persistent recorder. In-memory `Begin`/`Finish` update synchronously; dirty snapshots are coalesced and written at most about once per second. |
| `inspection.Store` | Owns one exclusive, private capture directory. Running captures expose in-memory evidence, are checkpointed about once per second, flush on shutdown, and resume interrupted captures from the last checkpoint only. |
| `dashboard.Handler` | Closes idle gateway and supervisor-connection clients. It owns no background polling. |
| Python supervisor | Serializes service operations, keeps slow probe/process work outside the state lock, and owns child process groups and bounded provider calls. |

## Optional telemetry versus durable responses

Telemetry is observability only. `Begin()` and `Finish()` update the retained
in-memory totals and recent-request list synchronously and return without disk
I/O. A persistent recorder's single background worker rewrites its private
`--stats-file` at most about once per second, retries the newest snapshot after a
failure, and exposes `persistence_error`; the visible lock is released only after
the worker's last write. Clean shutdown performs one final flush and waits at
most five seconds.

An abrupt process or machine crash can therefore lose roughly the last second
of retained statistics. That window never applies to the dispatch journal,
mailbox frames, request claims, cancellations, or ACKs: those remain synchronous
and durable on the request path. A memory-only recorder (`--stats-file ''`) has
no worker and no lock.

## Compatibility boundaries

| Boundary | Preserved contract |
| --- | --- |
| Chunk format | v1 framing, chunk sizes, hashes, and batch encoding. |
| Relay API | v2 routes, capabilities, limits, fingerprint representation, states, and error codes. |
| Legacy forwarding | `/v1/forward` remains available for compatible callers; no v2 client falls back to it. |
| Remote-provider plugin | v1 JSON envelope and required/optional operations. |
| Supervisor status | v1 payloads are normalized at the compatibility boundary; current responses are v2. |
| Dashboard history | v1 metadata-only statistics snapshot. Optional `capture_id` links and the `inspection` snapshot block are additive; older gateways and saved history remain valid. |
| Request inspection | Optional and enabled by default. A gateway with an empty `--capture-dir` omits the status block and never reconstructs historical payloads; inspection routes remain bounded and read-only. |
| Persisted state | Mailbox identity/records/frames, exclusive journal markers, client relay pin, download checkpoints, and cancellation outbox use their existing formats. No storage migration is planned. |
| Private execution paths | `deploy/supervisor.py`, `deploy/start_supervisor.py`, `deploy/start_dashboard.py`, `deploy/recover_*.py`, and provider executable paths remain usable without rewriting private configuration. |

## Defaults and verification

Component defaults live with the package that owns the behavior: protocol sizes
in `internal/protocol`, transfer workers/batches/recovery in `internal/client`,
provider-job and mailbox limits in `internal/server` and `internal/mailbox`,
capture retention defaults in `internal/inspection`, and dashboard integration
defaults in `internal/dashboard`. The CLI registers flags
from those values where semantics match and keeps only composition-owned choices
(listen addresses, file locations, command-wide timeouts) locally.

The complete offline matrix, including Go race/vet/build, plugin tests, Python
supervision tests, shared contracts, dashboard type/library tests, static build,
browser smoke tests, and whitespace checks, is:

```sh
make verify
```

It uses temporary local services and mocked providers, never real accounts,
private profiles, or live deployments. `make opencode-test` (installed OpenCode)
and `make baseline-benchmark` (performance) are separate opt-ins.
