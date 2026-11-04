# DeltaRelay protocol

This document is the provider-independent contract between the PC client
(`deltarelay gateway`, `sync`, `request`) and any DeltaRelay server (`deltarelay serve`)
running on a Linux host with private persistent storage. It names no VPS vendor,
cloud API, or VPN. A host qualifies if it can run the binary, keep a private
data directory across restarts, and expose HTTPS or an encrypted SSH forward.

This is the only supported relay API. Routes are unversioned; there are no
aliases, redirects, or alternative forwarding implementations. Deploy the relay,
gateway, plugin, supervisor, and dashboard from the same checkout revision.

## 1. Guarantees

| Guarantee | Meaning |
| --- | --- |
| No silent regeneration | A logical request ID is claimed before provider dispatch. Retrying a submission, reading a response, or ACKing never calls the provider again. |
| Transport resumption | Lost connections are retried with backoff for `--retry-window` (default 1 hour). Uploads resend only missing chunks; downloads resume at the last verified byte offset. |
| Durable responses | Provider bytes are written to checksummed frames and fsynced before they are advertised. A PC may disconnect and reconnect later using only the request ID. |
| Explicit cancellation | Only the `cancel` operation stops generation. A network loss never cancels a request. |
| Honest failure | Uncertain outcomes are reported as `interrupted` with a code. They are never presented as completed. |
| Explicit expiry | Unacknowledged responses expire after the configured retention (default 24 h after completion). Expired responses return `410`. |

Generation can continue while the PC is offline, and the provider may bill for
that work. Cancellation while offline is queued locally and delivered on reconnect;
it is not immediate.

## 2. Identity and pinning

`GET /info` returns a `state_id`: a random SHA-256-shaped value generated once
per data directory and stored in `mailbox/identity.json`. Every stateful request
must send it in `X-DeltaRelay-State-ID`. The server rejects a
mismatch with `409 state_mismatch`.

The client pins the first `state_id` it sees in `relay-state.json` inside its
state directory (default `$XDG_STATE_HOME/deltarelay`, or
`~/.local/state/deltarelay`). A different identity later causes a fail-closed
error. This prevents a replacement VPS with an empty store from being mistaken
for the original and receiving resubmissions. Moving to a new relay requires an
explicit operator action (for example, copying the old data directory). See
section 8.

## 3. Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /info` | Protocol, identity, capabilities, and limits. Requires bearer auth only. |
| `POST /missing` | Return the unique chunks the server lacks. |
| `POST /chunks` | Upload a binary chunk batch (`DRLY0001` framing). |
| `POST /assemble` | Verify a complete body manifest and persist it. |
| `GET` / `HEAD /bodies/{sha256}` | Ranged download of a verified stored body (`Range`, `If-Range`, `ETag`). |
| `PUT /requests/{id}` | Idempotent submission of a logical request (JSON manifest and provider metadata). |
| `GET /requests/{id}[?wait=1]` | Status. `wait=1` long-polls up to 20 s for a change. |
| `GET /requests/{id}/response?offset=N` | Raw provider bytes from decoded offset `N`, one segment (≤256 KiB). `204` after 20 s with no new bytes. |
| `POST /requests/{id}/ack` | Confirm receipt. Body: `{"size":N,"hash":"sha256"}`. Idempotent. |
| `POST /requests/{id}/cancel` | Explicit, durable cancellation. Also valid before submission. |

Every JSON body is decoded strictly (`DisallowUnknownFields`, single object).
Discovery and submission use `version: 2`; manifests use `version: 1` and chunk
batches use `application/vnd.deltarelay.chunks.v1`. These identify the active
formats, not alternative APIs. Their bytes, persisted fingerprints, relay
identity, journal claims, and mailbox records remain unchanged by URL cleanup.

### Request states

```text
accepted -> running -> completed | failed | cancelled | interrupted
```

- `accepted`: claimed durably; provider not yet confirmed.
- `running`: provider job in progress; headers may be available.
- `completed`: all bytes stored; `size`, `hash` and `status` are final.
- `failed`: provider or validation error before a complete answer.
- `cancelled`: explicit cancellation; no further generation.
- `interrupted`: the server stopped, crashed, or hit its runtime limit. Whether
  the provider completed is unknown. Never automatically resubmitted.

Error codes for failures include `provider_stream_interrupted`,
`provider_idle_timeout`, `job_deadline_or_shutdown`, `response_storage_full`,
`server_restarted_dispatch_unknown`, `persistence_failed`, and `client_cancelled`.

### Error envelope

```json
{"error":"human-readable message","code":"machine_code"}
```

Important codes: `state_mismatch` (409), `request_conflict` (409, same ID with
different content), `request_not_found` (404), `response_gone` (410),
`storage_full` (507), `response_integrity` (422), `mailbox_storage` (500).

## 4. Submission semantics

`PUT /requests/{id}` is the only operation that can dispatch to a provider.

- New ID: verify the manifest, reconstruct the body, claim the ID in the journal
  and mailbox, then respond `202` with the record.
- Same ID, same fingerprint (target, headers, body hash, size): respond `200`
  with the existing record. No new dispatch.
- Same ID, different fingerprint: `409 request_conflict`. Nothing is dispatched.
- Cancelled or interrupted ID: the existing record is returned; it is never
  redispatched.

The fingerprint excludes the relay bearer token and excludes local credentials.
Provider `Authorization` headers are stored only in the in-memory job and are
never written to the mailbox record.

## 5. Response delivery

1. The job reads the provider stream and appends checksummed frames
   (`uint32 length || SHA-256 || bytes`, up to 32 KiB each).
2. Each append is fsynced and then recorded in the request record. Only the
   committed prefix is advertised through `bytes`.
3. A client requests `GET .../response?offset=N`. The server returns verified
   bytes with `X-DeltaRelay-Offset` and `X-DeltaRelay-Segment-Hash`; the client
   checks both and the state ID before using the segment.
4. When the record reaches `completed`, the client verifies total length and
   SHA-256 against `bytes` and `hash`.
5. The client publishes the output file atomically (hard link, never overwriting
   an existing file) and only then sends `ack`.
6. `ack` removes the payload immediately. The tombstone (ID, fingerprint, state)
   stays, so dispatch protection survives.

Interrupted streaming is distinct from completed streaming: a truncated provider
stream ends in `interrupted` or `failed`, never `completed`.

## 6. Retention and limits

| Setting | Default | Notes |
| --- | --- | --- |
| `serve --response-retention` | 24 h | Applies after completion, failure, or cancellation. |
| `serve --max-response-bytes` | 256 MiB | Per request. Exceeding it fails the job; no partial success. |
| `serve --max-response-storage-bytes` | 4 GiB | Aggregate payload storage. Full storage refuses new submissions (`507`). |
| `serve --max-runtime` | 2 h | Maximum provider job lifetime, independent of PC connectivity. |
| `serve --max-journal-records` | 100 000 | Tombstones and claims. Full journal fails closed. |
| `serve --idle-timeout` | 15 min | Gap between provider bytes before the job is interrupted. |

Tombstones are never automatically removed while any client could still
replay an ID. Payload expiry is explicit: `response_gone` and `expired: true`.

The server exposes all active limits in `GET /info`, including
`retention_seconds`, `max_runtime_seconds`, and `response_storage_bytes`.

## 7. Client recovery

- Automatic retries (`--retry-window`, default 1 h; `--retry-min` 1 s; `--retry-max`
  30 s, exponential with jitter; `Retry-After` honored) apply to connection
  failures, timeouts, `408`, `429`, `502`, `503`, and `504`.
- Permanent failures (`401`, `403`, `404`, `409`, `410`, `422`, certificate
  errors) are never retried.
- A stall watchdog (`--stall-timeout`, default 2 min) cancels a silent RPC attempt
  without deciding the whole request has failed.
- Upload batches shrink after a failure (`--batch-bytes` default 256 KiB,
  halved on retry). After an ambiguous batch, the client re-inventories with
  `/missing` and sends only what is missing.
- Downloads use a private `.deltarelay-*.part` file plus a checkpoint binding it
  to the destination, request ID, and state identity. A later run resumes from
  the checkpoint length. Existing destination files are never overwritten.
- Retry never wraps a provider call. Automatic link recovery cannot cause a second
  generation.

## 8. Migrating relay state

Replacing a relay requires copying its data directory, including `identity.json`,
`records/`, `responses/`, and `chunks/`. A new server with a fresh identity is a
different relay. Pinned clients will refuse it. To intentionally accept a new
identity, remove `relay-state.json` on the PC after confirming that all pending
requests were acknowledged or are no longer needed. Removing it is an explicit
decision: any unfinished generation on the old relay becomes unrecoverable from
the new one.

## 9. Security boundaries

- Authenticated by a bearer token for every route.
- Provider credentials appear only in the in-memory job; they are not logged and
  not persisted in mailbox records.
- Response payloads and cache are plaintext with private filesystem permissions.
  Use encrypted storage if your threat model requires it.
- Only one server process may own a data directory (`.server.lock`).
- No redirects are followed. Upstreams come from the explicit allowlist.
