# Refactor Phase 0 — behavioral and performance baseline

**Recorded:** 2026-11-01. **Status:** complete; no production code moved or changed.
The starting checkout was clean at `09e49a7780df051548728cf325b6caf72ace8279`.
This is a snapshot for evaluating later refactoring, not a new protocol or a
promise of exactly-once provider execution.

Only tracked source, examples, and isolated test fixtures were used to inventory
configuration. No existing private profiles, credentials, services, remote hosts,
or user configuration were read or changed. The test binary was built separately
at `.runtime/refactor-phase0/deltarelay`, not over a deployed executable.

## 1. Test and build ledger

Environment: Linux/amd64, Go **1.27.1**, Node **22.22.1**, pnpm **12.5.1**,
Python **3.14.4**. Go still requires only the standard library; existing pinned
Node dependencies were already installed. No packages or test tools were added.

These commands ran **before** adding characterization tests or benchmarks:

| Command | Initial result |
| --- | --- |
| `go test -race -count=1 -v ./...` | Pass, all 12 packages; installed-OpenCode test skipped |
| `go vet ./...` | Pass |
| `go build -trimpath -o .runtime/refactor-phase0/deltarelay ./cmd/deltarelay` | Pass |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `python3 -B -m unittest discover -v -s deploy -p 'test_*.py'` | 98 passed, 3 skipped, 101 discovered |
| `pnpm check` | Pass |
| `pnpm test` | 23 passed |
| `pnpm build` | Pass; static Astro output |

**Pre-existing failures:** none observed. **Refactoring regressions:** none observed.
Go race tests, vet, build, plugin tests, and all three pnpm commands passed again
after the additions. The final Go checks/build explicitly used
`GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local`.

The three Python skips were subsequently exercised successfully against the new
isolated binary: **101 passed, no skips**, using:

```sh
DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase0/deltarelay" \
  python3 -B -m unittest discover -s deploy -p 'test_*.py'
```

Those opt-ins are local tests, not live deployments:

- `test_codespace_recovery.RealRelayTest.test_restart_preserves_identity_and_uploaded_chunks`
  restarts only its temporary relay.
- `test_dashboard_startup.RealDashboardTest.test_real_dashboard_starts_once_with_private_logs`
  launches only a temporary dashboard, not Desktop.
- `test_supervisor.RealTransportTest.test_two_network_switches_resume_one_provider_generation`
  interrupts only its owned local forwarder and uses a mock provider.

`internal/gateway.TestInstalledOpenCodePlugin` remains deliberately unrun: it
requires `DELTARELAY_TEST_OPENCODE=1` and an installed V2 executable. Its intended
fixture uses isolated configuration and a mock provider; no real account coverage
is claimed. Browser DOM smoke tests do not yet exist (Phase 7). Fuzz seeds run in
the ordinary Go suite; extended fuzzing is not part of this recorded gate.

To repeat the offline gate, use the commands above from the repository root,
then the Python opt-in command after the isolated build. Do not run `startup.sh`,
the provider checker against a real configuration, or recovery commands as a
substitute. A fresh checkout needs the documented offline pnpm cache first;
this run did not install dependencies or modify lockfiles.

## 2. Entry points and dependency ownership

### Executable boundaries

| Entry point | Current responsibility / downstream boundary |
| --- | --- |
| `cmd/deltarelay/main.go` | CLI dispatch; `serve`, diagnostic `sync`/`fetch`, help, version |
| `cmd/deltarelay/gateway.go` | `gateway`, `doctor`, `gen-token`, token/environment loading |
| `cmd/deltarelay/recovery.go` | `request info/status/fetch/ack/cancel`; recovery flags and state-directory defaults |
| `cmd/deltarelay/dashboard.go` | Loopback dashboard HTTP composition |
| `integration/opencode/index.mjs` | V2 plugin default export `{id, setup}`; HTTP routing, retry veto, optional token-sharing policy, disposal |
| `integration/opencode/config.mjs` | Prints a configuration fragment; does not read/write credentials or install configuration |
| `startup.sh` → `deploy/start_supervisor.py` | Select existing configuration, offline build, start/reuse controls before remote recovery |
| `deploy/supervisor.py` | Configuration, process adoption/ownership, probes, recovery scheduling, settings, Unix HTTP control server |
| `deploy/start_dashboard.py` | Compatibility dashboard launcher; offline/atomic Go build and static assets |
| `deploy/recover_codespace.py` | Bounded one-shot compatibility recovery of an existing Codespace deployment |
| `deploy/recover_relay.py` | Self-contained remote helper, also imported locally; sent over stdin to remote `python3 -` |
| `deploy/check_remote_provider.py` | Trusted provider's read-only contract checker; never a refactor test against user configuration |
| `deploy/providers/{ssh,direct_https,codespaces}.py` | Standalone stdio providers; import `remote_provider` and `providers.common` through their script-relative import setup |
| `examples/remote-provider/provider.py` | External-executable contract example |
| `web/src/pages/index.astro` | Static page composition; `web/src/scripts/{dashboard,system}.ts` independently poll data/control APIs; pure libraries under `web/src/lib/` |

### Direct Go dependencies

Captured with `go list -f '{{.ImportPath}}: {{join .Imports ", "}}' ./cmd/... ./internal/...`.
Only repository-internal edges are listed; all other imports are standard library.

| Package | Direct internal dependencies |
| --- | --- |
| `cmd/deltarelay` | client, dashboard, gateway, protocol, server, store, upstream |
| `chunker` | protocol |
| `client` | chunker, protocol, upstream |
| `dashboard` | None; uses HTTP/Unix-socket boundaries |
| `gateway` | client, protocol, telemetry, upstream |
| `journal` | protocol |
| `mailbox` | protocol |
| `protocol` | None |
| `server` | journal, mailbox, protocol, store, upstream |
| `store` | protocol |
| `telemetry` | client (the `Stats` value type) |
| `upstream` | protocol |

Python's current local graph is `start_supervisor` → `start_dashboard` and
`supervisor`; `start_dashboard` → `recover_codespace` / `recover_relay`;
`supervisor` → `recover_relay`, `remote_provider`, `providers.legacy`;
`providers.legacy` → `remote_provider`, `providers.codespaces`. Provider stdio
envelopes belong to `remote_provider.py`; `recover_relay.py` has no local-package
dependency and must remain runnable remotely without an installed Python package.

Lifecycle boundaries to retain: client owns spools and the cancellation worker;
server owns provider jobs and waits for their terminal records on close; legacy
forwarding follows the subscriber context, whereas durable jobs survive a lost
subscriber. Gateway history is optional observation, not durable response storage.
`Recorder.Begin` and `Finish` currently serialize and fsync the whole history file
synchronously under its mutex when a statistics path is configured.

### Command paths that require compatibility

This inventory is derived from tracked launchers/examples, **not private files**.
Preserve the paths and argv contracts even if implementations move later:

- Checkout `bin/deltarelay` and `web/dist`; systemd examples use
  `%h/.local/bin/deltarelay`, `/usr/local/bin/deltarelay`, and `/usr/bin/ssh`.
- `startup.sh`, `deploy/start_supervisor.py --project … --config …` (or
  `--profile …`), `deploy/supervisor.py --config …`, and
  `deploy/start_dashboard.py` remain executable entry points.
- All three `deploy/providers/*.py` executable paths and interpreter/script argv
  are public configuration boundaries. External provider executables need no move.
- Existing Codespace layout uses `deltarelay-linux-amd64`, `relay.token`,
  `upstreams.json`, and an existing store's `mailbox/identity.json` remotely.
  Local adapter paths include `tunnel-supervisor.sh`, `profile-opencode.sh`, and
  `launch-desktop.sh`; these private helpers must not be moved or rewritten.
- Plugin package location is the checkout's `integration/opencode/`, resolved
  relative to the generator's own file, not the caller's working directory.

## 3. Versions and JSON compatibility inventory

### Independent version domains

| Domain | Current version / marker | Important distinction |
| --- | --- | --- |
| CLI release | `0.3.0` | Not a protocol selector |
| Chunk/manifest encoding | `protocol.Version = 1`, `DRLY0001`, `application/vnd.deltarelay.chunks.v1` | Still v1 when transported over `/v2/*` |
| Durable relay API | `protocol.RelayVersion = 2`, `/v2/info`, `/v2/requests/*` | Identity pin, idempotent submission, resumable mailbox, explicit cancellation/ACK |
| Legacy forwarding | `/v1/forward`, forwarding metadata `version:1` | Non-retryable generation; shares the dispatch-claim journal with v2 |
| Local gateway | `/v1/proxy` | Path stays v1; current client submits to relay v2, with no legacy fallback |
| Remote-host executable | Envelope `protocol_version:1` | Independent of relay and supervisor versions |
| Supervisor configuration | `version:1` | Not its status schema version |
| Supervisor status | Current `version:2`, legacy `version:1` accepted | v1 `codespace_state` is normalized to `remote` but retains version 1 so actions still target `codespace`; v2 targets `remote` |
| Gateway dashboard / telemetry | Snapshot `version:1`, history `version:1` | Neither is the durable relay API version |

The relay's legacy `/healthz` returns chunk `version:1`; `client.Health()` derives
its `version:2` from `/v2/info`. Do not replace these with a single global version.

### Relay and command JSON

`?` below means omitted when empty, not a renamed or newly optional field.
HTTP header maps serialize as objects of string arrays. Hashes/identities are
lowercase 64-hex strings; request IDs currently use `upstream.ValidRequestID`
(`^[A-Za-z0-9_-]{16,128}$`, distinct from telemetry's dot-allowing labels).

| Shape / owner | Existing fields |
| --- | --- |
| `protocol.Manifest`, `Chunk` | `version, hash, size, chunks:[{hash,size}]`; order and duplicate references are meaningful |
| Cache replies (`protocol`) | Inventory `{missing:[{hash,size}]}`; upload `{chunks,bytes}`; assembly `{hash,size}` |
| `protocol.ForwardRequest` | `version,id,target,method,headers,manifest`; outer version 1 or 2, inner manifest always 1 |
| `protocol.Info` | `version,chunk_version,state_id,forwarding,capabilities,max_body_bytes,max_chunk_bytes,max_manifest_bytes,max_batch_bytes,max_batch_chunks,response_segment_bytes,poll_timeout_seconds,max_response_bytes,max_response_storage_bytes,response_storage_bytes,retention_seconds,max_runtime_seconds,max_concurrent,max_journal_records,cache_bytes,max_cache_bytes` |
| `protocol.RequestStatus` | `id,state_id,fingerprint,body_hash,state,status,headers?,bytes,hash?,created_unix,finished_unix?,expires_unix?,acknowledged,expired,error_code?`; timestamps are Unix seconds, `bytes` is the durable prefix |
| `protocol.Receipt` | `size,hash`; ACK requires the exact completed length/hash |
| Relay errors | `{error:string,code?:string}`; stable codes distinguish conflict, changed state, gone response, integrity, and storage failures |
| `client.Stats` | `hash,body_bytes,chunks,unique_chunks,uploaded_chunks,uploaded_chunk_bytes,missing_chunk_bytes,reused_body_bytes,request_body_bytes_sent,requests,duration_ms` |
| `gateway.Result` | `request_id,upstream,status,transfer:Stats,response_bytes,duration_ms,failed,cancelled?,error_code?,session_id?` |
| `sync` stdout | One `Stats` object, including partial progress on transfer error |
| Diagnostic `fetch` stdout | `hash,output,verified` |
| `request info/status` stdout | `Info` / `RequestStatus` |
| `request fetch/ack/cancel` stdout | Fetch: `id,output,hash,size,verified,acknowledged`; ACK: `id,acknowledged`; cancel: `id,cancellation_queued,control_error` |
| `gen-token` stdout | `token_file` only, never the token |
| `doctor` stdout | `healthz` and `metrics` objects, keyed by endpoint name |

All relay routes require relay bearer authentication; v2 routes except discovery
also require `X-DeltaRelay-State-ID`. The gateway uses a separate
`X-DeltaRelay-Local-Token`. Its errors use
`{error:{type:"deltarelay",message:string}}`, not the relay's flat error envelope.
Provider bodies/responses remain opaque bytes, including HTTP errors and SSE.

Current persisted fingerprints in both forwarding paths hash JSON with **capitalized**
fields `Target,Headers,Hash,Size`, in that order, after header cleaning and removing
content encoding. Method/version/request ID are not added to that representation.
Phase 1 froze these bytes in `testdata/contracts/fingerprints.json` and verified
them against both APIs' persisted claims; extraction remains later work.

### Diagnostics, telemetry, and browser control JSON

Owners: `internal/gateway/{gateway,dashboard}.go`, `internal/telemetry/telemetry.go`,
`internal/dashboard/{control,auth}.go`, `deploy/supervisor.py`, and the matching
TypeScript types in `web/src/lib/{types,system}.ts`.

| Shape | Existing fields |
| --- | --- |
| Gateway health / metrics | Health `{ready,version,vps:Health}`; metrics `requests,active,failed,cancelled,body_bytes,uploaded_chunk_bytes,encoded_upload_bytes,response_bytes,pending_cancellations,control_error` |
| `client.Health` | `version,state_id,forwarding,cache_bytes,max_cache_bytes,response_storage_bytes,max_response_storage_bytes,pending_cancellations,control_error?` |
| Dashboard snapshot | `version,collected_at,gateway:{started_at,active,concurrency,pending_cancellations,control_error?},relay:{reachable,latency_ms,health},providers,history` |
| Provider observation | `name,active,last_status,last_error?,last_seen?` |
| History | `version,since,totals,sessions,recent_requests,session_limit,request_limit,evicted_sessions,dropped_requests,persistent,persistence_error` |
| Telemetry totals | `requests,active,failed,cancelled,body_bytes,uploaded_chunk_bytes,encoded_upload_bytes,reused_body_bytes,response_bytes,duration_ms` |
| Telemetry session | Totals plus `id,started_at,updated_at,upstream,last_status,last_error?,last_request_id` |
| Telemetry request | `sequence,id,session_id,upstream,kind,started_at,finished_at?,state,status,error_code?,transfer:Stats,response_bytes,duration_ms` |
| Supervisor status | `version,managed,collected_at,settings:{auto_reconnect,auto_wake},recovery:{busy,phase,attempts,last_error,last_connected_at,next_retry_at},relay_state,internet_state,internet_checked_at,remote:{id,label,host_state,capabilities},components:[{id,label,state,can_start,can_restart}]` |
| Browser system status | Supervisor status plus per-dashboard `csrf_token`, `auth:{state,expires_at?,checked_at?,stale}`, and optional `error`; unavailable/unconfigured fallback is `version:2,managed:false` |
| Control/settings input | `{component,action,confirmed?}` / exactly `{auto_reconnect:boolean,auto_wake:boolean}`; no command strings or file paths |
| Control reply | `{accepted:true}` on 202, otherwise `{error:code}`; the Go proxy also has an optional `accepted` field in its reply struct |

Telemetry/browser timestamps are UTC RFC3339 strings, with nullable supervisor
`last_connected_at`, `next_retry_at`, and `internet_checked_at`. Auth expiry comes
from OpenCode Unix **milliseconds**, converted to RFC3339 before reaching the
browser. State/capability enums and legacy action routing are in `control.go` and
`web/src/lib/system.ts`; they must not be inferred from provider brands.
`/api/dashboard` proxies gateway JSON; `/api/opencode/sessions` optionally exposes
sanitized local OpenCode session metadata; `/api/system` does not require the
gateway. Writes require exact same origin, JSON content type, and
`X-DeltaRelay-Control` nonce. These browser controls never receive
relay/provider credentials.

Remote-provider v1 already has the precise envelope/result schema in
[`remote-provider-v1.schema.json`](remote-provider-v1.schema.json): request fields
`protocol_version,id,method,config_file,params`; response echoes version/ID and
has exactly one of `result` or `{error:{code,retryable}}`. Required read methods
are `describe,connection,status`; optional capabilities are
`relay.ensure,relay.restart,host.wake,host.stop`. Results and strict fixed errors
are inventoried in [REMOTE_PROVIDERS.md](REMOTE_PROVIDERS.md), with runtime/schema
parity coverage in `test_published_schema_matches_runtime_operations_states_and_errors`.

Other persisted boundaries: mailbox `identity.json` and client `relay-state.json`
are JSON strings; cancellation outbox records are `{id,state_id}`; download
checkpoints currently serialize capitalized `Kind,Key,Output,StateID`; exclusive
journal markers contain `fingerprint,created_unix`. A failed/incomplete dispatch
marker is intentionally retained. No storage migration is part of this phase.

## 4. CLI defaults and environment precedence

Values are observed runtime defaults, **not proposed corrections**. Sizes below
are binary units. Flags override environment-derived flag defaults, including
explicit empty strings. Unlisted optional file/hash/ID flags default empty and
boolean opt-ins default false.

| Command / owner | Baseline defaults |
| --- | --- |
| `serve` | Listen `127.0.0.1:8787`; data `./data`; body 256 MiB; concurrency 8; cache 10 GiB; claims 100,000; provider headers 5m; idle 15m; response retention 24h; response 256 MiB; response storage 4 GiB; runtime 2h; no forwarding without allowlist; TLS cert/key must be paired |
| `gateway` | Listen `127.0.0.1:8788`; server `http://127.0.0.1:8787`; workers 4; batch 256 KiB; concurrency 8; body 256 MiB; upload budget -1/unlimited; total call timeout 0/unlimited; relay headers 2m; stats `.runtime/dashboard-stats.json`; adaptive gzip on |
| `sync` / `fetch` shared parser | Server `http://127.0.0.1:8787`; whole-operation timeout **4h**; input `-`; workers 4; batch **256 KiB**; compression on; upload budget -1; body 256 MiB; state directory empty/memory-only; `fetch` requires hash and new output |
| `request info/status/fetch/ack/cancel` | Server `http://127.0.0.1:8787`; timeout 4h; persistent default state directory; ACK size -1 until specified; `--ack` on fetch is false |
| Shared recovery flags | Retry window 1h; min 1s; max 30s (Retry-After may extend a wait); stall 2m; retries enabled; expected-state ID empty |
| `dashboard` | Listen `127.0.0.1:8790`; gateway `http://127.0.0.1:8788`; assets `web/dist`; auth integration `openai`; supervisor socket / OpenCode service registration empty |
| `doctor` | Gateway `http://127.0.0.1:8788`; fixed 10s command timeout |
| `gen-token` | Requires new output path; 32 random bytes encoded as hex, private mode, exclusive creation |

Constructor differences are intentional baseline facts: `client.New` has a 5m
header timeout unless supplied (gateway CLI supplies 2m), no default control
directory, and the same workers/batch/chunking/recovery defaults. Chunker sizes
are 4/16/64 KiB min/target/max. `gateway.New` uses memory-only history when
`StatsFile` is empty. There is **no full telemetry-accounting-off switch**;
`--quiet` disables metadata logs only. `store.Open` has no byte quota, whereas
the `serve` composition supplies 10 GiB. Mailbox defaults match the serve limits.

| Setting | Precedence / intentional exceptions |
| --- | --- |
| Relay/local token value | Explicit/default token-file path, if nonempty, replaces `DELTARELAY_TOKEN` / `DELTARELAY_LOCAL_TOKEN`; invalid/missing explicit file fails, never falls back. Files are trimmed; environment token values are not |
| Token-file defaults | Gateway/request use `DELTARELAY_TOKEN_FILE`; gateway/dashboard/doctor use `DELTARELAY_LOCAL_TOKEN_FILE`; serve/sync/fetch do **not** inherit `DELTARELAY_TOKEN_FILE` |
| Relay URL | Gateway/request inherit nonempty `DELTARELAY_SERVER`; sync/fetch retain their literal loopback default |
| Allowlist / stats | Only gateway CLI inherits `DELTARELAY_UPSTREAMS_FILE` / nonempty `DELTARELAY_STATS_FILE`; `--stats-file ''` disables persistence, empty environment value selects the ordinary default |
| Recovery state | Gateway/request: `XDG_STATE_HOME/deltarelay`, otherwise `$HOME/.local/state/deltarelay`; sync/fetch default empty. `--state-dir` overrides either |
| Startup configuration | `--config` first; otherwise nonempty `DELTARELAY_PROFILE`, then `${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/supervisor.json`, then existing private Codespace adapter. Dashboard port from `DELTARELAY_DASHBOARD_PORT` or 8790 |
| Plugin generator | `DELTARELAY_LOCAL_TOKEN_FILE`, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/local.token`; output path resolved absolute; defaults to providers `openai,opencode-go`, gateway 8788, header timeout 14,400,000 ms |
| Plugin runtime | Explicit `localTokenFile`, otherwise `DELTARELAY_LOCAL_TOKEN`; gateway/providers/timeout via options; `enabled:false` registers nothing; token-sharing provider opt-in defaults empty |
| Supervisor/provider | Config version 1; saved settings override initial `auto_reconnect:true,auto_wake:false`. Provider mutation timeout 120s (1–300), read calls capped at 5s. Sanitized environment plus explicit `env`, then selected ambient `pass_env` values |

Private readers do not yet share identical policies: CLI/plugin token readers
use stat/read and follow symlinks; checkpoint/history/provider readers explicitly
reject symlinks where implemented. Do not silently broaden or tighten those
different contracts while extracting filesystem helpers.

Known documentation drift at baseline time was recorded, not repaired, in this
phase: README described a 2 MiB batch and 30-minute transfer timeout while the
code used 256 KiB and 4h; top-level CLI help called the dashboard read-only
despite optional protected supervisor controls. These were corrected in Phase 8
(see [`REFACTOR_PHASE8.md`](REFACTOR_PHASE8.md)).

## 5. Behavior-to-regression matrix

Names below are runnable existing tests unless marked **new**. File paths locate
the package/module, so a passing unrelated test is not mistaken for coverage.

| Guarantee | Named coverage |
| --- | --- |
| Cold transfer, exact reconstruction, reuse across restart/edits | `internal/client/client_test.go`: `TestDeltaRoundTripAndRestart`, `TestEmptyBinaryRepeatedAndUncompressedBodies`; `internal/store/store_test.go`: `TestPersistenceReorderingAndIntegrity`; `internal/chunker/chunker_test.go`: `TestInsertionResynchronizes` |
| Upload budgets before chunk transfer, authentication, untrusted inventories/ACKs | `internal/client/client_test.go`: `TestUploadBudgetAndAuthentication`, `TestUntrustedInventoryAndAcknowledgmentFailClosed`, `TestCorruptRemoteChunkIsReuploaded`; `internal/server/server_test.go`: `TestRejectsMissingChunksAndWrongWholeBodyHash`, `TestGzipChecksumAndManifestValidation` |
| Interrupted uploads re-inventory already persisted chunks | `internal/client/recovery_test.go`: `TestInterruptedUploadReinventoriesPersistedChunks`; `internal/server/server_test.go`: `TestInterruptedBatchPreservesVerifiedChunksForRetry` |
| Lost submission ACK and offset response recovery without regeneration | `internal/client/recovery_test.go`: `TestLostSubmissionAckAndOfflineResponseResumeWithoutRegeneration`, `TestTruncatedResponseSegmentRetriesSameOffset`, `TestBodyDownloadCheckpointSurvivesClientRestart`; Python `RealTransportTest.test_two_network_switches_resume_one_provider_generation` |
| Cross-API claims, changed-content conflicts, and restarts cannot redispatch | **New** `internal/server/baseline_test.go`: `TestRequestIDConflictsAcrossAPIsAndRestarts` (legacy/durable/cancel-first; target/header/body conflicts); existing `TestV2ContractPersistenceIdentityAndLegacyClaims`, `TestForwardVerifiesBeforeDispatchAndClaimsSurviveRestart`; `internal/journal/journal_test.go`: `TestDurableExclusiveClaimsAndLimit` |
| Cancel before submit; offline cancellation remains queued across gateway/client restart | `internal/server/mailbox_test.go`: `TestV2CancellationTombstoneAndInvalidBodyNeverDispatch`; `internal/mailbox/mailbox_test.go`: `TestCapacityExpiryAndCancellationBeforeSubmission`; `internal/client/recovery_test.go`: `TestOfflineCancellationOutboxSurvivesGatewayRestart` |
| Stable relay identity; replacement/missing identity fails closed | `internal/server/mailbox_test.go`: `TestV2ContractPersistenceIdentityAndLegacyClaims`; `internal/client/recovery_test.go`: `TestChangedRelayStateFailsClosedAcrossClientRestarts`; Python `ProfileTest.test_missing_or_changed_identity_never_initializes_store`, `HealthTest.test_identity_mismatch_is_not_retryable`, `RealRelayTest.test_restart_preserves_identity_and_uploaded_chunks` |
| Verified response frames, committed prefix vs crash tail, corrupt storage refusal | `internal/mailbox/mailbox_test.go`: `TestDurableFramesRestartAckAndTombstones`, `TestCrashRecoveryTruncatesOnlyUncommittedTail`, `TestCorruptionFailsClosed` |
| Retention, exact ACK, payload reclamation, tombstones, capacity/runtime bounds | **New** `internal/mailbox/baseline_test.go`: `TestAckAndExpiryTombstonesSurviveRestart` (released bytes stay gone; IDs still occupy record capacity); existing `internal/mailbox/mailbox_test.go`: `TestCapacityExpiryAndCancellationBeforeSubmission`, `TestDurableFramesRestartAckAndTombstones`; `internal/server/mailbox_test.go`: `TestV2RuntimeAndResponseLimitsFailWithoutReplay`; `internal/store/store_test.go`: `TestQuotaAndAnonymousReconstruction` |
| Header/idle/stall timeout and truncated streams never look successful or regenerate | `internal/server/forward_test.go`: `TestHeaderTimeoutDoesNotReplayGeneration`; `internal/gateway/gateway_test.go`: `TestIdleTimeoutAbortsStream`, `TestConnectionDropAfterForwardIsAmbiguous`; `internal/client/recovery_test.go`: `TestRetryStopsForPermanentErrorsAndCallerCancellation` |
| Exact streaming/SSE/tool events, cancellation, no direct fallback | `internal/gateway/gateway_test.go`: `TestEndToEndStreamingAndReuse`, `TestCancellationAndRequestReplayAreSafe`, `TestVPSLossIsReportedAndNeverFallsBack`; plugin `index.test.mjs`: “forces HTTP, routes all model flows, preserves content/auth, and vetoes retries” |
| Redirect refusal and no-overwrite downloads | `internal/client/client_test.go`: `TestRedirectIsNotFollowedAndDownloadNeverOverwrites`; `internal/gateway/gateway_test.go`: `TestProviderErrorsAndRedirects`; Python `HealthTest.test_redirect_does_not_forward_authentication` |
| Destination/DNS restrictions and credential/header separation | `internal/upstream/upstream_test.go`: `TestDestinationPolicyAndHeaders`, `TestPrivateDNSIsForbidden`, `TestSpecialNetworksAreNotPublic`; `internal/gateway/gateway_test.go`: `TestGatewayRejectsUnauthorizedAndDisallowedTargets`, `TestEndToEndStreamingAndReuse`; `internal/dashboard/dashboard_test.go`: `TestReadOnlyProxyKeepsCredentialsOnServer`; Python `ProviderTest.test_ambient_credentials_are_not_inherited_and_opt_in_is_explicit` |
| Local controls survive unavailable gateway/relay; browser writes remain protected | `internal/dashboard/control_test.go`: `TestSystemControlsSurviveGatewayOutageAndRejectCrossSiteWrites`, `TestSystemWithoutSupervisorIsExplicitAndReadOnly`; Python `StartupScriptTest.test_no_graphical_session_does_not_block_local_controls`, `SupervisorTest.test_manual_recover_all_starts_local_services_even_when_remote_is_down` |
| Remote capabilities, confirmation, stop saves recovery suppression even on failure | Python `ProviderTest.test_capabilities_and_parameters_gate_calls_before_execution`, `test_manual_power_requires_capability_and_confirmation_and_stop_persists_pause`, `test_failed_stop_does_not_claim_shutdown_or_reenable_recovery`, `test_stopped_host_is_never_woken_indirectly_through_tunnel_recovery`; `SupervisorTest.test_codespace_stop_persists_recovery_pause_and_waits_for_shutdown`, `test_failed_codespace_stop_keeps_recovery_disabled_and_does_not_claim_shutdown` |
| Process ownership, bounded provider calls, no unrelated process replacement | Python `SupervisorTest.test_real_owned_process_is_adopted_and_restarted_without_signaling_unrelated_process`, `test_unknown_port_owner_is_never_replaced`; `ProviderTest.test_timeout_and_cancellation_reap_plugin_process_groups`, `test_permanent_plugin_failure_blocks_automatic_mutations_across_ticks` |
| Optional history remains bounded/private; persistence error does not lose in-memory accounting | `internal/telemetry/telemetry_test.go`: `TestAggregationAndConcurrentRequests`, `TestPrivatePersistenceAndRestart`, `TestBoundedRetentionPreservesGlobalTotalsAndActiveRequests`, `TestRefusesUnsafeOrCorruptHistory`, `TestPersistenceFailureDoesNotLoseLiveStatistics` |
| Existing configuration precedence and CLI defaults | **New** `cmd/deltarelay/baseline_test.go`: `TestCLIBaselineDefaults`, `TestCLIEnvironmentPrecedence`, `TestCLIExplicitFlagsOverrideEnvironment`, `TestTokenFilePrecedenceFailsClosed`; existing plugin `config.test.mjs` and Python `StartupScriptTest` cover generator/startup selection |

All new tests use temporary private files and loopback mocks. No new test invokes
a real hosting CLI, account, private profile, Desktop, or destructive recovery.

### Deliberate coverage limits for later phases

- Phase 1 is complete: shared fixtures, complete TypeScript guards, Python/provider
  parity checks, semantic type ownership, and byte-exact fingerprint goldens are
  recorded in [`REFACTOR_PHASE1.md`](REFACTOR_PHASE1.md). The gaps below are later work.
- Phase 2/5: no comprehensive injected close/write/rename/fsync-failure matrix.
  Preserve existing claim/checkpoint/crash-tail tests before sharing mechanics.
- Phase 3/4: HTTP/process integration exists; consistent supervisor state ownership
  and direct job-service race coverage are still refactoring work, not established
  by this inventory.
- Phase 6: persistence currently blocks startup. A slow/failing writer latency test
  and an explicit asynchronous flush/crash-loss policy remain to be implemented.
- Phase 7: TypeScript library tests cover fresh-state/capability/action helpers,
  but not actual DOM polling, dialogs, downloads, or browser event wiring.

## 6. Lightweight request-startup measurements

Reproduce independently of the test/build jobs, on an otherwise comparable host:

```sh
make baseline-benchmark
# go test ./internal/server -run '^$' -bench '^BenchmarkGatewayRequestStartup$' \
#   -benchtime=50x -count=3 -cpu=2 -benchmem
```

`internal/server/baseline_bench_test.go` uses real gateway/client/relay/journal/
mailbox code and a mock provider. The gateway handler runs directly (no local
gateway socket); relay/provider HTTP connections are real loopback connections.
Discovery/connections/chunks are warmed before timing. Each sample has one session,
50 unique requests, initially empty history growing to 50, a **16,396-byte** cached
JSON body, and a 30-byte SSE reply. Startup never uploads a repeated chunk.

`persistent=false` disables **telemetry file persistence**, leaving the same
in-memory accounting enabled, exactly like `--stats-file ''`. A full telemetry-off
mode does not exist and was not invented for this phase. `persistent=true` writes
a private statistics file through the normal recorder. Both modes retain all
mailbox/journal durability. Active-mailbox cases schedule one parallel, verified
32 KiB append/read pair on a different running request in the **same mailbox**
for every foreground request; they do not run an unbounded background writer.

The startup clock begins immediately before scheduling the optional background
pair and entering the gateway handler, so it includes that scheduling handoff.
`gateway-ready-ns/op` ends at `OnStart` (after telemetry Begin, before transfer);
`provider-start-ns/op` ends at entry to the mock provider;
`mailbox-pair-ns/op` is the parallel append/read duration. Ordinary `ns/op` includes
the complete foreground response and background pair, plus request construction.
Allocations include all these in-process components, not just telemetry.

Host: Intel Core Ultra 7 155H, Linux/amd64, Go 1.27.1, `GOMAXPROCS=2` via `-cpu=2`;
temporary filesystem reported `ext2/ext3` by `stat -f`. No race instrumentation or
other test/build jobs ran during the measured samples. Values below are medians
of three 50-operation means, not latency percentiles:

| Telemetry persistence | Parallel mailbox | Gateway ready (µs) | Provider start (ms) | Full operation (ms) | Mailbox pair (ms) | B/op | Allocs/op |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Off (memory) | No | 5.662 | 3.054 | 6.667 | — | 1,269,447 | 1,446 |
| Off (memory) | Yes | 6.649 | 4.606 | 8.174 | 1.588 | 1,388,314 | 1,487 |
| On (file) | No | 942.507 | 4.067 | 8.703 | — | 1,331,863 | 1,493 |
| On (file) | Yes | 1,281.810 | 5.208 | 9.855 | 2.088 | 1,448,292 | 1,534 |

Recorded timing samples, in native nanoseconds per operation:

```text
persistent mailbox-active gateway-ready provider-start full-operation mailbox-pair
false      false                 5662        3310490        7093810            -
false      false                 6784        3047832        6666816            -
false      false                 5110        3053531        6612947            -
false      true                  8146        4605869        8174237      1526795
false      true                  6649        4760584        8417705      1587741
false      true                  4414        4559862        8102794      1596144
true       false               934203        4037453        8486020            -
true       false               942507        4066913        8702518            -
true       false               958572        4289217        9019079            -
true       true               1281810        5416090       10155537      2087969
true       true               1317649        5152150        9708224      2117420
true       true               1279578        5208334        9855277      2076520
```

All four benchmark cases also passed a two-iteration race-detector smoke run.
These are small-history, single-foreground-request measurements, not WAN latency,
production throughput, tail latency, maximum-retention history, or a reason to
shard locks. Filesystem/cache/CPU scheduling affect the result. Repeat the same
fixed workload to compare Phases 4–6; add a controlled slow-writer/full-history
experiment when implementing telemetry persistence changes.
