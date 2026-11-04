# Refactor Phase 7 — feature-oriented dashboard with browser regressions

**Completed:** 2026-11-03. This phase reorganizes the existing static Astro
dashboard and adds DOM-level regression tests. It does not change the gateway API,
supervisor protocol, persisted data, control actions, measurement definitions, or
dashboard authorization rules.

## Feature boundaries

| Feature | Controller | Responsibility |
| --- | --- | --- |
| Summary and connection state | `web/src/scripts/features/overview.ts` | Global totals, connection badge, notices, retention text, pause/refresh actions |
| Traffic and reuse | `web/src/scripts/features/traffic.ts` | Time-range chart, accessible SVG labels, cache-reuse ring |
| Sessions | `web/src/scripts/features/sessions.ts` | Filtering, pagination, detail dialog, CSV export |
| Relay health | `web/src/scripts/features/health.ts` | Gateway, VPS, storage, and provider observation cards |
| Supervisor controls | `web/src/scripts/features/controls.ts` | Recovery settings, remote power, authentication, service/Desktop actions |

`web/src/scripts/dashboard.ts` and `web/src/scripts/system.ts` are composition
roots with explicit `start…()` interfaces and a `destroy()` lifecycle.
`web/src/scripts/main.ts` starts both independent applications. Each feature
receives its own root element and resolves required elements once at mount time
through `web/src/scripts/dom.ts`; render paths do not use unscoped
`document.getElementById()` lookups.

Matching Astro components now own the static markup:
`Sidebar`, `OverviewSection`, `StatsGrid`, `TrafficPanel`, `SystemControls`,
`SystemHealth`, `SessionsSection`, and `SessionDialog`.
Pure formatting and calculations remain in `web/src/lib/`.

## Freshness and polling

- `web/src/lib/state.ts` defines a typed `SystemObservation` channel containing
  the connection state, supervisor collection/receipt times, stale flag, and
  managed flag. It replaces the previous `deltarelay:system` DOM `CustomEvent`.
- A connection observation is treated as `unknown` when it is stale or older than
  **15 seconds** (three five-second supervisor polls). Relay notices and health
  cards cannot present an old observation as a live connection.
- `web/src/lib/polling.ts` is the single polling implementation. The dashboard
  polls diagnostics every 10 seconds and supervisor controls poll every 5 seconds
  independently. Pausing diagnostics still re-renders local relative times on its
  cadence but performs no fetch, and never pauses control or authentication
  refresh. Visibility handling is shared.
- Controls are disabled unless the last supervisor response is fresh, managed,
  not busy, and the action is supported. These checks are unchanged; the browser
  tests now exercise them through the rendered DOM.

## Preserved guarantees

- All diagnostics are validated by the existing complete snapshot/system guards
  before rendering.
- Diagnostics text and IDs remain escaped; chart SVG text is escaped; CSV text
  fields retain spreadsheet-formula protection.
- Control requests still use same-origin `POST`, the existing CSRF nonce header,
  confirmed destructive actions, and existing action targets/capability checks.
- Desktop launch remains a supervisor action with fresh-status and duplicate
  instance protection. Browser tests mock the API and never launch Desktop.
- Theme picking, CSP-compatible startup, chart accessibility, and responsive
  markup are unchanged.

## Browser smoke tests

`web/test/browser.ts` renders the real static `web/dist/index.html` into
[happy-dom](https://github.com/capricorn86/happy-dom) with JavaScript file
execution, CSS loading, and computed styles disabled. A mocked `fetch` serves only
the same-origin dashboard, system, and control endpoints. The tool is a pinned,
test-only dev dependency; it is not shipped in the static bundle and the offline
install workflow still uses the committed lockfile and local pnpm store.

`web/test/browser.test.ts` covers:

- Initial loading with no fabricated data.
- Successful refresh of totals, chart, sessions, and relay health.
- Timeout/stale behavior that retains the last snapshot but marks it stale.
- Session filtering, pagination, detail dialog, and CSV formula protection.
- Gateway failure leaving independent supervisor controls live and enabled.
- Desktop duplicate-launch prevention and the protected same-origin action shape.
- Stale/unmanaged status disabling all service controls.
- Paused diagnostics while supervisor refresh and controls continue.

Focused command (builds the static page first):

```sh
pnpm test:browser        # or: make dashboard-browser-test
```

## Verification ledger

- Dashboard type checking, static build, and **114 tests** passed, including the
  **10 browser smoke tests** and the existing contract, metrics, schema, and theme
  suites.
- `go test -race ./...`, `go vet ./...`, and the trimmed Go build passed.
- All **8** OpenCode plugin tests passed.
- Python supervision/recovery passed **113 tests** with the three isolated
  real-binary opt-ins enabled via `DELTARELAY_RECOVERY_TEST_BINARY`.
- `pnpm install --offline --frozen-lockfile --trust-lockfile` succeeds from the
  committed lockfile and configured pnpm store.
- `git diff --check` passed. No private configuration, credential, relay state,
  live deployment, or real Desktop/remote operation was accessed or started.
