# Refactor Phase 6 — nonblocking optional telemetry persistence

**Completed:** 2026-11-03. Phases 1–5 contracts, client transport, Python
supervision, provider-job orchestration, and filesystem primitives are
unchanged. This phase moves only optional statistics-file I/O off the request
path. It does not change any wire format, stored record, fingerprint, relay
identity, mailbox durability rule, or dispatch claim.

## Persistence policy

The policy was fixed before the implementation:

| Property | Policy |
| --- | --- |
| Flush interval | At most one rewrite per second. The first dirty update after a quiet period schedules one write; further updates in that window coalesce. |
| Crash-loss window | Abrupt termination can lose the retained statistics changes from roughly the last flush interval plus the in-progress write. Provider responses, dispatch claims, cancellations, and ACKs are separate durable data and are unaffected. |
| Retry | A failed write sets `persistence_error`, keeps every in-memory observation, and retries the newest snapshot on the next interval. There is no partial or older-snapshot retry. |
| Shutdown | `Close()` requests one final flush and waits at most five seconds. The single-writer lock is released by the worker after that flush, including after a failed flush. |
| Ordering | One background worker is the only steader of the file. It writes monotonically increasing revision snapshots, so an older snapshot cannot overwrite a newer one after an error, a slow write, or concurrent accounting. |
| Scope | Only the optional `--stats-file` history is asynchronous. The response mailbox and dispatch journal retain their synchronous durability semantics. |

`Begin()` and `Finish()` still validate labels, apply bounded retention and
eviction, update global and per-session totals, and return synchronously. They
only replace the former inline `fsx.WriteJSON` with a buffered wake signal.

## Delivered

- [`internal/telemetry/telemetry.go`](../internal/telemetry/telemetry.go):
  - Added one lazily started worker per persistent recorder, with buffered
    wake/stop channels and a debounce timer. No goroutine is created per request
    and no update is dropped during coalescing.
  - Added a monotonic revision and a `written` watermark. The worker snapshots
    the newest retained state under the recorder lock, encodes/writes outside
    the lock, and advances the watermark only after a successful write.
  - Moved the former in-request `save()` call out of `Begin`/`Finish`. The
    in-memory result is still visible immediately through `Snapshot()`.
  - Kept startup validation, private/regular/size checks, `O_NOFOLLOW`,
    single-writer `flock`, restart normalization of formerly running requests,
    bounded history, eviction counters, and the `persistence_error` field.
  - Made `Close()` idempotent. A persistent recorder waits a bounded time for
    the worker's final flush; the worker owns releasing the file lock, so a
    timed-out shutdown cannot publish the lock while a write is still running.
  - Kept a memory-only recorder (`path == ""`) free of both a worker and a lock.
- [`docs/DASHBOARD.md`](../docs/DASHBOARD.md): documented the one-second
  background cadence, the approximate crash-loss window, retry visibility, the
  five-second final flush, and the distinction from durable mailbox/journal
  data.
- Added injected-writer tests in
  [`internal/telemetry/telemetry_test.go`](../internal/telemetry/telemetry_test.go).
  Existing persistence, restart, retention, corruption, symlink, and label
  tests continue to pass.

No gateway handler or dashboard structure changed: `Gateway.Close` still calls
`Recorder.Close`, and the dashboard still reads a synchronous `Snapshot()`.

## Regression entry points

New tests:

- `TestSlowPersistenceDoesNotDelayAccounting` — a writer blocked indefinitely
  on the worker does not delay `Begin`, `Finish`, or `Snapshot`.
- `TestPersistenceFailureIsRetriedWithTheNewestSnapshot` — an injected failure
  becomes visible through `Snapshot().PersistenceError`; a later successful
  write clears it and persists the newest totals.
- `TestOlderSnapshotsCannotOverwriteNewerOnes` — updates arriving while an older
  write is blocked are coalesced, recorded writes never go backwards, and the
  newest snapshot is written last.
- `TestCloseFlushesFinalSnapshotAndIsIdempotent` — `Close` flushes without a
  periodic interval, repeated `Close` does not hang, and `Begin` is refused
  afterwards.
- `TestFinalFlushFailureDoesNotHangClose` — a slow failing final write is
  bounded by the shutdown timeout, and the failure remains visible.
- `TestMemoryRecorderIgnoresPersistenceAndClosesRepeatedly` — the memory-only
  recorder retains its behavior.
- `TestPersistenceFailureDoesNotLoseLiveStatistics` — converted from an immediate
  assertion to wait for the asynchronous failure notification.

Preserved coverage: `TestAggregationAndConcurrentRequests`,
`TestPrivatePersistenceAndRestart`,
`TestBoundedRetentionPreservesGlobalTotalsAndActiveRequests`,
`TestInvalidLabelsAndKindsAreNotRecorded`,
`TestRefusesUnsafeOrCorruptHistory`.

## Performance comparison

The Phase 0 benchmark command and host were reused exactly:

```sh
make baseline-benchmark
# go test ./internal/server -run '^$' -bench '^BenchmarkGatewayRequestStartup$' \
#   -benchtime=50x -count=3 -cpu=2 -benchmem
```

Medians of three 50-operation means; `gateway-ready-ns/op` ends at `OnStart`,
after `telemetry.Begin` and before forwarding. Lower is better.

| Telemetry persistence | Parallel mailbox | Phase 0 ready | Phase 6 ready | Change |
| --- | --- | ---: | ---: | ---: |
| Off (memory) | No | 5.662 µs | 5.049 µs | ~0.6 µs faster |
| Off (memory) | Yes | 6.649 µs | 6.139 µs | ~0.5 µs faster |
| On (file) | No | 942.507 µs | 5.065 µs | ~187× faster |
| On (file) | Yes | 1,281.810 µs | 10.855 µs | ~118× faster |

The persistent, mailbox-active case includes the background worker competing for
the recorder lock and filesystem attention; it remains single-digit to low
double-digit microseconds and is no longer dominated by a synchronous fsync.
Full-operation and provider-start times remain in the same few-millisecond
range as Phase 0 (about 6.6–8.4 ms full operation), so the change targets
request-start latency rather than provider execution.

## Offline verification ledger

All commands below passed after implementation. No dependency was added and no
private configuration, credential, relay store, deployed executable, or live
service was inspected or changed. The binary was built separately under
`.runtime/refactor-phase6/`.

| Command | Result |
| --- | --- |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -count=1 ./...` | Pass; installed-OpenCode opt-in remains skipped |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go vet ./...` | Pass |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -trimpath -o .runtime/refactor-phase6/deltarelay ./cmd/deltarelay` | Pass; isolated new binary, not `bin/deltarelay` |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, 3 real-binary opt-in skips |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase6/deltarelay" python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, no skips |
| `pnpm check` | Pass |
| `pnpm test` | 104 passed |
| `pnpm build` | Pass; static Astro output |
| `make baseline-benchmark` | Pass; comparison above |
| `git diff --check` | Pass |

Phases 7–8 have not started. Dashboard feature/browser work and CLI
deduplication/documentation work remain outstanding. Mailbox and journal
durability were not changed.
