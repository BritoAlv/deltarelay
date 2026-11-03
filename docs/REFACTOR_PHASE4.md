# Refactor Phase 4 — provider-job service separated from HTTP handlers

**Completed:** 2026-11-03. Phase 1–3 contracts, client transport, and Python
supervision are unchanged. This phase reorganizes `internal/server` only: no
wire format, persisted claim, storage layout, provider policy, or configuration
compatibility behavior changed.

## Delivered

- Added an internal `jobService` in
  [`internal/server/jobs.go`](../internal/server/jobs.go) that owns durable
  provider-job orchestration:
  - replay lookup and same-content duplicate responses;
  - request-body reconstruction and its close ownership;
  - provider-slot admission, including bounded rejection without claiming;
  - mailbox acceptance with the existing atomic journal claim callback;
  - job start, execution, cancellation, periodic mailbox sweeping, shutdown
    cancellation, and waiting for terminal records.
- The service constructor receives `store`, `mailbox`, `journal`, provider
  `policy`, HTTP client, concurrency, runtime, idle timeout, and parent context
  explicitly. It does not derive resources from `Store.Directory()` itself; the
  composition root in `server.New` still opens storage/mailbox/journal and hands
  them over.
- Reduced the durable HTTP handlers to decoding, endpoint validation, a service
  call, and status/error mapping. `POST /v2/requests/{id}/cancel` now also
  delegates to the service while keeping the same journal claim and message.
- Added [`internal/server/provider.go`](../internal/server/provider.go) with the
  shared provider-request validation and fingerprint rules used by legacy
  forwarding and durable submission:
  - manifest validation;
  - header validation, canonicalization, hop-by-hop removal, and relay-metadata
    stripping;
  - destination allowlist matching;
  - decoded-content enforcement;
  - the unchanged persisted claim representation and SHA-256 digest.
- Added [`internal/server/decode.go`](../internal/server/decode.go) with one
  bounded, compression-aware, single-object JSON decoder. Each endpoint keeps
  its existing content-type rules, limits, status codes, and messages.
- Kept legacy streaming request-scoped and distinct from durable background
  generation. They share validation/fingerprint/claim rules but not an execution
  model, so legacy responses still stream directly to the caller.
- Preserved the safety ordering:
  - acceptance and cancellation remain serialized by the mailbox claim callback;
  - a request is claimed before dispatch;
  - a shutdown observed after acceptance persists an interrupted record and
    never dispatches;
  - same-content retries return the stored record instead of regenerating;
  - slot and reconstructed-body ownership transfer together to the job goroutine
    only after a successful start;
  - `Close` stops admission, cancels running work and mailbox contexts, then
    waits for terminal records in the previous order.

## Files

- New: `internal/server/jobs.go`, `internal/server/provider.go`,
  `internal/server/decode.go`, `internal/server/jobs_test.go`.
- Reduced: `internal/server/submit`/cancellation in `mailbox.go`, legacy
  forwarding in `forward.go`, server composition in `server.go`.
- Test-only updates: fingerprint transport injection now targets
  `jobService.upstream`; the baseline benchmark uses the service-owned journal.

## Regression entry points

- `internal/server/jobs_test.go`:
  - `TestJobServiceSubmissionAndDuplicateWithoutHTTP`
  - `TestJobServiceCancelBeforeSubmitDoesNotDispatch`
  - `TestJobServiceRunningCancellationKeepsSingleDispatch`
  - `TestJobServiceShutdownCancelsAndWaitTerminal`
  - `TestJobServiceConcurrencyLimitDoesNotClaimOrLeak`
- Existing end-to-end coverage still passes unchanged:
  - `TestV2ContractPersistenceIdentityAndLegacyClaims`
  - `TestV2CancellationTombstoneAndInvalidBodyNeverDispatch`
  - `TestV2RuntimeAndResponseLimitsFailWithoutReplay`
  - `TestRequestIDConflictsAcrossAPIsAndRestarts`
  - `TestPersistedRequestFingerprintCompatibility`
  - `TestForwardVerifiesBeforeDispatchAndClaimsSurviveRestart`
  - `TestHeaderTimeoutDoesNotReplayGeneration`

## Offline verification ledger

All commands below passed after implementation. No dependency was added and no
private configuration, credential, relay store, deployed executable, or live
service was inspected or changed. The binary was built separately under
`.runtime/refactor-phase4/`.

| Command | Result |
| --- | --- |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -count=1 ./...` | Pass; installed-OpenCode opt-in remains skipped |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go vet ./...` | Pass |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -trimpath -o .runtime/refactor-phase4/deltarelay ./cmd/deltarelay` | Pass; isolated new binary, not `bin/deltarelay` |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, 3 real-binary opt-in skips |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase4/deltarelay" python3 -B -m unittest discover -v -s deploy -p 'test_*.py'` | 113 passed, no skips |
| `pnpm check` | Pass |
| `pnpm test` | 104 passed |
| `pnpm build` | Pass; static Astro output |
| `git diff --check` | Pass |

Phases 5–8 have not started. In particular, filesystem durability primitives
remain colocated with their owners, telemetry persistence still runs on the
request path, dashboard feature/browser work is outstanding, and CLI
deduplication/documentation work is outstanding.
