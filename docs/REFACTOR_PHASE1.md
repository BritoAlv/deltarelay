# Refactor Phase 1 — contracts and semantic ownership

**Completed:** 2026-11-01. Phase 0's existing working-tree changes were preserved.
This phase does not change relay storage layouts, fingerprints, supported protocol
versions, CLI defaults, retry behavior, provider dispatch, or telemetry persistence.

## Delivered

- Added the sanitized, shared [`testdata/contracts/`](../testdata/contracts/) corpus
  with current/offline dashboard snapshots, current/unmanaged/legacy system status,
  provider request/response cases, and byte-exact fingerprint goldens. The corpus
  README explains the mutation format and each language's checks.
- TypeScript now checks every required session and transfer field, optional-field
  types, nonnegative integer counters, bounded histories/components/capabilities,
  and RFC3339 calendar-valid timestamps. It no longer treats date-only or rollover
  dates as wire timestamps. Legitimate zero/empty outage observations and negative
  calculated savings remain supported.
- Go validates complete supervisor status before enriching it with browser-only
  nonce/auth metadata. Missing/null fields, invalid timestamps/counters, unsupported
  versions, invalid remote metadata, trailing objects, and oversized responses
  remain unavailable instead of becoming manufactured zero-valued managed state.
  Unknown fields are still stripped rather than forwarded.
- Legacy normalization stays at the Go supervisor boundary. Both v1 forms retain
  version 1 and route actions to `codespace`; v2 routes to `remote`. A legacy
  supervisor with no independent internet probe yields `unknown`/`null`.
- Python tests exercise its actual supervisor snapshot and both provider-contract
  directions using the same fixtures, with fake executable I/O and temporary
  configuration only. Published-schema checks extend the existing field/enum/limit
  parity approach without a schema engine or code generation. Bundled providers
  now reject NUL-containing configuration paths as `invalid_request` **before**
  file access, matching the already-published request constraint.
- `protocol.ValidRequestID` owns the unchanged 16–128 character ASCII ID rule;
  all former `upstream.ValidRequestID` callers migrated. Boundary lengths, every
  ASCII character, and non-ASCII rejection have explicit regression coverage.
- `internal/transfer.Stats` owns the unchanged statistics value/JSON fields.
  Telemetry and gateway result values use it directly. `client.Stats` remains a
  temporary alias for source compatibility. `go list` confirms telemetry depends
  on `transfer`, not the client transport, and `transfer` has no imports.
- Fingerprint construction was **not** extracted or changed. Goldens freeze
  capitalized `Target,Headers,Hash,Size`, field order, JSON escaping, cleaned
  headers/value order/empty lists, decoded content encoding, and SHA-256. Tests
  inspect actual legacy and durable journal claims and durable mailbox records;
  different request IDs, API versions, and chunk layouts retain the same digest.

## Regression entry points

- `internal/gateway/contracts_test.go`: `TestDashboardSerializationMatchesSharedContracts`.
- `internal/dashboard/contracts_test.go`: serialization/validation, actual
  supervisor-to-browser enrichment, legacy action pass-through, unmanaged fallback,
  and malformed/oversized status refusal.
- `internal/protocol/request_id_test.go`: `TestValidRequestIDCompatibility`.
- `internal/server/fingerprint_test.go`: `TestPersistedRequestFingerprintCompatibility`.
- `deploy/test_contracts.py`: five tests covering supervisor production, shared
  remote metadata rules, provider responses/requests, and schema parity.
- `web/test/contracts.test.ts`: shared valid/invalid cases, exhaustive required-field
  omission and invalid numeric-value checks, legacy routing, and negative savings.

## Offline verification ledger

All commands below passed after implementation. No new dependencies were installed.

| Command | Result |
| --- | --- |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -count=1 ./...` | Pass; installed-OpenCode opt-in remains skipped |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go vet ./...` and `go vet ./testdata/contracts` | Pass; `./...` intentionally skips `testdata`, so the test-only fixture package was vetted explicitly |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -trimpath -o .runtime/refactor-phase1/deltarelay ./cmd/deltarelay` | Pass; isolated new binary, not `bin/deltarelay` |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase1/deltarelay" python3 -B -m unittest discover -v -s deploy -p 'test_*.py'` | 106 passed, no skips, including all three local real-binary opt-ins |
| `pnpm check` | Pass |
| `pnpm test` | 104 passed |
| `pnpm build` | Pass; static Astro output |
| `git diff --check` | Pass |

The local real-binary opt-ins exercise only temporary relays/dashboards, owned
local forwarders, and mock providers. They do not launch Desktop, connect to a real
account, or operate remote compute. No existing private profiles, credentials,
user configuration, relay stores, or deployed executable were inspected/modified.
The installed-OpenCode integration was not enabled; no real-account coverage is
claimed. Performance was not re-benchmarked: request-path accounting/persistence
mechanics remain unchanged. Phases 2–8, including DOM browser tests, are not started.
