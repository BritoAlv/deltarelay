# Refactor Phase 2 — client transport consolidation

**Completed:** 2026-11-03. Phase 1's contract fixtures, semantic types, and
fingerprint goldens are unchanged. This phase changes only the internal
organization and execution mechanics of `internal/client`.

## Delivered

- Added one authenticated HTTP attempt executor, `execute`, in
  [`internal/client/transport.go`](../internal/client/transport.go). It owns
  cache-slot admission, optional compression, bearer/state/identity/User-Agent
  headers, the per-attempt stall watchdog, request-body activity accounting,
  redirect policy, expected-status validation, bounded response reading,
  transport-error conversion, body closure, and slot/watchdog release.
- Operation differences are now explicit fields of `attemptSpec`: method, path,
  content type, request body, caller headers, compression eligibility, cache-slot
  admission, User-Agent, accepted statuses, response bound/error, transport-error
  context, and optional statistics counters.
- Redirect refusal remains installed once in `New` and applies to every attempt.
  Responses are fully read and closed before execution returns, so no caller can
  retain a slot or watchdog accidentally. `releaseBody.Close` releases exactly
  once even if called repeatedly.
- Retry policy remains above individual attempts in
  [`internal/client/retry.go`](../internal/client/retry.go). Upload re-inventory
  after an ambiguous batch failure is unchanged. Provider forwarding is still not
  retried, and no generic retry was added around provider generation.
- Transfer statistics retain their existing definitions:
  - `RequestBodyBytesSent` still counts actual bytes written into request bodies,
    after optional gzip encoding, once per attempt.
  - `Requests` still counts attempts, including retries.
  - Discovery, status, ACK, cancel, and response-segment RPCs still pass nil
    counters and therefore do not change request statistics.
  - Uploaded chunk counts/bytes still come from the server's batch result, and
    reused/missing body bytes are still derived at the same points.
- Reorganized the existing package by responsibility:
  - `client.go`: configuration, validation, construction, errors, and value types.
  - `sync.go`: temporary spooling, content-defined chunking, inventory, batching,
    and upload orchestration.
  - `upload.go`: one-batch uploads, upload-budget recovery inventory, and the
    JSON/POST helpers that use cache slots and compression.
  - `transport.go`: one-attempt execution, bounded reads, response errors,
    activity wrappers, and the watchdog.
  - `retry.go`: retry policy, JSON RPC wrapper, and relay discovery.
  - `forward.go`, `download.go`, `controls.go`: response resumption, checkpointed
    downloads, and the durable cancellation outbox, as before.
- Removed the obsolete `path != "/v1/forward"` cache-slot bypass from the client
  transport. A repository search confirmed no client caller or current test uses
  that path; the server's legacy forwarding route and its tests remain intact.
  The client already submits only through `/v2/*` with no legacy fallback.

## Regression entry points

- `internal/client/transport_test.go`:
  - `TestAttemptSuccessReleasesSlotAndClosesBody`
  - `TestAttemptMalformedAndOversizedResponsesReleaseResources`
  - `TestAttemptCancellationTimeoutAndReadFailureReleaseResources`
  - `TestReleaseBodyIsIdempotent`
  - `TestAttemptPoliciesExpressCompressionAndStatistics`
- Existing recovery and transfer gates still cover lost submission ACKs, response
  resumption at the same offset, upload re-inventory, cancellation outboxes,
  identity pinning, no-overwrite downloads, and proxy refusal: `client_test.go` and
  `recovery_test.go`.

## Offline verification ledger

All commands below passed after implementation. No dependencies were added and no
private configuration, credentials, relay store, deployment, or live service was
inspected or changed.

| Command | Result |
| --- | --- |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -count=1 ./...` | Pass; installed-OpenCode opt-in remains skipped |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go vet ./...` | Pass |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -trimpath -o .runtime/refactor-phase2/deltarelay ./cmd/deltarelay` | Pass; isolated new binary, not `bin/deltarelay` |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase2/deltarelay" python3 -B -m unittest discover -v -s deploy -p 'test_*.py'` | 106 passed, no skips |
| `pnpm check` | Pass |
| `pnpm test` | 104 passed |
| `pnpm build` | Pass; static Astro output |
| `git diff --check` | Pass |

Performance was not re-benchmarked: the same request-body byte counters, HTTP
methods, compression decision rules, and concurrency limits are used. Phases 3–8
have not started.
