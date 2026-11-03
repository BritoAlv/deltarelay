# Refactor Phase 3 — modular supervision and state ownership

**Completed:** 2026-11-03. Phase 1/2 contracts and client transport are unchanged.
This phase reorganizes `deploy/` supervision only: no relay, provider, gateway,
dashboard, protocol, storage, or configuration compatibility behavior changed.

## Delivered

- Added the importable [`deploy/supervision/`](../deploy/supervision/) package with
  cohesive modules instead of one runtime file:
  - `config.py`: component names/labels, endpoint and command validation,
    legacy/Codespace compatibility validation, and the existing Codespace
    profile adapter.
  - `state.py`: the single owner of observable supervisor state, atomic settings
    publication, immutable snapshot copies, and private JSON save helpers.
  - `process.py`: process identity/PID-birth checks, adoption, launch, stop,
    restart, log ownership, process-group signalling, and component state
    publication.
  - `probes.py`: authenticated relay discovery plus the independent internet
    probe, with the existing bounded timeouts and TLS/error classification.
  - `recovery.py`: recovery attempts/backoff and independent provider retry
    timing, with injected wall/monotonic clocks.
  - `control.py`: the Unix-socket status/settings/action API, its private client
    helper, and executable entry point.
  - `launcher.py`: offline build/start composition used by the launcher script.
  - `supervisor.py`: orchestration of the collaborators, manual actions,
    automatic ticks, and shutdown waiting.
- Kept [`deploy/supervisor.py`](../deploy/supervisor.py) as the executable
  compatibility entry point. It re-exports the names private launchers and
  existing tests import, and delegates to the package. `start_supervisor.py`
  is now argument parsing around the package launcher; its existing
  `codespace_config`, `control_request`, and `controller_status` names remain
  importable. Provider executable paths, `startup.sh`, `recover_codespace.py`,
  and `recover_relay.py` were not moved. `recover_relay.py` remains
  self-contained for stdin execution on a remote host.
- Defined one shared-state policy:
  - `SupervisorState` owns settings, component states, recovery status, relay,
    host, internet, provider metadata, and dashboard enablement under one
    re-entrant lock.
  - Snapshots are built entirely under that lock and return copies of every
    nested mutable value, so a caller cannot mutate live state or retain a
    partially updated object.
  - Slow work is outside the state lock. Settings persistence and fsync happen
    before the short publish; probe, process, and provider calls run without
    holding it.
  - Recovery timing lives in a separate lock-protected `RecoveryPolicy`, so a
    settings update, manual action, and automatic tick cannot race the same
    attempt/backoff counters.
  - Process bookkeeping remains serialized by the existing operation lock;
    `ProcessManager` owns `children`/`identities` and still rechecks PID birth
    immediately before signalling.
- Added constructor injection points at real boundaries: monotonic/wall clocks,
  relay/internet probes, process manager, recovery policy, and command runner.
  Existing callers use defaults, so the private configuration and executable
  paths are unchanged.
- Preserved the operational ordering that matters for safety:
  - recovery suppression is still saved before a remote stop and remains saved
    after a failed stop;
  - permanent authentication/TLS/identity/protocol failures still block
    automatic repair;
  - tunnel rebuild precedes remote recovery, and a successful provider command
    never substitutes for a verified relay probe;
  - cancellation, wake/stop capability gating, confirmation requirements,
    bounded host waits, and process shutdown waiting are unchanged.

## Regression entry points

- `deploy/test_supervisor.py`:
  - `StateOwnershipTest.test_snapshot_returns_copies_of_all_observable_state`
  - `StateOwnershipTest.test_snapshots_stay_consistent_while_operations_transition`
  - `StateOwnershipTest.test_slow_settings_persistence_does_not_block_snapshots`
  - `StateOwnershipTest.test_failed_settings_persistence_keeps_the_previous_snapshot`
  - `StateOwnershipTest.test_collaborators_are_injectable_at_real_boundaries`
  - `StateOwnershipTest.test_executable_entry_point_imports_away_from_the_repository`
- Existing supervisor tests still cover recovery policy, permanent failures,
  provider/codespace actions, process adoption/ownership, port-owner refusal,
  private permissions, the Unix-socket API, and real local tunnel recovery.
- `deploy/test_contracts.py` still compares the supervisor-produced status to the
  shared fixture; `deploy/test_remote_provider.py` still covers provider metadata,
  capability gating, cancellation, and tunnel ownership.

## Offline verification ledger

All commands below passed after implementation. No dependencies were added and no
private configuration, credentials, relay store, deployed executable, or live
service was inspected or changed. Python tests that need real local processes use
only temporary profiles, owned forwarders, a separately built binary, and mock
providers.

| Command | Result |
| --- | --- |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race -count=1 ./...` | Pass; installed-OpenCode opt-in remains skipped |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go vet ./...` | Pass |
| `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go build -trimpath -o .runtime/refactor-phase3/deltarelay ./cmd/deltarelay` | Pass; isolated new binary, not `bin/deltarelay` |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, 3 real-binary opt-in skips |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase3/deltarelay" python3 -B -m unittest discover -v -s deploy -p 'test_*.py'` | 113 passed, no skips |
| `pnpm check` | Pass |
| `pnpm test` | 104 passed |
| `pnpm build` | Pass; static Astro output |
| `git diff --check` | Pass |

Phases 4–8 have not started. In particular, provider-job orchestration remains
inside `internal/server`, filesystem durability primitives are not consolidated,
telemetry persistence still runs on the request path, and browser DOM tests are
not present.
