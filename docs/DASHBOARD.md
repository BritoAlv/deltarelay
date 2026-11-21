# Local web dashboard

DeltaRelay's dashboard is an optional Astro application written in TypeScript,
built with pnpm. It is static HTML/CSS plus a small browser script, served by the
Go binary. There is no Node production server, UI framework, charting package,
database, CDN, remote font, or paid health probe.

## Remembered preferences

Viewing choices are saved automatically in this browser's `localStorage` and
restored on subsequent visits, including after closing the browser:

- Theme; Overview time range, custom bounds, date-entry mode, and chart view.
- Shared host selection on Sessions and Measurement (Overview remains all hosts).
- Session search, status/column filters, sort order, and rows per page.
- Usage time range. Usage columns in the sessions table use the same selected
  range. A session dialog is a URL-addressable record link but is not reopened
  by a bare visit.
- Measurement session-browser search, day, availability filter, and sort order.
- Component-table search, column filters, and sort order.
- System controls tab, architecture flow-channel visibility, payload presentation
  mode per inspection stage, and payload-viewer line wrapping.
- System health provider tab.

Explicit URL parameters take priority over the saved settings for that view.
Range parameters are restored together, never mixed with saved bounds.
Session/request links do not inherit saved filters that could hide their target.
Relative ranges such as **Last 24 hours** advance with the latest snapshot;
custom date/timestamp ranges remain fixed. Only successfully applied ranges are
saved.

Open dialogs, pagination, selected records, paused refresh, unfinished form
inputs, credentials, and captured payloads are not saved as preferences.
Automatic recovery and wake settings remain backend-controlled. Preferences do
not sync across browsers/devices and are lost when site data is cleared; private
browsing or blocked/full storage may prevent persistence without breaking the
dashboard.

## What you can see

For a new deployment, run `./startup.sh --no-frontend` (or its alias
`--no-desktop`) and use **System controls →
Set up remote host**. The dashboard can install/configure the relay on an existing
SSH host or Codespace after confirmation; see [remote setup](REMOTE_SETUP.md).

For the live component map, automatic network recovery, per-component
Start/Recover/Restart actions, VPS wake/stop, system shutdown, and the ChatGPT
access-token expiry countdown, see **[Supervision and controls](SUPERVISION.md)**.
Those APIs are independent of gateway statistics and remain available when the
gateway is down. Controls are disabled unless the dashboard is explicitly
connected to a private supervisor. The map reflects the whole system; it does not
infer a working connection merely because two processes are running.

- **System controls** has **Controls**, **Architecture** (read-only), and
  **Settings** tabs. It shows the request paths Desktop/TUI → OpenCode server →
  plugin → gateway → transport → relay → provider, the supervised frontends
  OpenChamber and VS Code/Varro → shared frontend health gate → the same shared
  OpenCode server, plus the separate dashboard/supervisor control plane. The
  component table shows type, description, status, lifecycle, location and
  configured actions, with search and per-column filters like Sessions. Its
  twelve rows cover the eight configured-component inventory entries plus the
  editor, remote host, supervisor and adapter context. On narrow screens it
  scrolls horizontally with component names pinned, rather than stacking each
  item. The read-only map has 18 topology nodes and 27 connections and highlights
  arrows when you select a node. The remote host appears as the host boundary's
  heading, with the configured environment name (for example **GitHub
  Codespaces**) beneath it, instead of a separate card: a host is context, not
  a process. On the remote host, the relay owns separate request
  chunk-cache and durable response-mailbox files. Both have labeled **Write** and
  **Read** arrows: cache transfers follow the request toggle, mailbox transfers
  follow the response toggle, and hiding management does not hide either pair.
  These fixed architecture paths remain visible with older or unavailable
  supervisor topology, without claiming live storage health. The mailbox's read
  lane returns data to the relay for the PC to fetch/resume by byte offset; the PC
  never accesses the mailbox directly. Streaming alone does not delete saved
  responses; explicit ACK or retention expiry does. The current automatic
  recovery step is highlighted in the Controls view.
- Global and per-session original bytes, encoded uploads, bandwidth saved, and
  upload reduction, including failed, cancelled, and legacy attempts, plus
  negative savings. Failures and cancellations are counted separately; a client
  that closes after the terminal stream event is reconciled against the relay
  and recorded as completed when the full response was delivered. Requests
  recorded before final-state reconciliation are kept in a separate **legacy**
  bucket because their outcome is unknown.
- A **System states** area on Overview shows observed time in connected,
  recovering, unreachable, host stopped (system down), no internet, intentionally
  stopped, off (the tool was not running), and unknown states for the selected
  time range. The local supervisor records transitions and periodic heartbeats
  even while no browser is open. **State lanes** show exact state periods;
  **Composition** shows the same period as a ring and sorted totals. Both use the
  selected Overview range, and the area shows the current state plus coverage.
  A gap with no supervisor heartbeat is labeled **Off** instead of pretending the
  previous state continued. Time before the history began is left unobserved, not
  invented.
- A **Host** selector in the page header filters the overview totals, traffic
  chart, session table, and measurement browser by the remote host that carried
  the requests. “All hosts” merges retained session rows with the same OpenCode
  session ID while keeping each host's measurements available when selected.
  The selection is deep-linkable with `?host=<profile>`.
- One **Time range** control above the Overview cards scopes upload reduction,
  bandwidth saved, tracked sessions, model requests, upload traffic, cache
  reuse, state lanes, and the composition ring together. It defaults to **Last
  30 days**, with 24-hour, 7-day, and
  90-day presets, any custom number of **seconds, minutes, hours, or days**, or
  an absolute date range. Relative windows use exact boundaries against the
  latest snapshot (automatic refresh remains every ten seconds; pause freezes
  the snapshot).
  **Custom range → Date picker** retains whole-day selection. **Paste timestamps**
  accepts ISO 8601 with `Z` or a numeric timezone offset,
  `YYYY-MM-DD HH:mm[:ss]` in the displayed browser timezone, ten-digit Unix
  seconds, and thirteen-digit Unix milliseconds. A preview shows the interpreted
  timestamps before Apply. Exact ranges include the start and exclude the end;
  future end times stop at the latest snapshot. Invalid input leaves the last
  applied range intact. Both range and chart view are restored from the URL.
  Composition and trend views plot
  bandwidth saved and relay cache reuse with a legend, range summary, tooltips,
  and responsive axes. Cache reuse versus raw uploaded chunks remains visible
  beside the chart.
- Relative and pasted timestamp windows use finished request records, rather
  than including an entire hourly bucket for a seconds- or minutes-long range.
  The cards and chart share the same finished-request byte totals. Model requests
  additionally includes requests running now that started in the selected live
  window; their bytes are pending and are excluded from the chart. Tracked
  sessions counts distinct session IDs observed in that period across hosts,
  including those running requests, not the lifetime totals of overlapping
  sessions. Historical ranges do not claim to reconstruct past running states.
  Older imported histories that discarded request records show coverage warnings
  and label session counts as retained records only; missing timestamps are not
  inferred from aggregates. Legacy lifetime outcome warnings remain separate
  from period totals because older aggregate outcomes were not reconciled.
- **Overview → Model usage** plots the selected range as a locally observed
  token trend stacked by model. **Total / Input / Output** switches the
  measure, and legend buttons hide or show a model without repainting the
  survivors. The five largest models by observed tokens remain separate; the
  tail folds into **Other models**. Requests without token measurements are
  hatched gaps, never zero, and the tooltip reports coverage per bucket.
  Model colors are theme tokens assigned once per model and kept while the
  legend or range changes within the page.
- **Sessions** keeps one table with the original transfer columns and adds
  locally observed usage columns: saved credential label, input/output tokens,
  and latest context. A time range above the table scopes those usage columns
  and the usage summary. Selecting a session opens one
  inspector with both transfer accounting and model usage, including coverage, a
  context chart, per-request credential label/model/tokens, and a full numeric
  breakdown. Session CSV and matching-request CSV/JSON exports use the same
  filters.
- Active requests, upstream, request kind (primary/title/compaction/generate),
  status, duration, and safe error codes in the same session inspector.
- A separate **Measurement** page traces any gateway-measured session with the
  same read-only snapshot. Its session browser can also list the sessions stored by
  the local OpenCode service, with titles, start dates, projects, agents, and
  models. Only sessions with retained gateway measurements are selectable;
  sessions stored only by OpenCode are marked **No gateway data**. The browser
  supports title/ID/project/model search, day filtering, host filtering, and
  pagination. The page
  shows the measured body-to-wire process, a direct original-versus-encoded
  comparison, and a per-request list with cache reuse, raw chunk uploads,
  encoded bytes, HTTP attempts, and response bytes that are excluded from upload
  savings. Selecting a request updates the body-to-wire stages; expanding it
  shows the full accounting and captured-evidence entry point.
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
  **Provider details → opencode-go** also discovers every saved OpenCode Go or
  Console API key from the local OpenCode service, including inactive keys, and
  checks each key's 5-hour, weekly, and monthly allowance using OpenCode's
  read-only usage endpoint. Results are cached for 30 seconds and refreshed in
  the background. **Choose account** shows one key's usage at a time, defaulting
  to the active key. A filled **Active key** badge identifies the actual OpenCode
  selection, including while viewing a saved key. Choosing a view does not change
  the active key. Each key has its own label and failure state; a failed refresh
  retains only that key's last observation as stale.
  Keys sharing an allowance may show the same percentages; they are not summed.
  Keys, credential IDs, and workspace metadata stay server-side. Without saved
  keys, the Console sign-in's usage remains available as a fallback.
- Session search, per-column filters, pagination with adjustable rows per page
  (8, 25, 50, or 100), CSV export, manual refresh, and pause/resume. Each
  sortable sessions column has its own filter button:
  option lists for the remote host, state, and saved credential label,
  minimum/maximum bounds for requests, transfer sizes, reduction, and observed
  input/output/context tokens, and a from/to date range for last activity. The
  State filter carries the active, idle, and needs-attention choices; there are
  no duplicate state chips in the toolbar. The credential-label list includes
  every saved credential known to the local gateway; its counts cover the usage
  scope selected above the table, so credentials outside that scope can match no
  session. Column filters combine with the search text, and invalid bounds are
  explained in the popover instead of being applied silently.
  Automatic refresh is every ten seconds while the tab is visible. A failed
  refresh keeps the last live snapshot and explicitly marks it stale.
- First loads and failed loads are distinct from a genuinely empty history.
  While the gateway diagnostics or supervisor request is in flight, cards and
  tables show an animated loading state. If the first request fails before any
  snapshot exists, they report unavailable and retry automatically. Wording such
  as “No sessions recorded” appears only after a successful snapshot confirms
  there is no retained data.
- Deep-linkable view state: the selected host, chart range and view, session
  search/state/column filters/page/page size, an open session detail, and the
  measurement session/request plus session-browser search, day, availability,
  and page are kept in the URL and restored on reload. Column filters use `sid`,
  `key_id`, `req_min`, `req_max`, `orig_min`, `orig_max`, `up_min`, `up_max`,
  `red_min`, `red_max`, `in_min`, `in_max`, `out_min`, `out_max`, `ctx_min`,
  `ctx_max`, `act_from`, and `act_to` in addition to the existing `q`, `state`,
  and `rows`.
  Changes use `replaceState`, so filtering does not fill the browser history.
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

With a current executable-provider configuration, run
`./startup.sh --config /private/supervisor.json` to start/reuse the dashboard
before background recovery, including with `--no-frontend` (or its alias
`--no-desktop`). The configuration
selects the gateway, token file, and dashboard address. Missing/stale builds use
Go and the offline pnpm cache. Use `--no-dashboard` to skip a new dashboard
launch. Existing services are not automatically replaced to apply upgrades.
See [SUPERVISION.md](SUPERVISION.md) for configuration and logs.

First follow [SETUP.md](SETUP.md) to configure the relay, tunnel, local gateway,
and OpenCode plugin. Rebuild and restart an older **Go gateway** for the new
diagnostic endpoint. No routing configuration is changed automatically.

The gateway collects private session metadata by default. Sessions, request
entries, and traffic aggregates are never discarded. Captured evidence is also
kept indefinitely unless an operator explicitly configures capture limits:

```sh
./bin/deltarelay gateway \
  --server http://127.0.0.1:8787 \
  --token-file /path/to/private/relay.token \
  --local-token-file /path/to/private/local.token \
  --upstreams /path/to/private/upstreams.json \
  --stats-file .runtime/dashboard-stats.json \
  --opencode-service-file /path/to/private/opencode/service.json
```

`--opencode-service-file` is optional. When present, the gateway reads the local
OpenCode service's saved credential labels and OAuth access tokens so requests
can be grouped by label without reading provider-side key IDs. The supervisor
adds it from `opencode_service_file` automatically. Use your
existing gateway flags, upload budgets, and recovery configuration; do
not start another gateway on the same port. `--stats-file` selects the history
location and `--history-host` labels observations with the active remote host
(the supervisor sets it automatically for profiles). `DELTARELAY_STATS_FILE` and
`DELTARELAY_HISTORY_HOST` can also set them. `--stats-file ''` keeps history in
memory only. Statistics are collected even with `--quiet`, which only suppresses
metadata logs.

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

For statistics, the browser requests `GET /api/dashboard?compact=1`. Overview
adds epoch-millisecond `start`, `end`, and `bucket` parameters for a server-side
summary of the selected range (at most 200 points), plus the selected `host`,
the range-resolution clock `now`, and `exact=1` for relative/pasted timestamp
ranges. Calendar presets preserve hourly/daily aggregate accounting, including
legacy totals whose individual request timestamps are unavailable. Compact
responses include session/lifetime totals but no request entries or historical
traffic bucket arrays.

Session details and Measurement fetch only the current request page from
`GET /api/dashboard/requests?session=…&limit=8`, with optional `host` and an
exclusive `before` sequence cursor. Pages are newest-first, limited to 100
entries, and include the matching retained count and next cursor. New requests
do not shift an older page's cursor. **Newer requests** and **Older requests**
provide access to the entire retained history without accumulating its rows
in browser memory. Loading failures offer Retry and never imply history was
deleted. Session summaries continue to use lifetime totals, not page totals.

These are read projections only: no history is deleted, capped, rewritten,
or aged out by a query. The original full `GET /api/dashboard` remains available
for compatible diagnostic clients. Charts skip unchanged data, and timestamp
formatters are reused across redraws.

The Go dashboard authenticates its own `GET /dashboard` or
`GET /dashboard/requests` to the local gateway; it forwards only the documented
query allowlist, never browser headers, cookies, or arbitrary routes. Statistics remain
metadata-only: gateway and VPS tokens, provider credentials, target URLs, and
response bodies are not included. The dashboard makes no model requests and has
no cancellation, ACK, or replay controls. Its separate `/api/system` metadata and
optional predefined POST service controls are documented in
[SUPERVISION.md](SUPERVISION.md); they never proxy arbitrary routes or expose
provider credentials. The supervisor still records a bounded private journal at
`<profile>/control/activity.jsonl` for offline support, and the read-only
`GET /api/system/journal` endpoint remains cursor-only. The browser does not
render that journal; System controls uses structured topology and recovery-run
data instead. Existing gateway authentication and browser-origin rejection remain
intact.

The browser reads usage through `GET /api/dashboard/usage` for the selected
range and optional key, and `<key>&start=<ms>&end=<ms>` on
`GET /api/dashboard/requests` for scoped request pages. The Overview chart adds
`bucket=<ms>` to `/api/dashboard/usage` for its model-stacked series. Exports use
`GET /api/dashboard/usage/export?format=csv|json`. The dashboard proxy forwards
only `session`, `host`, `key`, `start`, `end`, `bucket`, `before`, `limit`, and
`format` to those read routes. Usage totals always use the local request start
time; start is inclusive and end is exclusive. Session lifetime/task totals
remain separate.

Usage metadata is collected on this computer only. No usage measurement,
credential label, or derived aggregate is added to the relay protocol, VPS
state, provider request, or model response. The gateway reads the local request
it already forwards and the response bytes it already downloads; it does not
buffer response delivery, request model usage, or make a provider call for
metrics. The saved-credential matcher hashes each saved API-key secret or OAuth
access token in memory and stores no fingerprint in retained history. Retained
names are the sanitized labels from OpenCode and an opaque local reference
derived from the saved record. That reference is used only to filter and
disambiguate duplicate labels; it is not a provider key ID. If a secret is not
saved, or if multiple saved records contain the same secret, the request is
**Unknown credential** rather than guessed from the currently selected account.

Token counters are only recorded when the provider's response actually contains
them and this computer reads that response through its terminal usage event. A
client that stops receiving before that point can leave a request **Partial** or
**Unavailable**; there is no remote backfill. Numbers may differ by provider:
OpenAI-style cached input and reasoning tokens can be subsets of the
input/output totals, while Anthropic cache read/write sources are added to the
displayed input context. Missing counters remain
**Unavailable**, never zero; partial streams remain **Partial**. These counters
are provider diagnostics, not an invoice: providers define cache, reasoning, and
audio subsets differently, and the relay does not convert them to money. Input
totals sum the context sent with every request, so repeated history counts again;
**latest/peak context** is the measured per-request input context, not unique
conversation content. Token counters from requests that predate usage tracking
remain unknown; saved-credential attribution can be backfilled once as described
below.
The Overview card shows the selected-range aggregate with token coverage,
a model-stacked trend, and explicitly identifies it as locally observed.
The chart's **Other models** bucket only folds models beyond the five largest;
it never invents attribution for unmeasured requests.

With `--opencode-service-file` configured, the measurement page also requests
`GET /api/opencode/sessions`. The Go dashboard reads only session metadata from
the local OpenCode V2 service: opaque ID, title, start/update times, directory
basename, agent, and model. That OpenCode metadata path never reads messages,
conversation content, provider credentials, cost, token counts, permissions, or
full filesystem paths; token/context usage is the separate local gateway path
described above. It never sends titles to the gateway, relay, or a provider.
OpenCode session
titles are local-only metadata and are visible to any local process/user that can
reach the loopback dashboard. If the service is not configured or unavailable,
the browser falls back to gateway-retained sessions and opaque IDs.

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
forward. Session IDs, OpenCode titles, timing, project labels, and provider names
are still private local metadata.

History uses a mode-600, atomic JSON snapshot with a single-writer file lock:

- One shared history file accumulates every host profile. Each session, request,
  and traffic bucket is labelled with the host that carried it (`--history-host`,
  set by the supervisor for the active profile), so switching hosts does not
  reset the dashboard. Per-host totals are preserved independently. The header
  host filter scopes the sessions page and the measurement browser; the overview
  is always an all-hosts view. On an upgrade from the older per-host layout, the
  supervisor imports the existing files once and leaves `merged-*` backups in the
  old profile directories.
- Every gateway session, request entry, and traffic bucket is retained. There is
  no session count, request count, age window, or statistics-file size limit to
  evict or trim observations. `session_limit` and `request_limit` report `0`
  (unlimited), and hourly/daily `retention_seconds` report `0` (unlimited).
  Counters such as `evicted_sessions` and `dropped_requests` remain in the wire
  format to describe history imported from older bounded deployments.
- Statistics start when the gateway first runs. Existing raw logs, standalone
  `sync` calls, and activity bypassing this gateway are not imported. The one
  upgrade from the earlier per-host layout does import the gateway's own
  per-host statistics and capture files into the shared history; unreadable or
  malformed files fail the start instead of being discarded. A history file
  written before separate cancellation counters cannot distinguish old
  cancellations from failures. On first load, the gateway moves whole sessions
  that are entirely failed and end at `499 request_cancelled` into the separate
  **legacy** outcome. Their final state is unknown, so they are not counted as
  failures or cancellations; mixed legacy sessions keep their failure count.
  This normalization is one-time, idempotent, and does not rewrite traffic
  aggregates. The overview note shows the legacy count and separates failures
  on the active host from failures on historical hosts.
- Supervisor state history is also retained indefinitely: `state-history.jsonl`
  has no age, record-count, or file-size limit. A legacy `.1` backup from earlier
  bounded versions is still read.
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
- Captured evidence is independent of the statistics file. By default it is
  kept indefinitely: capture count, total bytes, per-request bytes, and age are
  unlimited. Operators can still opt into bounds with
  `--capture-max-requests`, `--capture-max-bytes`,
  `--capture-max-request-bytes`, and `--capture-max-age`; `0` means unlimited.
  The directory and files are private (`0700`/`0600`), symlinks are refused, one
  gateway owns the directory, and unexpected entries or malformed capture
  metadata fail startup rather than being adopted or overwritten. Use a
  dedicated directory.
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

### Saved credential usage and context

Usage recording is deliberately separate from provider billing and from the
relay's upload-savings counters:

| Measurement | Meaning |
| --- | --- |
| Requests observed | Matching requests by local start time; running requests remain included in the count and are marked pending in the ledger |
| Sessions | Distinct nonempty session IDs with matching requests; requests without a session ID are reported separately |
| Input tokens | Sum of provider-reported input/context counters; includes cache read/write where the provider reports them as additional input |
| Output tokens | Provider-reported generated tokens; reasoning tokens remain a separate diagnostic subset |
| Latest context | Input tokens of the newest matching request with a reported input counter |
| Peak context | Largest single-request input context in the matching scope |
| Coverage | Requests with any token counter, and requests with a complete terminal usage report |
| Provider cache | Cache-read/write counters as reported by the provider, never inferred from DeltaRelay byte-cache reuse |

Per-request metadata also keeps the requested and response model, finish reason,
message/tool counts, output-token limit, first local response time, status,
timing, transfer accounting, and the measurement source/reason. Export file names
are fixed, and formula-prefixed text fields are escaped for spreadsheets. The
CSV/JSON exports contain
numeric metrics and local metadata, not prompts, model bodies, credentials, or key
fingerprints. Re-importing an export is not an accounting reconciliation and does
not count as a provider generation. A failed export or observation never changes a
completed transfer.

The Credential label column filter on Sessions offers every saved OpenCode label,
including a credential that has not yet observed a request. The label is the
human-facing name. The gateway also keeps an opaque local reference derived from
the OpenCode saved-record ID; that reference is the `key_id` session-filter
value and is shown as a short suffix only when two labels are identical. It is not a provider
key ID and never contains a secret. For retained requests that predate
saved-credential matching, the gateway performs one conservative historical
attribution at startup: unattributed requests are assigned per gateway upstream
when exactly one unobserved saved credential maps to that upstream. OpenCode Go
keys map to the `opencode` upstream, and saved OpenAI OAuth credentials map to
the `openai` upstream. If multiple credentials are candidates for one upstream,
that history remains **Unknown credential** rather than guessed. A final fallback
applies only when exactly one unobserved credential and one unattributed upstream
remain. This rule is only for existing history. New requests with an unregistered
credential remain **Unknown credential**.

The sessions table's usage columns and the Overview card use the same local
history. The transfer columns keep their original lifetime session totals and
bandwidth semantics. Filtering usage or opening a session does not change the
active OpenCode key, contact the OpenCode service, or send a model request.

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
Trend view plots original, uploaded, saved, and reused bytes separately. Solid
segments cover buckets with finished requests; dashed, dimmed connectors span
periods with no traffic so gaps are not mistaken for zero usage.

The separate **Measurement** page (`/measurement`) applies these definitions to a
session selected from retained gateway history. The session browser can list the
broader local OpenCode session catalog, but only gateway-measured sessions are
traceable; unmeasured sessions never fabricate a summary. Its summary and request
list use compact session totals and independently paged request metadata; the optional evidence inspector loads captured artifacts
on demand through validated read-only routes. Neither view sends a model request. The
session summary shows original bytes, encoded uploads, saved bytes, reduction,
and relay content reuse. The request list is the single request selector:
selecting a row updates the body-to-wire stages and evidence inspector, and
expanding it shows chunks, unique chunks, uploaded chunks, missing and reused
bytes, actual HTTP attempts, encoded bytes, and response bytes. Uploaded-chunk counters
follow logical batches; after an ambiguous failure and recovery inventory, use
the attempt evidence to distinguish listed chunks from retransmitted frames. Running requests show
pending transfer totals instead of fabricated zeros; failed, cancelled, and
interrupted requests keep their measured partial values. If request entries
predate unlimited history, the page states how many retained entries the list
covers and does not imply the visible requests reconcile to the session totals.

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
`--capture-max-bytes`, `--capture-max-request-bytes`,
`--capture-max-requests`, and `--capture-max-age`. Each defaults to `0`
(unlimited). Positive values restore explicit bounds. They are validated at
gateway startup.
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
request list. Attempt consumption is checked against
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

Visit **http://127.0.0.1:4321**. Vite proxies only `/api/dashboard`,
`/api/inspection`, `/api/opencode`, and `/api/system` to the local Go listener on
port 8790.
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
failure accounting, legacy outcome reclassification, unlimited retention, restart
interruption, private persistence, file locking, write failures, authentication,
credential/header isolation, read-only routes, origin/Host checks, redirects, and
frontend measurement logic.
The browser smoke tests render the built static pages into a lightweight DOM with
mocked same-origin APIs; they cover loading, successful and stale refreshes,
filtering/pagination, session details, the standalone measurement page and its
session/request traces, CSV export, independent supervisor controls, and duplicate
Desktop-launch prevention without starting any real service or Desktop process.
