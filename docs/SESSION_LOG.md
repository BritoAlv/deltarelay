# DeltaRelay — implementation and operations session record

Recorded for the work performed on **2026-10-25–26**. This is a technical and
operational summary, not a transcript. Credentials, prompts, provider response
bodies, authentication databases, pairing links, personal filesystem paths, and
deployment identifiers are deliberately omitted. This records the original
prototype; current setup and protocol behavior are documented in
[SETUP.md](SETUP.md) and [PROTOCOL_V2.md](PROTOCOL_V2.md).

## 1. Outcome and checkout portability

The project can be cloned into any directory. It was developed in one local
checkout, then moved at the user's request; those machine-specific locations are
not needed to build or run it. Every top-level entry was moved, including `.gitignore`, `.runtime`,
source, tests, documentation, deployment assets, integration files, and binaries.
The directories were on the same filesystem, so entries were renamed rather than
copied and deleted. The destination was new: no existing project was merged or
overwritten. The old directory was left empty, without a compatibility symlink.
The active OpenCode conversation was moved to the new working directory using
OpenCode's session-move tool.

The software includes a Go client, an authenticated local gateway, an authenticated
VPS chunk store/forwarder, an OpenCode V2 plugin, automated tests, setup
instructions, and service examples. The original CLI version was `0.2.0`; its
initial wire protocol was version `1`. See the current protocol document for v2.

**Runtime state is not implied by this history.** At migration time, the recorded
local test Desktop, private OpenCode server, gateway, tunnel, and supervisor PIDs
were no longer running. They were not restarted as part of the move. The remote
Codespace relay's current state was not rechecked during relocation. Historical
PIDs and statistics in `.runtime` must not be interpreted as current health.

## 2. User goal and initial investigation

The goal was to keep normal OpenCode Desktop behavior while reducing uploads over
a slow connection:

1. OpenCode assembles the complete model request on the PC as usual.
2. The PC sends only missing/changed content to a VPS.
3. The VPS reconstructs exactly the body OpenCode intended to send.
4. The VPS contacts the actual model provider and streams its response back.
5. Project files, tools, and normal account sign-ins remain on the PC.

The user requested **Go** for the network-heavy components.

### Portway

Reviewed `https://github.com/dalenguyen/portway`, including its conversation-state
example. Its gateway is deliberately stateless; the example assembles history on
the application side and still sends complete requests. Portway did not provide
the PC-to-VPS delta transport needed here, so DeltaRelay was built separately.

### Existing OpenCode WebSocket support

Reviewed OpenCode V2 provider, plugin, configuration, network, troubleshooting,
CLI, and policy documentation. Supported direct OpenAI Responses routes can use
incremental WebSockets, but that does not establish WebSocket support for every
model or the OpenCode Go gateway. Local logs contained repeated WebSocket connect
timeouts and HTTP fallbacks. Those log entries alone did not identify every
affected provider or conversation.

The custom relay therefore uses ordinary HTTP model requests and its own
incremental PC-to-VPS protocol, independent of provider WebSocket availability.

### Important distinction

This caches **network request content**, not the model provider's token/KV state.
It does not guarantee provider cache hits, lower token billing, or reduced
VPS-to-provider payloads. Initial context and genuinely new content still need
uploading. Reconnection can reuse a persistent VPS cache; losing that cache
requires synchronization again, subject to the configured upload budget.

## 3. Core implementation

### Request representation

The relay operates on finished request-body bytes, not conversation events.
Consequently an edit, deletion, fork, compaction, repeated block, or reordered
content needs no independent conversation-management implementation. A manifest
describes the exact current request; old cached content can remain stored without
being included in that request.

- Deterministic content-defined chunk boundaries use a gear fingerprint.
- Default chunk sizes: 4 KiB minimum, 16 KiB target, 64 KiB maximum.
- SHA-256 identifies each chunk and the complete original body.
- Ordered chunk references preserve duplicates and ordering exactly.
- Length and hash validation happen before a reconstructed request is published
  or sent to a provider.
- Binary chunk framing avoids base64 expansion.
- Missing chunks are sent in bounded batches, normally 2 MiB, with four workers.
- Manifests and batches use fastest-level gzip only if it reduces their size.
- Cache RPC concurrency is bounded separately from long-lived inference streams
  so streaming connections do not starve synchronization.

The client uses a private spool rather than buffering a full conversation in
memory. On POSIX systems it unlinks that spool early when possible. Normal VPS
forwarding reconstructs into a verified anonymous temporary file; closing the
descriptor or exiting the process releases it. It does not retain a complete
conversation file after every turn. Diagnostic `sync` deliberately persists a
complete body for `fetch` testing.

### Protocol routes

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Version, forwarding readiness, and cache usage |
| `POST /v1/missing` | Validate manifest and discover missing unique chunks |
| `POST /v1/chunks` | Verify and atomically persist chunk batches |
| `POST /v1/assemble` | Diagnostic complete-body verification/persistence |
| `GET /v1/bodies/{sha256}` | Verified diagnostic export |
| `POST /v1/forward` | Reconstruct, verify, claim request ID, and stream upstream |

All VPS routes require a relay bearer token. Uploaded chunks survive normal
restarts. Corrupt chunks are not reported as cache hits. Partially completed
uploads can leave verified chunks that a later synchronization reuses.

### CLI and source layout

| Path / command | Responsibility |
| --- | --- |
| `cmd/deltarelay/` | `serve`, `gateway`, `doctor`, `gen-token`, `sync`, `fetch`, version/help |
| `internal/chunker/` | Content-defined splitting |
| `internal/protocol/` | Manifests, framing, limits, hashes |
| `internal/store/` | Persistent chunks, quota, verified reconstruction |
| `internal/client/` | Inventory, upload, forwarding, statistics, transport errors |
| `internal/server/` | Authenticated VPS endpoints and provider forwarding |
| `internal/gateway/` | Loopback provider endpoint, diagnostics, metrics |
| `internal/upstream/` | Allowlist, DNS restrictions, header handling, streaming |
| `internal/journal/` | Durable request-ID claims |
| `integration/opencode/` | Small dependency-free JavaScript V2 plugin and tests |
| `configs/upstreams.json` | Initial upstream rules |
| `deploy/` | VPS service, PC gateway service, SSH tunnel example |
| `docs/SETUP.md` | General installation and operating instructions |

The Go application uses the standard library only and targets Go 1.24+. Node is
used for plugin unit tests; OpenCode runs the plugin using its own runtime.

## 4. Streaming, safety, and error behavior

The local gateway accepts native HTTP model requests. Provider headers and
resolved account credentials are carried separately from relay authentication.
Hop-by-hop and internal DeltaRelay headers are stripped before provider dispatch.
Bodies are not translated between Responses, Chat Completions, or Messages APIs.

Both relay hops forward real response data as it arrives, including reasoning
and tool-call events. They do not buffer a full answer, fabricate heartbeat
events, append error JSON to an already-started provider stream, or report a
truncated stream as a successful complete response. Cancellation propagates
through the gateway and VPS to the upstream request.

The VPS accepts only configured HTTPS origins and API path prefixes. Redirects
are refused. It checks the addresses actually dialed and rejects private and
special-use network destinations in production mode. The private-upstream option
is for loopback mock-provider tests, not production. TLS verification was not
disabled, and the setup did not expose public Codespace ports.

Before provider dispatch, the VPS durably claims a random logical request ID.
Reusing an ID is refused, including after a crash or ambiguous connection loss.
There is no automatic replay of inference or direct-provider fallback. This is
conservative replay protection, not a promise of exactly-once inference: a new,
deliberate user retry can still repeat provider work after an ambiguous failure.

Resource defaults include a 256 MiB body limit, 8 MiB manifest limit, 16 MiB
framed-batch limit, 10 GiB persistent cache cap, and 100,000 journal records.
Limits fail closed; there is no automatic eviction or journal expiration. The
Codespace experiment used smaller limits, described below.

Upload budgets check missing **raw** chunk bytes before chunk upload. A zero
budget permits cache hits only; the default unlimited setting permits bootstrap.
Manifest/control traffic still crosses the link when a budget rejects content.

## 5. OpenCode Desktop integration

The plugin follows OpenCode V2's `id` / `setup` lifecycle and native HTTP hooks.
While enabled for selected providers it:

- Forces HTTP and plain request content at provider/model/variant levels.
- Rewrites final inference requests to the local gateway without replacing the
  original provider connection or implementing a second OAuth flow.
- Preserves the original abort signal.
- Covers primary, title, compaction, and generate requests.
- Vetoes automatic retries and forbids native provider WebSocket handshakes.
- Disposes its hooks/transforms when disabled or unloaded.

The ordinary plugin defaults select `openai` and `opencode-go`. The isolated live
test also selected `opencode` and used provider policies to restrict the profile
to those routed providers. Other plugins or higher-authority workspace policy
can affect configuration; health checks alone do not prove a plugin is loaded.

An installed-OpenCode integration test was added. It starts an actual private
OpenCode process with temporary HOME/XDG directories and fake credentials, uses
a mock provider, confirms provider calls traversed the relay, and confirms that
stopping the gateway does not produce direct-provider fallback. It does not use
the user's real authentication database or paid provider credentials.

One verification detail: installed V2 API replies wrapped plugin results in
`{ location, data }`. An initial flat-list interpretation missed the plugin;
reading `data` confirmed `deltarelay` was active. This was an inspection issue,
not a plugin-loading failure.

## 6. Codespace deployment and isolated live test

The user requested testing against an existing GitHub Codespace via `gh` SSH.
Its name and deployment-specific configuration remain private; no particular
Codespace is required by the repository or its default tests.

### Remote side

- Confirmed Linux x86_64 architecture and available disk space.
- Cross-compiled a static Linux amd64 Go binary with `CGO_ENABLED=0`.
- Uploaded only that binary, the upstream allowlist, and the shared relay token.
- Verified the uploaded binary's SHA-256 against the local build before running.
- Deployed under the remote user's private application-data directory.
- Started an unprivileged detached relay bound to `127.0.0.1:18787`.
- Used a 2 GiB cache cap and 10,000 request claims for this experiment.
- Kept remote logs, token, and process metadata in the private deployment folder.

The first `gh codespace cp` attempt encountered a quoted remote-directory problem
with modern SCP/SFTP handling. Repeating the copy with an absolute remote path
and SCP's legacy `-O` mode worked. SSH credentials and host-key settings were not
manually weakened to solve it.

No remote system service or privileged account was installed. The Codespace's
workspace repository, idle policy, and public port settings were not changed.

### Local side

| Component | Configured address/path |
| --- | --- |
| SSH forward | PC `127.0.0.1:18787` → remote `127.0.0.1:18787` |
| Gateway | `127.0.0.1:18788` |
| Isolated OpenCode server | `http://127.0.0.1:49475` |
| Test assets | `.runtime/codespace-test/` |
| Desktop profile | `.runtime/codespace-test/desktop-profile/` |
| OpenCode configuration/data/state/cache | `.runtime/codespace-test/profile/` |
| Test project | `.runtime/codespace-test/project/` |

Created distinct relay and local-gateway tokens using `gen-token`; only the
relay token was copied remotely. Token files were `0600`, and the runtime root
was `0700`. No token value is recorded in this document.

Launched a separate instance of the installed OpenCode Desktop with a separate Electron
profile, XDG paths, database, and server port. Launch helpers strip inherited
server-selector, inline OpenCode configuration, and provider-secret environment
variables before applying the private paths. The existing provider/account
database was not copied. A copy of the already installed CLI executable was used
as a private Desktop binary cache; this was not an account-data copy.

Verified a separate Desktop renderer, a distinct server PID/version (`2.1.4`),
the private server paths, an active DeltaRelay plugin, and HTTP/plain encoding
settings for the selected providers. The original Desktop/server were confirmed
running during that live setup. That observation is historical, not a statement
about their state after later application/server restarts.

### Live observations

`doctor` confirmed gateway/VPS readiness without a provider inference call.
A synthetic body was synchronized through the actual Codespace and exported
again; byte equality and full SHA-256 matched. Afterwards, live model traffic
was observed through the isolated Desktop, with successful provider responses.
Some requests returned HTTP 429; those were upstream rate limits, not hash or
tunnel failures.
The successful live records identified the upstream as `opencode`; this is not
proof that every OpenAI, ChatGPT OAuth, or OpenCode Go account route was exercised.

| Experiment | Observed encoded request-body bytes |
| --- | --- |
| 3 MiB synthetic incompressible body | Cold: 3,165,696; small append: 24,895 |
| Standalone 2 MiB CLI smoke test | Cold: 2,111,274; continuation: 10,580 |
| OpenCode-shaped JSON, about 2.18 MB raw | Cold: 417,318; continuation: about 7,949; full-body gzip baseline: 407,762 |
| Actual Codespace synthetic probe, 133,556-byte body | Cold: 30,310; continuation: 5,199 |
| One observed live request, 672,348-byte body | New raw chunks: 42,864; encoded upload: 22,136 |

These are examples, not universal compression or latency guarantees. Encoded
request-body counters exclude headers, TLS/TCP/IP overhead, responses, and
retransmissions. Comparing raw JSON bytes alone with encoded delta bytes is not
a fair compressed-full-upload baseline. Metadata is still transferred every call.

## 7. VPN interruption and recovery

After the user disconnected a VPN, the SSH tunnel exited. Its log reported:

```text
Timeout, server localhost not responding.
shell closed: exit status 255
```

Verified that the Codespace was still Available, the remote relay was still
running, and the local tunnel port was free. The gateway and private OpenCode
server were still running. The immediate cause was therefore the lost tunnel,
not an upload-budget violation or corrupt cache.

### Recovery changes

1. Re-established the SSH forward without restarting the remote relay.
2. Added private `tunnel-supervisor.sh`, which reconnects with backoff and SSH
   keepalives. It is started in an isolated process session/group.
3. Updated the stop helper to recognize the supervisor instead of the original
   one-shot `gh codespace ssh` command.
4. Added a typed `client.TransportError` and clearer gateway messages:
   - Failure before forwarding: VPS/tunnel unavailable; no provider request sent.
   - Failure during forwarding: the provider may already have received it.
5. Added regression tests for both paths and absence of direct fallback.
6. Rebuilt the client/gateway and restarted only the local gateway after checking
   its process identity. The remote relay did not require redeployment because
   its protocol and server code were unchanged by those diagnostic changes.
7. Confirmed automatic tunnel reconnection and a passing `doctor` check.

The supervisor only restores connectivity; it does not resume or replay the
interrupted generation. After recovery, deliberately resend if needed, bearing
in mind that an already-dispatched request can have incurred provider work.
Desktop normally does not need restarting merely because the tunnel reconnects.

### Reconnect-test mistake and caution

One manual reconnect experiment used an overly broad process-command filter.
The test command itself was interrupted with `Killed by SIGKILL`; the tunnel log
confirmed an SSH exit status of 137 followed by reconnection. The supervisor,
gateway, Desktop, and private server were subsequently checked, and `doctor`
passed after recovery. This did **not** prove that no other process could have
matched the broad filter. Do not repeat that approach or treat the earlier
assurance that nothing else was affected as fully established.

Future stop/reconnect tests should target recorded owned PIDs and verified
process ancestry only. During relocation, the stop helper was additionally
hardened to tolerate missing/stale PIDs and require the expected supervisor path
and isolated process-group leadership before signaling a group.

## 8. Migration details

At the user's request, created a new checkout directory and moved all
12 top-level project entries there. Hidden/private runtime contents were included
and retained their permissions. No directory-wide recursive deletion, Git reset,
checkout, or cleanup of unrelated user files was performed. No Git repository was
initialized and no commit was made.

Updated the active private OpenCode configuration's absolute paths for:

- Plugin package: the new checkout's `integration/opencode/` directory.
- Gateway token: the private profile's `local.token` file.

The runtime shell/Python helpers already derive their root from their own file
location, so their binary/profile/log paths move with the directory. Checked
private service configuration for stale old-root references; none were found.
The remote Codespace deployment path and ports were not changed.

Historical logs, Chromium caches, binary debug information, and stored sessions
were **not** bulk-rewritten. They may still contain the old project path. Existing
test sessions can need their working directory relocated through OpenCode's
supported controls when resumed; do not manually rewrite an account/session
database to do that. The active coding conversation itself was relocated through
OpenCode's session API.

Linked this record from the main README and updated the private runtime README
to distinguish configured setup from currently running processes.

## 9. Verification

The following passed again **from the new project directory**:

```sh
go test -race -count=1 ./...
go vet ./...
node --test integration/opencode/index.test.mjs
DELTARELAY_TEST_OPENCODE=1 go test -race -v ./internal/gateway -run TestInstalledOpenCodePlugin -count=1
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
```

Also checked runtime shell/Python syntax, relocated plugin/token paths, private
runtime/token permissions, and that the original source directory was empty.
The installed-OpenCode test again confirmed two model calls through its mock
relay and no direct fallback when its mock gateway was stopped. It did not start
the user's Codespace or persistent test Desktop.

Earlier validation also included short fuzz runs for chunk reconstruction and
manifest validation, a chunker benchmark, standalone multi-process smoke tests,
TLS transfers, malformed/truncated frames, gzip checksums/size limits, corrupted
cache repair, empty/binary inputs, edits/reordering, persistent restart recovery,
upload budgets, authentication, redirects, concurrent use, provider HTTP errors,
SSE/tool-event streaming, cancellation, header/idle timeouts, quota enforcement,
request-ID replay rejection, and safe non-overwriting diagnostic exports.

## 10. Continuing safely

- General operation: [`SETUP.md`](SETUP.md).
- Local test specifics and helpers were kept in a private `.runtime/` profile;
  they are not distributed with the repository or needed for a fresh setup.
- Treat `.runtime` as private: it can contain real account/session state, relay
  credentials, and logs. It remains gitignored, as do token/environment files.
- Inspect current health before using historical PIDs or counters. Do not signal
  a process based only on an old PID file or a broad command substring.
- Starting the Desktop helper alone does not start a stopped gateway, remote
  relay, or tunnel. Use the repository-root `startup.sh` to recover those first
  and then open the isolated Desktop, or bring the components up deliberately
  before sending tests.
- The test stop helper retains caches/accounts and does not stop the whole
  Codespace. Codespace availability can continue to consume GitHub usage; its
  idle/suspension/billing behavior was not changed.
- One tenant and one writer per cache directory; no automatic cache eviction,
  credential migration, token/KV-cache guarantee, or exactly-once inference claim.
- Account entitlement, provider IP/region restrictions, and rate limits still
  apply. Preserve TLS/SSH verification and narrow upstream rules.
- Check cache/journal capacity and transient spool disk requirements. Cache and
  diagnostic data are private-permission plaintext, not encrypted at rest.
- The prototype's automatic tunnel supervisor is a local test helper, not a
  replacement for a properly managed production service and deployment policy.

## 11. On-demand Codespace recovery — 2026-10-26

Added `deploy/recover_codespace.py`, its self-contained remote helper
`deploy/recover_relay.py`, and the private `.runtime/codespace-test/recover.sh`
wrapper. See [`CODESPACE_RECOVERY.md`](CODESPACE_RECOVERY.md).

Recovery starts the existing Codespace only if stopped, finds the remote store
matching the saved local relay identity, starts only missing relay/tunnel/gateway
processes, and verifies readiness. It has a bounded retry window and backoff for
an unreliable internet connection. It never recreates the Codespace, resets the
cache or identity, automatically replays inference, or changes provider accounts,
public-port settings, or idle policy. The system GitHub CLI was not upgraded.

The user changed their default timeout to 240 minutes, but the existing Codespace
API still reported `idle_timeout_minutes: 30`. GitHub documents that changing the
default applies to new Codespaces. No undocumented timeout update was attempted.

The six-minute live recovery attempt failed: repeated GitHub SSH startup calls
returned `context deadline exceeded`, followed by a connection error. Although
the API reported the Codespace `Available`, the remote helper was not confirmed
executed, and neither remote readiness nor a live restart could be established.
The pre-existing local gateway and tunnel supervisor remained running; their PIDs
and the saved local relay identity were unchanged. Rerun the recovery command
after connectivity improves rather than treating this as a successful recovery.

Validation passed: 26 Python recovery tests including a real local relay restart
with preserved identity and zero repeated chunk uploads; `go test ./...`;
`go test -race ./...`; and the three Node plugin tests. These tests made no live
provider inference requests and did not alter the persistent Codespace test cache.

## 12. One-command startup — 2026-10-26

Added the repository-root `startup.sh`. It runs the existing private
`.runtime/codespace-test/recover.sh`, then launches the isolated Desktop profile
whose OpenCode configuration routes selected providers through the recovered
gateway. Recovery options such as `--timeout` are forwarded; `--no-desktop` keeps
the previous recovery-only behavior. If the isolated Desktop is already running,
the script records its PID and does not open a duplicate; detection handles
Electron rewriting its argv into a space-separated command line, and a handoff
fallback preserves the live PID if a new process exits because another instance
owns the profile. It serializes concurrent startups, refuses to launch a GUI
without `DISPLAY`/`WAYLAND_DISPLAY`, and closes the startup lock descriptor before
spawning Desktop so the GUI does not hold the lock for its lifetime.

`recover.sh` itself remains unchanged and recovery-only. Documentation was updated
in `README.md`, `docs/CODESPACE_RECOVERY.md`, and the private runtime README.
Validation used shell syntax checking and isolated stub profiles for argument
forwarding, `--no-desktop`, no-display refusal, duplicate detection, and
post-launch lock release. No live Codespace start or Desktop instance was created
by these checks.
