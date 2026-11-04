# Shared contract corpus

All values are synthetic. No tokens, private profiles, provider accounts, or live
endpoints were sampled. Dates and IDs are fixed so tests do not depend on clocks.

| Fixtures | Producer / consumer checks |
| --- | --- |
| `dashboard-*.json` | Go dashboard/history/transfer serialization; TypeScript `isSnapshot` |
| `supervisor-*.json`, `system-*.json` | Python supervisor snapshot; Go validation, enrichment, and serialization; TypeScript `isSystemStatus` and action routing |
| `provider-*.json` | Python executable-provider response consumer and bundled-provider request consumer; published-schema field/enum/limit parity |
| `fingerprints.json` | Byte-exact JSON and SHA-256 goldens, checked against actual persisted request claims |

The `*-cases.json` manifests select a base `fixture` (or the suite's default), a
`valid` result, and named mutations. `changes` uses dot-separated object fields
and numeric array indices. A change either sets `value`, removes a field with
`remove: true`, or replaces an array with `copies` deep copies of its first item.
The latter keeps over-limit fixtures readable. Go's loader lives here and is
imported **only by tests**; Python and TypeScript load these same JSON files.

For system cases, `boundary: "both"` exercises the supervisor consumer as well as
the browser validator. `supervisor_fixture` selects the raw supervisor shape when
it differs from the browser-enriched `fixture`. Browser-only nonce/auth cases use
`boundary: "system"`. Provider cases select `request` or `response`, and response
cases carry a `method` and, where applicable, an expected fixed `error` code.

Active contract distinctions:

- Dashboard/history stay v1; relay health uses v2 or zero/empty values when no
  discovery result is available. Running requests legitimately have zero transfer
  counters and an empty hash. Client cancellations are a separate `cancelled`
  counter in global/session totals and traffic buckets; rebuild the gateway and
  dashboard together when upgrading because the browser validator requires it.
- `history.traffic` is required. Hourly and daily bucket arrays must be strictly
  ordered and within their declared retention. Missing aggregates are rejected;
  neither Go nor the browser reconstructs them from old request entries.
- `inspection` is optional because capture can be disabled. It appears only when
  capture is enabled (the CLI default).
  `recent_requests[].capture_id`
  is also optional; an absent ID means content was not retained, not that it was
  empty.
- Only current supervisor status is accepted, with `remote`, independent internet
  probe fields, and version 2. Unsupported versions fail validation.
- Counters are nonnegative integers. Encoded upload overhead can exceed raw body
  bytes; negative **calculated savings** are valid and remain separately tested.
- The provider schema is not a runtime dependency. Tests extend the existing
  schema parity checks; runtime also enforces URL/port agreement and private-file
  policies. The float-token version case characterizes Python's existing strict
  integer-token check (`1.0` is rejected even though JSON Schema treats it as an
  integral numeric value).
- Fingerprint `representation` is a literal string: do not reformat or regenerate
  it merely to make a changed hash pass. Field capitalization/order, header
  cleaning, escaping, and hashing are durable replay-protection requirements.

Run from the repository root with existing offline dependencies:

```sh
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go test -race ./...
python3 -B -m unittest discover -s deploy -p 'test_*.py'
pnpm check
pnpm test
```

`make verify` runs the complete offline matrix, including browser DOM smoke tests.
See [the architecture guide](../../docs/ARCHITECTURE.md#defaults-and-verification)
for real-binary recovery checks.
