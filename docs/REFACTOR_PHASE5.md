# Refactor Phase 5 — shared filesystem primitives without merged guarantees

**Completed:** 2026-11-03. Phases 1–4 contracts, client transport, Python
supervision, and provider-job orchestration are unchanged. This phase extracts
only mechanical filesystem repetition: no storage layout, replay claim,
overwrite policy, private-reader rule, lock scope, wire format, or configuration
behavior changed.

## Delivered

- Added [`internal/fsx`](../internal/fsx/fsx.go), a small internal package with
  policy-neutral mechanics:
  - `SyncDir` opens and fsyncs one directory.
  - `SyncDirChain` fsyncs a directory and up to a requested number of ancestors,
    used when a content-addressed write may have created shard directories.
  - `Replace` writes a temporary file in the destination directory, fsyncs and
    closes it, renames it over the destination, and removes the temporary file on
    failure. It creates no parent directories and does not sync a directory.
  - `WriteJSON` builds on `Replace` but also fsyncs the immediate directory. This
    is the shared metadata-replacement mechanic.
  - `CreateExclusive` opens with `O_CREATE|O_EXCL`, writes, and fsyncs the file. It
    deliberately retains a partially written file and returns whether the
    exclusive open succeeded.
- Replaced the duplicated metadata writer in `internal/client`, `internal/mailbox`,
  and `internal/telemetry` with `fsx.WriteJSON`. Removed
  `internal/mailbox/disk.go`.
- Replaced local directory-sync helpers in `internal/client`, `internal/mailbox`,
  `internal/journal`, `internal/store`, and `internal/telemetry` with
  `fsx.SyncDir`.
- Kept journal claims on an exclusive-creation path: `journal.Claim` now uses
  `fsx.CreateExclusive` and increments its in-memory count whenever the exclusive
  open succeeded, including when a later write or fsync fails. An incomplete
  claim marker is still never removed.
- Kept content-addressed persistence distinct: `store.atomicWrite` still creates
  the shard directory with mode `0700`, performs the atomic replacement, and then
  syncs three directory levels. `store.persist` still accounts the resulting file
  size even if a later directory sync fails.
- Kept verified download publication distinct: `download.publish` still uses a
  hard link so an existing user file is never replaced, then syncs the
  destination directory and removes the private partial and checkpoint.
- Kept private readers explicit per caller. `client.privateRead` (4096/8192-byte
  ceilings), `dashboard.privateFile` (64 KiB plus ownership check), and telemetry
  history loading (8 MiB plus single-writer lock) were not generalized, so no
  caller gained or lost a permission, ownership, symlink, or size rule.
- Kept the CLI token writer's exclusive creation and file sync, now through
  `fsx.CreateExclusive`; it still does not create parent directories or sync a
  directory.

## Semantics inventory

The table records the behavior that had to survive the extraction. “Replace”
means rename over an existing entry; “exclusive” means creation fails if the
entry already exists.

| Operation | Sites | Replace | Exclusive | No overwrite | Mode / symlink | Directory sync |
| --- | --- | --- | --- | --- | --- | --- |
| Relay pin and cancellation checkpoints | `client/controls.go` | Yes | No | No | Temp `0600`; destination entry replaced, symlink not followed | Immediate |
| Partial-download checkpoint metadata | `client/download.go` | Yes | No | No | Temp `0600`; checkpoint read uses `O_NOFOLLOW` | Immediate |
| Verified download publication | `client/download.go` | No | No | Yes, hard link | Partial `0600`; existing output untouched | After link and after cleanup |
| Mailbox identity and records | `mailbox/mailbox.go` | Yes | No | No | Temp `0600` | Immediate |
| Response frame append | `mailbox/mailbox.go` | No (append) | No | N/A | `0600` | Immediate on first frame only |
| Content-addressed chunks and bodies | `store/store.go` | Yes | No | No | Parent `0700`; temp `0600` | Immediate plus two ancestors |
| New store ancestors | `store/store.go` | N/A | No | N/A | `0700` | Parent of each created ancestor |
| Journal dispatch claim | `journal/journal.go` | No | Yes | Yes | `0600`; partial marker retained | Immediate after successful file write |
| Statistics history | `telemetry/telemetry.go` | Yes | No | No | Temp `0600`; history read uses `O_NOFOLLOW` | Immediate |
| Dashboard service registration | `dashboard/auth.go` | No (read only) | No | N/A | `O_NOFOLLOW`, private, owner, 64 KiB | None |
| Gateway token file | `cmd/deltarelay/gateway.go` | No | Yes | Yes | `0600` | None |
| Upload spool and anonymous reconstruction | `client/sync.go`, `store/store.go` | N/A | No | N/A | Temp then unlink | None |

Deliberately not shared:

- Private reads, because the callers enforce different size limits and the
  dashboard additionally requires file ownership.
- Partial-download ownership (`flock`, `O_NOFOLLOW`) and resume offsets.
- Mailbox frame appends and crash-tail truncation.
- Token/identity/server locks, whose blocking and non-blocking semantics differ.
- Hard-link publication, because its no-overwrite requirement is specific to
  downloads and must remain visible at the site.
- Unknown-content-address shard creation and multi-level syncing.

## Files

- New: `internal/fsx/fsx.go`, `internal/fsx/fsx_test.go`.
- Reduced: `internal/client/controls.go`, `internal/client/download.go`,
  `internal/journal/journal.go`, `internal/mailbox/mailbox.go`,
  `internal/store/store.go`, `internal/telemetry/telemetry.go`,
  `cmd/deltarelay/gateway.go`.
- Removed: `internal/mailbox/disk.go`.
- Test-only updates: `internal/store/store_test.go`,
  `internal/journal/journal_test.go`.

## Regression entry points

- `internal/fsx/fsx_test.go`:
  - `TestReplaceAtomicallyReplacesMetadata`
  - `TestReplaceWriteFailureKeepsOldMetadataAndCleansTemporaryFile`
  - `TestReplaceRenameFailureKeepsDestinationAndCleansTemporaryFile`
  - `TestReplaceDoesNotFollowExistingSymlink`
  - `TestCreateExclusiveRetainsUncertainClaim`
  - `TestCreateExclusiveRefusesExistingSymlink`
  - `TestSyncDirectoryChainAndInvalidDepth`
- `internal/store/store_test.go`:
  - `TestUsageAccountingSurvivesPostRenameSyncFailure`
- `internal/journal/journal_test.go`:
  - `TestIncompleteClaimMarkerStillBlocksReplay`
- Existing coverage that continues to exercise the preserved policies:
  - `TestRedirectIsNotFollowedAndDownloadNeverOverwrites`
  - `TestBodyDownloadCheckpointSurvivesClientRestart`
  - `TestOfflineCancellationOutboxSurvivesGatewayRestart`
  - `TestChangedRelayStateFailsClosedAcrossClientRestarts`
  - `TestAckAndExpiryTombstonesSurviveRestart`
  - `TestPrivatePersistenceAndRestart`
  - `TestRefusesUnsafeOrCorruptHistory`
  - `TestPersistenceFailureDoesNotLoseLiveStatistics`

## Offline verification ledger

All commands below passed after implementation. No dependency was added and no
private configuration, credential, relay store, deployed executable, or live
service was inspected or changed. The binary was built separately under
`.runtime/refactor-phase5/`.

| Command | Result |
| --- | --- |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -count=1 ./...` | Pass; installed-OpenCode opt-in remains skipped |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go vet ./...` | Pass |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -trimpath -o .runtime/refactor-phase5/deltarelay ./cmd/deltarelay` | Pass; isolated new binary, not `bin/deltarelay` |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, 3 real-binary opt-in skips |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase5/deltarelay" python3 -B -m unittest discover -v -s deploy -p 'test_*.py'` | 113 passed, no skips |
| `pnpm check` | Pass |
| `pnpm test` | 104 passed |
| `pnpm build` | Pass; static Astro output |
| `git diff --check` | Pass |

Phases 6–8 have not started. Telemetry persistence still runs on the request
path, dashboard feature/browser work is outstanding, and CLI
deduplication/documentation work is outstanding.
