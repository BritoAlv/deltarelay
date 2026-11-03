# Refactor Phase 8 — thin CLI, aligned defaults, and migration close-out

**Completed:** 2026-11-03. This phase changes composition and documentation only.
It does not change wire contracts, on-disk formats, fingerprints, relay identity,
provider execution, mailbox durability, or dashboard behavior.

## CLI organization

The executable is now split by responsibility instead of concentrating serve,
transfer, token, and doctor logic in the entry point or gateway command.

| File | Responsibility |
| --- | --- |
| `cmd/deltarelay/main.go` | Signal context, command dispatch, version/help, top-level usage. |
| `cmd/deltarelay/serve.go` | VPS listener, store ownership lock, server composition, TLS selection. |
| `cmd/deltarelay/gateway.go` | Local gateway composition, logging callbacks, loopback validation. |
| `cmd/deltarelay/dashboard.go` | Dashboard listener, static assets, supervisor socket composition. |
| `cmd/deltarelay/transfer.go` | Diagnostic `sync`/`fetch` flags, input/output handling, statistics output. |
| `cmd/deltarelay/request.go` | Durable request inspection/recovery/ACK/cancel actions. |
| `cmd/deltarelay/recovery.go` | Shared retry/recovery flags and default state directory. |
| `cmd/deltarelay/token.go` | Private token-file precedence and `gen-token`. |
| `cmd/deltarelay/doctor.go` | Loopback diagnostic checks. |
| `cmd/deltarelay/defaults.go` | Composition-owned addresses, files, and command-wide timeouts; environment-first flag helper. |
| `cmd/deltarelay/http.go` | One context-driven HTTP listener start/graceful-shutdown helper. |

`runHTTPServer` coordinates `Shutdown`/forced `Close` and maps
`http.ErrServerClosed` to success. TLS selection, listener timeouts, header
limits, startup messages, and component `Close` calls remain explicit at each
call site, so serve, gateway, and dashboard keep their distinct policies.

## Defaults ownership

| Owner | Exported defaults reused by the constructor and CLI |
| --- | --- |
| `internal/protocol` | Body size and wire limits. |
| `internal/client` | Workers, batch bytes, header timeout, retry window/min/max, stall timeout. |
| `internal/server` | Provider concurrency, header/idle timeouts, journal records, job runtime. |
| `internal/mailbox` | Retention, response bytes, aggregate storage, record limit, minimum accepted values. |
| `internal/gateway` | Provider concurrency. |
| `internal/dashboard` | OAuth integration label. |

Composition-only values remain in `cmd/deltarelay/defaults.go`: listen
addresses, default relay/gateway origins, data/assets/stats paths, the 10 GiB
serve cache cap, command-wide transfer timeout, doctor timeout, and the
deliberately shorter 2-minute gateway RPC header timeout. Environment and file
precedence are unchanged:

- Explicit flags override environment-derived defaults, including explicit
  empty strings.
- Gateway/request inherit `DELTARELAY_SERVER`, token-file, and persistent state
  defaults; sync/fetch intentionally do not.
- Serve/sync/fetch do not inherit `DELTARELAY_TOKEN_FILE`.
- An explicit missing or unsafe token file fails closed.
- `--stats-file ''` keeps history in memory only; an empty environment value
  selects the normal file default.
- Constructor zero values still select documented defaults; CLI flags retain
  their early rejection of explicit invalid/zero limits.

The shared `mailbox.MinRetention`, `mailbox.MinStorageBytes`, and exported
default constants remove duplicated literals while preserving early CLI errors.
Constructors remain authoritative for programmatic configuration.

## Documentation and compatibility

- Corrected the README's documented whole-operation timeout from 30 minutes to
  the existing four-hour default.
- Corrected the documented upload batch from 2 MiB to the existing 256 KiB
  default.
- Updated top-level help from “read-only dashboard” to “Local dashboard;
  controls are optional and supervisor-backed”.
- Added [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) with package ownership,
  dependency direction, data/control-plane flows, lifecycle ownership,
  telemetry timing, defaults ownership, and compatibility boundaries.
- Documented the optional telemetry policy in both the architecture guide and
  the existing dashboard guide: synchronous in-memory accounting, one worker
  coalescing writes at about one-second intervals, an approximately one-second
  crash-loss window, visible write errors, and a bounded five-second final
  flush. Provider responses and dispatch claims remain separate durable data.
- Added `make verify` as the aggregate offline matrix. It runs the Go
  build/race/vet checks, plugin tests, Python supervision/recovery tests,
  offline dashboard install, dashboard type/library tests, static build, browser
  smoke tests, and whitespace check. Installed-OpenCode and performance checks
  stay separate opt-ins.
- Removed the temporary `client.Stats` alias. All callers now use
  `internal/transfer.Stats` directly. Python compatibility entry points
  (`deploy/supervisor.py`, `deploy/start_supervisor.py`,
  `deploy/start_dashboard.py`, `deploy/recover_*.py`) and provider executable
  paths remain in place for existing private configurations.

No storage migration was introduced. Chunk format v1, relay API v2, legacy
forwarding v1, remote-provider v1, supervisor v1/v2 normalization, dashboard
statistics v1, fingerprints, mailbox identity/records/frames, journal claims,
client relay pins, checkpoints, and cancellation outboxes are unchanged.

## Performance comparison

The Phase 0 benchmark command and workload were reused without changes:

```sh
make baseline-benchmark
```

Medians of three 50-operation means; `gateway-ready-ns/op` ends at `OnStart`,
after telemetry begin and before forwarding. Lower is better.

| Telemetry persistence | Parallel mailbox | Phase 0 | Phase 6 | Phase 8 |
| --- | --- | ---: | ---: | ---: |
| Off (memory) | No | 5.662 µs | 5.049 µs | 4.346 µs |
| Off (memory) | Yes | 6.649 µs | 6.139 µs | 6.615 µs |
| On (file) | No | 942.507 µs | 5.065 µs | 4.483 µs |
| On (file) | Yes | 1,281.810 µs | 10.855 µs | 6.164 µs |

Full-operation medians remained in the same few-millisecond range as Phase 0
(about 6.37–8.17 ms in these samples). Phase 8 did not touch request-path
accounting, mailbox durability, or provider execution, so no performance change
is claimed beyond run-to-run variation.

## Offline verification ledger

All commands below passed after implementation. No private profile, credential,
live service, remote deployment, or existing relay store was inspected or
changed. The separately built binary is under `.runtime/refactor-phase8/`.

| Command | Result |
| --- | --- |
| `make verify` | Pass; aggregate matrix below |
| `go test -race ./...` | Pass, all Go packages; installed-OpenCode opt-in skipped |
| `go vet ./...` | Pass |
| `go build -trimpath -o bin/deltarelay ./cmd/deltarelay` | Pass; implementation-time build |
| `node --test integration/opencode/*.test.mjs` | 8 passed |
| `python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, 3 real-binary opt-in skips |
| `DELTARELAY_RECOVERY_TEST_BINARY="$PWD/.runtime/refactor-phase8/deltarelay" python3 -B -m unittest discover -s deploy -p 'test_*.py'` | 113 passed, no skips |
| `pnpm install --offline --frozen-lockfile --trust-lockfile` | Pass |
| `pnpm check` | Pass |
| `pnpm test` | 114 passed, including shared contract fixtures |
| `pnpm test:browser` | 10 browser smoke tests passed |
| `pnpm build` | Pass; static Astro output |
| `make baseline-benchmark` | Pass; comparison above |
| `git diff --check` | Pass |

New focused coverage:

- `cmd/deltarelay/http_test.go` verifies start-error propagation and
  context-driven graceful shutdown of the shared listener helper.
- `cmd/deltarelay/help_test.go` verifies the top-level dashboard description
  advertises optional supervisor-backed controls instead of read-only behavior.
- `internal/server/defaults_test.go` verifies constructor normalization and the
  wire-visible limits against the owning package constants, preventing silent
  CLI/constructor/documentation drift.

The previously documented installed-OpenCode integration remains an explicit
opt-in and was not run. No live account or provider was used.
