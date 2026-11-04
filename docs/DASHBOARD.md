# Local web dashboard

DeltaRelay's dashboard is an optional Astro application written in TypeScript,
built with pnpm. It is static HTML/CSS plus a small browser script, served by the
Go binary. There is no Node production server, UI framework, charting package,
database, CDN, remote font, or paid health probe.

## What you can see

For VPN/network recovery, service Start/Restart controls, selectable Codespace
auto-wake, manual wake/stop, and the ChatGPT access-token expiry countdown, see
**[Supervision and controls](SUPERVISION.md)**. Those APIs are independent of
gateway statistics and remain available when the gateway is down. Controls are
disabled unless the dashboard is explicitly connected to a private supervisor.

- **Open OpenCode Desktop** beside Refresh launches the configured isolated
  Desktop instance without restarting other services. The button explains when
  its launcher is unavailable or Desktop is already running.
- Global and per-session original bytes, encoded uploads, bandwidth saved, and
  upload reduction, including failed and cancelled attempts and negative savings.
  Failed and cancelled requests are counted separately; a client that closes
  after the terminal stream event is reconciled against the relay and recorded
  as completed when the full response was delivered.
- Upload traffic over 24 hours, 7, 30, or 90 days, or a custom date range.
  Composition and trend views plot bandwidth saved and relay cache reuse with a
  legend, range summary, tooltips, and responsive axes. Cache reuse versus raw
  uploaded chunks remains visible beside the chart.
- Active requests, upstream, request kind (primary/title/compaction/generate),
  status, duration, and safe error codes in a session inspector.
- A separate **Measurement** page traces any retained session with the same
  read-only snapshot. It shows the measured body-to-wire process, a direct
  original-versus-encoded comparison, and an expandable per-request ledger with
  cache reuse, raw chunk uploads, encoded bytes, HTTP attempts, and response
  bytes that are excluded from upload savings.
- With gateway payload capture enabled (the default), select a request to inspect
  its actual decoded body (UTF-8, hex + ASCII, lossless JSON formatting, or exact
  download), ordered chunk-presence rectangles with byte ranges, prepared upload
  batches and frame offsets, and each counted HTTP attempt with its encoding,
  prepared/consumed lengths, and validated acknowledgment. Requests predating
  capture, or excluded by retention, say **Not captured**; their content is never
  reconstructed.
- Gateway concurrency and uptime; relay reachability, identity, protocol and
  health-check latency; chunk-cache and durable-response-mailbox usage/capacity;
  pending cancellations and control errors.
- Separate **no internet** and **VPS unreachable** states when the local
  supervisor is configured. The supervisor confirms local internet connectivity
  only after the relay probe fails, so a downed VPS is not mislabeled as an
  offline computer.
- Latest retained provider results. These are observations, **not** live provider
  account/authentication checks. An enabled allowlist is not proof of a healthy
  provider. No provider generation is sent by the dashboard.
- Session search, state filters, pagination, CSV export, manual refresh, and
  pause/resume. Automatic refresh is every ten seconds while the tab is visible.
  A failed refresh keeps the last live snapshot and explicitly marks it stale.
- A **Theme** picker above Overview offers Graphite + Blue (the default),
  Porcelain + Teal, Midnight + Violet, Sand + Terracotta, and the original
  Forest + Green. Light and dark palettes cover the whole dashboard, including
  charts, health states, and the session inspector.

## Themes and personal preferences

Theme changes apply immediately without a reload or service operation. The
selected theme ID is the only appearance data saved, under
`deltarelay.dashboard.theme` in this browser's local storage. Other dashboard tabs
on the same origin stay in sync; other browsers/users keep their own choice.
No credentials, conversation data, or theme preferences are sent to the gateway.
If storage is blocked, switching still works for the current page. Unknown or
removed theme IDs fall back to Graphite + Blue. A same-origin external startup
script restores saved colors before first paint without weakening the script CSP.

To add a palette, add one entry to **`web/src/lib/themes.ts`**, with a unique ID,
name, light/dark mode, and all semantic color tokens. The picker, generated
`themes.css`, and preference validation use that single registry; no component
or chart changes are needed. Use the existing tokens in component styles rather
than hardcoded colors. `pnpm test` checks palette completeness and text contrast.

## Build entirely offline

Run from the repository root. Go 1.24+, Node.js 22.12+ and pnpm 11+ are needed to
build. The committed lockfile was verified with pnpm 12.5.1. The cached native
toolchain used here targets Linux x64/glibc; its explicit Rollup binary dependency
avoids silently skipped optional native packages during offline installs. Other
build platforms need their corresponding cached native tooling. This does not
change cross-compiling the standalone Go binary.

```sh
pnpm install --offline --frozen-lockfile --trust-lockfile
pnpm check
pnpm test
pnpm test:browser
pnpm build
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
```

`--offline` never falls back to downloads. The workspace also defaults to offline
mode and disables dependency lifecycle scripts, preventing postinstall download
fallbacks. Astro telemetry is disabled in the scripts. Vite, Rollup, and one
Markdown transitive dependency are pinned to cached versions. The pinned
`happy-dom` dev dependency is used only by the browser smoke tests; it is not
included in the static dashboard bundle and adds no runtime client dependency.

pnpm 12's `--trust-lockfile` skips fetching fresh registry metadata for its
supply-chain policy check; it uses the reviewed, committed lockfile and its
integrity hashes. Use it only with a lockfile you trust. In particular, do not
replace it with an arbitrary downloaded lockfile to work around missing packages.

On a different machine, the pnpm store must **already contain** the locked
packages and the platform's native build tools. A Git clone is not a package
cache. If the install reports a cache miss, stop: transfer/provision the pnpm
store from a trusted machine rather than removing `--offline`. If your shell uses
a private `XDG_CACHE_HOME` while the existing pnpm metadata lives elsewhere, point
that environment variable to your actual cache **for installation only**. No
machine-specific cache path is committed in this project.

The built `web/dist/` can instead be copied from a trusted build machine; the Go
dashboard command needs no pnpm, Node, package store, or internet at runtime.

## Connect to your gateway

For the **already configured private Codespace test profile**, `./startup.sh`
starts/reuses the dashboard automatically before background recovery, including with
`--no-desktop`. It selects the profile's gateway on port 18788 and its existing
local token file. Missing/stale builds use Go and the offline pnpm cache. A
verified legacy read-only dashboard is upgraded; other live services are adopted
without restart. Use `--no-dashboard` to skip a new dashboard launch, or set
`DELTARELAY_DASHBOARD_PORT` before the first supervised startup to choose another
loopback port (default 8790).
See [CODESPACE_RECOVERY.md](CODESPACE_RECOVERY.md) for prerequisites and logs.
This shortcut does not provision a profile in a fresh clone.

First follow [SETUP.md](SETUP.md) to configure the relay, tunnel, local gateway,
and OpenCode plugin. Rebuild and restart an older **Go gateway** for the new
diagnostic endpoint. No routing configuration is changed automatically.

The gateway collects bounded, private session metadata by default:

```sh
./bin/deltarelay gateway \
  --server http://127.0.0.1:8787 \
  --token-file /path/to/private/relay.token \
  --local-token-file /path/to/private/local.token \
  --upstreams /path/to/private/upstreams.json \
  --stats-file .runtime/dashboard-stats.json
```

Use your existing gateway flags, upload budgets, and recovery configuration; do
not start another gateway on the same port. `--stats-file` is the only new flag
needed for an alternative history location. `DELTARELAY_STATS_FILE` can also set
it. `--stats-file ''` keeps history in memory only. Statistics are collected even
with `--quiet`, which only suppresses metadata logs.

In another terminal, start the dashboard with the **same local token file as the
gateway**, not the VPS bearer token:

```sh
./bin/deltarelay dashboard \
  --gateway http://127.0.0.1:8788 \
  --local-token-file /path/to/private/local.token \
  --assets web/dist
```

Open **http://127.0.0.1:8790**. The dashboard is split into focused pages:
**Overview** (`/`), **Sessions** (`/sessions`), **System controls** (`/controls`),
**System health** (`/system`), and **Measurement** (`/measurement`). The sidebar
links every page, and each page polls only the API it needs with its own
refresh/pause state. `DELTARELAY_LOCAL_TOKEN_FILE` or
`DELTARELAY_LOCAL_TOKEN` are supported instead of the flag, just as for the
gateway. Never put tokens in URLs or browser-side environment variables. Token
files must be private (`chmod 600`). Run from the repository root or pass an
absolute `--assets` directory. `--listen 127.0.0.1:8791` changes the dashboard
port, independently of the gateway.

The plugin forwards the hook's opaque `sessionID` and request kind in local-only
`X-DeltaRelay-*` headers. The gateway strips those headers before dispatching
anything to the VPS/provider; no request body is parsed or rewritten. Existing
clients using a valid `X-Opencode-Session` header are also recognized. Requests
without a valid session ID are grouped as **Unattributed requests**, not assigned
invented sessions. Only allowlisted requests with valid request IDs enter this
history; authentication failures and invalid/disallowed targets do not.

## Privacy, retention, and state

For statistics, the browser requests `GET /api/dashboard`. The Go dashboard authenticates
its own `GET /v1/dashboard` to the local gateway; it does not forward browser
headers, cookies, arbitrary routes, or query parameters. Statistics remain
metadata-only: gateway and VPS tokens, provider credentials, target URLs, and
response bodies are not included. The dashboard makes no model requests and has
no cancellation, ACK, or replay controls. Its separate `/api/system` metadata and
optional predefined POST service controls are documented in
[SUPERVISION.md](SUPERVISION.md); they never proxy arbitrary routes or expose
provider credentials. Existing gateway authentication and browser-origin rejection remain
intact.

Request evidence capture is **enabled by default** and is a separate tradeoff.
Unless `--capture-dir` is empty, the gateway stores application request bodies
(which can contain prompts, source code, tool output, and other secrets) and
encoded RPC payloads on private local disk. The loopback dashboard then
serves those captures through its authenticated, route-validated inspection
proxy. The browser never receives the local token. That proxy accepts only
bounded capture routes and endpoint-specific query parameters; unknown
parameters and arbitrary paths are rejected. Do not keep capture enabled on a
shared or untrusted machine. Provider response bodies are still never captured.
The routing target (`X-DeltaRelay-Target`) and
credential-bearing forwarding headers are omitted from the retained dispatch
projection, which is replaced by an allowlisted redacted representation. The
request's `Content-Type` is retained only as a label. Known captured protocol
payloads (manifests, inventories, assemblies, and raw chunk batches) contain chunk
hashes, sizes, and the uploaded chunk bytes. Unknown future counted operations
retain only lengths and outcomes, never their payloads. Captured request bodies are stored
as-is and may themselves contain URLs, credentials, prompts, or source code.

Both listeners are loopback-only. The dashboard rejects non-loopback Host values,
cross-origin/cross-site requests and unapproved writes, and sends restrictive CSP/frame
headers with no permissive CORS. This is a **single-user local tool**, not a
multi-user login service: another process/user on the same machine can read its
local dashboard port. Do not publish it through a public proxy or public port
forward. Session IDs, timing, and provider names are still private metadata.

History uses a mode-600, atomic JSON snapshot with a single-writer file lock:

- Up to **256 sessions** and **1,000 request entries**. The least-recently-active
  idle session is evicted first; active requests/sessions are not evicted.
  Request entries for an evicted session are trimmed too. Global totals are
  preserved and trimming counters are shown in measurement notes.
- Separately from request entries, traffic aggregates keep **hourly buckets for
  31 days** and **daily buckets for 91 days**. The traffic chart uses these
  aggregates, so 24-hour, 7-day, 30-day, 90-day, and custom ranges survive
  request-entry trimming. History from before the gateway upgrade is not
  reconstructed beyond the retained request entries.
- A session that returns after eviction starts new retained totals. Session
  totals and request lists cover retained entries only; the traffic chart uses
  its own aggregates and can cover a longer window than the request list.
- Statistics start when the new gateway first runs. Existing logs, old sessions,
  standalone `sync` calls, and activity bypassing this gateway are not imported.
  A history file written before separate cancellation counters cannot distinguish
  old cancellations from failures; new observations use the separate counters.
- Byte totals appear after a request finishes; active requests still show their
  IDs, kinds, upstreams, and elapsed time. They are local gateway states, not a
  list of all saved VPS jobs or OpenCode's current agent/tool states.
- After restart, locally running entries become **interrupted**. That does not
  assert that the VPS job stopped. Use the request-recovery CLI before sending
  a potentially duplicate paid generation.
- Runtime history-write failures are reported without breaking provider calls.
  Such new statistics may not survive a restart. Invalid, unsafe, or incompatible
  history files fail gateway startup rather than being overwritten silently.
- History persistence runs on one background worker, at most about once per
  second, so disk latency never delays provider forwarding. In-memory totals and
  recent requests update synchronously. An abrupt crash can lose roughly the
  last second of retained statistics; provider responses and dispatch claims are
  separate durable data and are not affected.
- A failed write is retried on the next interval with the newest snapshot and
  sets the visible `persistence_error` status. Gateway shutdown performs one
  final flush, waiting at most five seconds, and then releases the single-writer
  lock.
- One gateway owns each statistics file. Keep different deployments' histories
  separate. Back up/rename an existing history while its gateway is stopped if
  intentionally starting a new history; do not edit it while the gateway runs.
- Captured evidence has its own retention, independent of the statistics file.
  Defaults are **100 request captures**, **512 MiB total**, **64 MiB per request
  including its evidence index**, and **24 hours**; all are configurable. The directory and files are private
  (`0700`/`0600`), symlinks are refused, one gateway owns the directory, and
  unexpected entries or malformed capture metadata fail startup rather than being
  adopted or overwritten. Use a dedicated directory.
  Running captures expose their current in-memory evidence and are checkpointed
  about once per second. After an abrupt crash, only checkpointed evidence is
  shown and the capture is marked interrupted; bytes written after the last
  checkpoint are not silently claimed. A normal shutdown flushes before releasing
  the directory lock.
- Capture writes happen on the request path, so capture can reduce
  throughput on a slow disk. Capture failure never changes the transferred source
  bytes: the real transfer continues, retained evidence may be a contiguous
  labeled prefix, the UI labels storage errors/truncation, and an incomplete body
  is not presented as complete.

`.runtime/`, `web/dist/`, `.astro/`, `node_modules/`, and test output are ignored
by Git. CSV exports contain session metadata; store them privately too.

## How savings are measured

```text
saved bytes       = original body bytes − encoded request-body bytes sent
upload reduction  = 100 × (1 − encoded bytes / original body bytes)
cache reuse       = 100 × reused body bytes / original body bytes
```

Encoded uploads include manifest/control bodies, framing, compression, and retry
attempts counted by the Go transport. They exclude response/download traffic,
HTTP headers, TLS/TCP/IP overhead, and retransmissions. They are not packet-level
counters. A failed call can have partial progress, and small calls or retries can
have **negative savings**. Zero original bytes produces an unavailable percentage,
not a fabricated 100%. Failed and cancelled attempts are included in totals and
reported as separate counters.

This is a comparison with uncompressed original bodies, **not** a measured direct
provider-upload baseline. Cache reuse is inventory-time content reuse, not
provider token/KV-cache reuse. Neither metric promises a provider-billing discount.
The traffic chart aggregates these values into hourly and daily buckets. In
composition view, each bar is original body bytes split into uploaded bytes,
relay cache reuse, and other savings; negative savings appear as a red overshoot.
Trend view plots original, uploaded, saved, and reused bytes separately.

The separate **Measurement** page (`/measurement`) applies these definitions to a
session selected from retained history. Its summary and ledger use the same
snapshot; the optional evidence inspector loads captured artifacts on demand
through validated read-only routes. Neither view sends a model request. The
session summary shows original bytes, encoded uploads, saved bytes, reduction,
and relay content reuse. The request ledger expands each retained
request into chunks, unique chunks, uploaded chunks, missing and reused bytes,
actual HTTP attempts, encoded bytes, and response bytes. Uploaded-chunk counters
follow logical batches; after an ambiguous failure and recovery inventory, use
the attempt evidence to distinguish listed chunks from retransmitted frames. Running requests show
pending transfer totals instead of fabricated zeros; failed, cancelled, and
interrupted requests keep their measured partial values. If request entries were trimmed from
bounded history, the page states how many retained entries the ledger covers and
does not imply the visible requests reconcile to the session totals.

### Request evidence capture

Capture is enabled by default with a private directory:

```sh
./bin/deltarelay gateway \
  --server https://relay.example \
  --token-file /path/to/private/relay.token \
  --local-token-file /path/to/private/local.token \
  --upstreams /path/to/private/upstreams.json \
  --stats-file .runtime/dashboard-stats.json
```

The default directory is `.runtime/dashboard-captures`.
`DELTARELAY_CAPTURE_DIR` can supply a different directory instead. An empty
`--capture-dir` disables capture. The optional limits are
`--capture-max-bytes` (default 536870912, including metadata),
`--capture-max-request-bytes` (default 67108864, including metadata),
`--capture-max-requests` (default 100), and
`--capture-max-age` (default 24h). They are validated at gateway startup.
Capture applies only to future requests. The dashboard displays the active
limits, retained-capture count, used bytes, and any storage/admission error. A
supervisor-generated gateway command uses a private capture directory inside its
profile; restart the gateway after changing capture settings. The dashboard does
not enable or disable capture by itself.

The inspector separates evidence by meaning:

| View | Actual source | Important limit |
| --- | --- | --- |
| Original body | Bytes read by the chunker, after gateway `Content-Encoding: gzip` decoding, before chunking | Not the raw incoming HTTP request; headers are excluded; incomplete means EOF was not reached |
| Relay inventory | The relay's validated response at that inventory time | Hash-based chunk availability, not a textual diff; a missing chunk does not prove every byte is new |
| Raw chunks uploaded | Unique chunks selected for upload batches, with frame offsets | Not every repeated body occurrence is uploaded |
| Encoded upload | Each counted HTTP attempt: known protocol payloads, redacted dispatch, or a length-only record for an unknown future operation | `Consumed` is Go transport consumption, not packet capture or proof of receipt; status/polling is excluded; attempt HTTP statuses are relay RPC statuses, not provider status |
| Saved / extra upload | Arithmetic over the recorded transfer counters | Responses, HTTP headers, TLS/TCP/IP overhead, and retransmissions are excluded |

The body hash and source length are checked against the transfer counters when
both are available. Captured transfer counters are checked against the retained
request ledger. Attempt consumption is checked against
`request_body_bytes_sent`, and the inspector explicitly says when the retained
evidence does not reconcile. A lost upload acknowledgment is shown as a failed
or ambiguous attempt; it is not rewritten as success by a later inventory. A
validated chunk acknowledgment means the client received HTTP 200 with the
expected chunk count and raw length; it is not an independent audit that the
relay persisted every frame.
Recovery inventories have their own byte scope, so chunks outside that scope are
marked **unknown**, not present or missing. The inventory view reports
present/missing/unknown **manifest-occurrence bytes** separately from unique
missing chunk bytes; repeated missing hashes make those two counts differ. For a
completed request, the initial inventory's present and unique-missing totals are
cross-checked against the transfer's reused and missing-byte counters, with any
disagreement shown explicitly. JSON formatting validates the complete
artifact and re-indents its original tokens; it is not a reserialized substitute,
and duplicate keys or large numeric literals are preserved. A representation
that is not valid UTF-8 JSON is rejected from the JSON view; use text/hex.

The saved **original body** comparison is against decoded request bodies.
`request_body_bytes_sent` includes manifests, framing, compression when chosen,
and counted retries. It excludes responses and HTTP/TLS/packet overhead. It is
not a provider-token-cache measurement or a billing guarantee.

## Development

Keep the credential-bearing API in Go while Astro serves hot-reloaded assets:

```sh
# Terminal 1: requires the configured/running local gateway
./bin/deltarelay dashboard --assets '' --local-token-file /path/to/private/local.token

# Terminal 2
pnpm dev
```

Visit **http://127.0.0.1:4321**. Vite proxies only `/api/dashboard` to the local
Go listener on port 8790; `/api/system` is proxied separately for local controls.
The browser still receives no gateway token. Bind the
development server to loopback and do not expose it as a production service.

```sh
go test -race ./...
go vet ./...
node --test integration/opencode/*.test.mjs
pnpm check
pnpm test
pnpm test:browser
pnpm build
```

The tests cover session grouping, concurrency, savings, streaming active state,
failure accounting, bounded retention, restart interruption, private persistence,
file locking, write failures, authentication, credential/header isolation,
read-only routes, origin/Host checks, redirects, and frontend measurement logic.
The browser smoke tests render the built static pages into a lightweight DOM with
mocked same-origin APIs; they cover loading, successful and stale refreshes,
filtering/pagination, session details, the standalone measurement page and its
session/request traces, CSV export, independent supervisor controls, and duplicate
Desktop-launch prevention without starting any real service or Desktop process.
