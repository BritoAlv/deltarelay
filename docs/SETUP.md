# OpenCode Desktop setup

For sanitized implementation and testing history, see [SESSION_LOG.md](SESSION_LOG.md).
This guide is self-contained for a fresh clone; no original developer paths,
private test profiles, or Codespace deployment are required.

This installs the complete path:

```text
OpenCode server on PC → local gateway → HTTPS/SSH delta link → VPS → provider
                     ← live provider response stream ←─────────────┘
```

The Desktop UI, project files, tools, sessions, and account sign-ins stay on the
PC. The plugin intercepts **model API POST requests**, including tool-driven
continuations, titles, summaries/compaction, and transient generation. It does
not proxy web browsing, OAuth login/refresh, MCP, or arbitrary desktop traffic.

The network-heavy components are Go. A small, dependency-free JavaScript plugin
is required for OpenCode V2's plugin API. No OpenCode fork or replacement model
provider is needed. Existing provider headers and resolved OAuth/API credentials
are forwarded for the original API request, without translating model formats.

## Prerequisites and limits

- Linux/POSIX filesystems for the Go services; Go 1.24+ to build. The current
  integration is for OpenCode **V2**, tested with installed V2.1.4 against a mock
  model using a real isolated OpenCode process. It is not a V1 plugin.
- Git and access to this private repository to clone it. See the
  [clone instructions](../README.md#clone-on-a-new-computer); the checkout may
  live anywhere. Run this guide's build commands from its root.
- Node.js 22+ for plugin tests and generating configuration, and a C compiler
  for `go test -race`. No npm dependencies need installing. Make is optional.
- SSH for the recommended tunnel deployment; systemd only if using the optional
  service examples. The Codespace recovery helpers are not needed for this setup.
- An existing working OpenCode provider connection. DeltaRelay does not create
  new provider accounts or sign you in.
- A VPS you trust with your conversation and provider credentials. HTTPS/SSH
  protects the hop, but the VPS necessarily sees plaintext inference requests.
- No live OpenAI/ChatGPT/Go account or remote VPS has been exercised by the
  repository tests. Provider region/IP/account restrictions can still apply.
- One trusted tenant and **one server process per data directory**. Keep public
  exposure off until you have configured TLS and the resource limits yourself.

Do not point Desktop at a remote OpenCode server by accident: the plugin and
local gateway must run next to the OpenCode server making the provider calls.

## 1. Build

From the repository:

```sh
go build -trimpath -o bin/deltarelay ./cmd/deltarelay
go test -race ./...
go vet ./...
node --test integration/opencode/*.test.mjs
```

An opt-in integration test starts your installed OpenCode with private HOME/XDG
directories and fake credentials. It makes no paid model calls, modifies no user
configuration, and verifies that stopping the gateway does not cause bypass:

```sh
DELTARELAY_TEST_OPENCODE=1 go test -v ./internal/gateway -run TestInstalledOpenCodePlugin -count=1
```

For a Linux amd64 VPS:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/deltarelay-linux-amd64 ./cmd/deltarelay
```

Use `GOARCH=arm64` for an ARM VPS. Cross-compile to the architecture you actually
have. There are no external Go modules or required Docker services. `-trimpath`
omits build-machine filesystem paths from the binary; binaries are not committed.

## 2. Prepare private credentials on the PC

Create a private configuration directory. If it already exists, inspect it
before changing permissions or copying over files.

```sh
DELTARELAY_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay"
mkdir -m 700 -p "$DELTARELAY_CONFIG_DIR"
./bin/deltarelay gen-token --output "$DELTARELAY_CONFIG_DIR/relay.token"
./bin/deltarelay gen-token --output "$DELTARELAY_CONFIG_DIR/local.token"
```

These commands do not print token values and refuse to overwrite files.

- `relay.token`: shared **only between the PC gateway and VPS server**.
- `local.token`: authenticates OpenCode to the PC gateway; **do not copy it to
  the VPS**. The plugin reads it directly, so Desktop need not inherit shell
  environment variables.
- Your provider key/OAuth token remains managed by OpenCode. It is separate from
  both relay tokens and is never written to the request journal.

Copy `configs/upstreams.json` to `$DELTARELAY_CONFIG_DIR/upstreams.json`, inspecting
an existing destination first (`cp -i` asks before overwriting):

```sh
cp -i configs/upstreams.json "$DELTARELAY_CONFIG_DIR/upstreams.json"
```

The same allowlist will be used on the VPS. If intentionally connecting another
PC to an existing relay, transfer its existing `relay.token` securely instead of
creating a different shared token. Each PC can have its own `local.token`. Never
commit either token or copy private `.runtime/` state into Git. Relay-state
migration is a separate operation described in [PROTOCOL_V2.md](PROTOCOL_V2.md#8-migrating-relay-state).

## 3. Start the VPS side

Securely copy the server binary, `relay.token`, and `configs/upstreams.json` to a
private directory on the VPS. Preserve `0600` on the token and `0700` on private
directories. Name the selected build `deltarelay` there (rename the
architecture-suffixed cross-build if needed) and make it executable.
**Do not copy your OpenCode authentication database.**

Start it there (adjust paths):

```sh
./deltarelay serve \
  --listen 127.0.0.1:8787 \
  --data ./cache \
  --token-file ./relay.token \
  --upstreams ./upstreams.json
```

Without `--upstreams`, diagnostic chunk transfer works but inference forwarding
is deliberately disabled. Never enable `--allow-private-upstreams` in production;
it is for loopback mock providers in tests.

The supplied rules cover:

| Name | Original request origin and path |
| --- | --- |
| `openai` | `https://api.openai.com/v1/…` |
| `chatgpt` | `https://chatgpt.com/backend-api/…` |
| `opencode` | `https://opencode.ai/inference/…` |

If your actual endpoint differs, add its exact HTTPS origin and a narrowly scoped
slash-terminated API path prefix to **both** allowlists. Unknown endpoints fail
closed. Do not add arbitrary destinations to work around an unexplained error.
Query strings are forwarded but are not logged. Redirects and private-network
DNS resolutions are refused; the server is not an open HTTP/SOCKS proxy.

### Keep it running with systemd (optional)

`deploy/deltarelay-server.service` is a hardened example using:

- Binary: `/usr/local/bin/deltarelay`.
- A dedicated `deltarelay` user/group.
- Token and allowlist: `/etc/deltarelay/relay.token` and `upstreams.json`.
- Persistent state: `/var/lib/deltarelay/cache`.

Create the service account and directories according to your distribution. Make
the token readable only by that service user; installing a root-owned `0600`
token would prevent the service from reading it. Inspect the unit before using
`systemctl enable --now`. No service or privileged user is installed automatically.

## 4. Connect the PC to the VPS

Recommended first deployment, from the PC:

```sh
ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 YOUR_USER@YOUR_VPS
```

Establish SSH host trust normally. Do not disable host-key checking. The tunnel
is encrypted even though the two local loopback endpoints use HTTP. There is
no public VPS listener. `deploy/deltarelay-tunnel.service.example` can keep this
tunnel alive after you fill in your host/user and configure SSH authentication.

Direct HTTPS is also supported by the VPS's `--tls-cert` and `--tls-key`, or a
properly configured HTTPS reverse proxy. Use that HTTPS origin as `--server` in
the next step. Never use `--allow-http` over the public internet.

For a reverse proxy, disable response buffering and automatic upstream retries,
allow the chunk/manifest request sizes, and set streaming read timeouts at least
as long as DeltaRelay's configured idle timeout. Otherwise intermediaries can
break streaming or duplicate ambiguous requests regardless of this tool's policy.

## 5. Start the local gateway

On your PC:

```sh
DELTARELAY_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay"
./bin/deltarelay gateway \
  --server http://127.0.0.1:8787 \
  --token-file "$DELTARELAY_CONFIG_DIR/relay.token" \
  --local-token-file "$DELTARELAY_CONFIG_DIR/local.token" \
  --upstreams "$DELTARELAY_CONFIG_DIR/upstreams.json"
```

The gateway binds `127.0.0.1:8788` by default and refuses non-loopback listeners.
Each completed request logs **metadata-only** JSON: random request ID, configured
upstream name, byte counters, status, duration, and a nonsecret error code. It
does not log prompts, provider credentials, response bodies, or full URLs.

`deploy/deltarelay-gateway.service` is an optional systemd **user** unit. It assumes
the binary is at `~/.local/bin/deltarelay` and the files above are in place. Copy
it to `~/.config/systemd/user/`, inspect it, then use your normal user-service
management. Adjust the unit's config paths if using a custom `XDG_CONFIG_HOME`.
It does not automatically create the SSH tunnel. After enabling it,
`journalctl --user -u deltarelay-gateway -f` shows the transfer counters.

## 6. Check readiness before enabling the plugin

```sh
./bin/deltarelay doctor --local-token-file "${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/local.token"
```

This checks gateway authentication, VPS reachability, matching protocol, enabled
forwarding, and reports transfer counters. It makes **no provider API call**.
It does not prove a plugin is loaded or that provider account/IP access works.

## 7. Enable the OpenCode V2 plugin

Generate a config fragment using the paths on **this computer**:

```sh
node integration/opencode/config.mjs
```

This only prints JSON; it does not read token contents, write any file, or change
OpenCode. It discovers the plugin directory from its own location, not the current
working directory. The token path defaults to
`${XDG_CONFIG_HOME:-$HOME/.config}/deltarelay/local.token`. For a different token
location, run it with `DELTARELAY_LOCAL_TOKEN_FILE` set to that file's path.

Merge the generated plugin entry **last** into the existing `plugins` array in the
configuration used by Desktop's server, normally
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc`. Preserve unrelated
configuration; do not replace that file with the fragment. The generated paths
are absolute and belong in your private config, **not in the repository**. There
is no shell expansion of `$HOME` or `~` in the plugin's `localTokenFile` option.

`integration/opencode/config.example.jsonc` is a reference template with the shape
below. Never use its placeholder paths literally:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // Keep your other plugin entries here.
    {
      "package": "/absolute/path/to/deltarelay/integration/opencode",
      "options": {
        "gateway": "http://127.0.0.1:8788",
        "localTokenFile": "/absolute/path/to/private/local.token",
        "providers": ["openai", "opencode-go"],
        "headerTimeout": 14400000
      }
    }
  ]
}
```

You can copy the entire `integration/opencode` directory to a stable location
such as `~/.local/share/deltarelay/opencode` and use its absolute path instead.
No npm install is required. Keep the directory together, including package.json.
If you move the checkout or copy the plugin elsewhere, rerun that directory's
`config.mjs` and update only the corresponding plugin entry.

OpenCode watches configuration; use `/reload` if you need to force a reload.
There is no need to restart Desktop merely to apply this configuration.

While enabled, the plugin:

- Forces **selected model providers** to HTTP, and disables whole-request gzip/
  zstd at provider, model, and variant levels so chunking sees original content.
- Keeps original endpoints and resolved credentials; changes only the final
  request's destination to the local gateway.
- Covers primary, title, compaction, and generate HTTP hooks.
- Forbids native provider WebSocket handshakes and automatic provider retries.
- Sets the response-header timeout to 4 hours by default so a very slow initial
  upload is not cut short; `headerTimeout` is adjustable in milliseconds.
- Propagates the original abort signal, so Stop cancels both hops and upstream.

### Persistent ChatGPT token-sharing compatibility

When using **OpenAI → Sign in with ChatGPT** (token sharing), add this option
to the DeltaRelay plugin entry in that profile's configuration:

```jsonc
"chatgptTokenSharingProviders": ["openai"]
```

This explicit policy reapplies `compatibility.supportsEffortUpdates: false` to
every model of those providers on every registry rebuild and uses local summary
compaction instead of the unsupported native compaction route. Model and variant
reasoning levels, conversation history, endpoints, and credentials are preserved.
Changing reasoning level still works; OpenCode sends the current level on the
next request rather than an unsupported `configuration_update` input item.

This avoids depending on OpenCode 2.1.4's ChatGPT plugin successfully resolving
OAuth during startup. Its conditional settings can otherwise remain absent after
a failed refresh followed by successful authentication. The DeltaRelay policy
does not read or refresh provider credentials and survives config reloads,
idle project eviction, and subsequent token refreshes.

The option defaults to `[]` and must contain only IDs in `providers`. Enable it
only for providers you deliberately use with token sharing; remove the opt-in
when switching that provider to an ordinary API key or legacy Codex connection.
It does not fix expired authorization, provider outages, or a stopped Codespace.

Avoid another plugin rewriting the destination after this plugin. Verify that
the plugin loaded successfully in OpenCode, then make a small model request and
confirm a matching gateway counter increase. Like any integration, an absent or
failed-to-load plugin cannot enforce routing: `doctor` alone cannot detect that.

## 8. Validate a real conversation

1. Start with a short, non-sensitive test prompt using your normal provider.
2. Verify text streams, local tools run normally, and Stop cancels generation.
3. Continue that same session. Compare `body_bytes` with `uploaded_chunk_bytes`
   and `request_body_bytes_sent` in gateway logs or `doctor` counters.
4. Temporarily stop the gateway and submit another harmless prompt. The request
   should fail, **not succeed by contacting the provider directly**. Restore it.
5. Repeat for each provider/sign-in method you use. Test a long session and
   compaction before relying on it for important work.

The first call uploads existing context once. Future calls still send metadata
and affected/new chunks. Compression means plain JSON byte count is not a fair
baseline; compare with what your previous compressed full uploads actually used.
There is no promise that every request will be small: genuinely new large file
content and tool output still need transferring.

### Strict upload budgets

After initial synchronization, optionally restart the gateway with:

```text
--max-upload-bytes 262144
```

This permits at most 256 KiB of **missing raw chunk bytes per model call**.
Exceeding it stops before chunk uploads or provider dispatch. Logs report the
required `missing_chunk_bytes` and `error_code: "upload_budget"`.

This also prevents a lost VPS cache from silently causing a large reupload.
New projects/large tool results can legitimately exceed it; explicitly raise or
temporarily remove the budget to approve that synchronization. Default `-1`
permits bootstrap; `0` allows cache hits only. Metadata still crosses the link.

### Failure and recovery semantics

Each OpenCode request gets a logical ID (`X-DeltaRelay-Request-ID`). The VPS
claims it durably **after hash verification and before provider dispatch**, then
stores the provider response in a checksummed mailbox while it is produced. The
full protocol is in [PROTOCOL_V2.md](PROTOCOL_V2.md).

What happens when the link fails:

| Situation | Result |
| --- | --- |
| VPN or SSH tunnel drops before the request is accepted | The gateway retries for up to `--retry-window` (default 1 h) with backoff. The request is never dispatched twice. |
| Link drops while the provider is streaming | The VPS keeps receiving and saving the response. The gateway reconnects and resumes at the last byte it delivered. |
| Link drops after the VPS accepted the request but the acknowledgment was lost | The retried submission returns the existing record. No new provider call. |
| Response bytes were corrupted in transit | Rejected by checksum and re-requested at the same offset. |
| Stop / cancel in OpenCode while online | Provider stream is cancelled durably and remote cancellation is recorded. |
| Stop / cancel while offline | Cancellation is queued locally (`--state-dir`) and delivered on reconnect. Until delivery, the provider may continue generating. |
| VPS restarts during generation | The request is reported `interrupted` (`server_restarted_dispatch_unknown`). It is **not** regenerated automatically. |
| Retention expired or runtime limit reached | Explicit `response_gone` (410) or `interrupted` status; never a silent success. |

Duplicate protection is absolute: a retry of any kind reuses the same request
ID. A failure can still require a deliberate new message from you, and an
interrupted generation may already have been billed by the provider.

The plugin leaves automatic retries disabled for selected providers. Automatic
retries would create new request IDs and could duplicate paid generation; the
DeltaRelay gateway owns recovery instead.

### Recovering a saved answer manually

If OpenCode lost the connection, the answer may still be on the VPS. With the
request ID from the gateway logs or error message:

```sh
./bin/deltarelay request status --id '<request-id>'
./bin/deltarelay request fetch --id '<request-id>' --output ./answer.sse --ack
```

`fetch` writes the verified raw provider bytes to a new file and acknowledges
only after publication. Existing files are never overwritten. Nothing here
resubmits the request. `request cancel --id ...` stops an unfinished generation.

### Storage and resource limits

- Persistent chunks and diagnostic bodies default to a 10 GiB cache cap. Full
  cache returns HTTP 507; there is **no automatic eviction** or surprise resync.
  Configure `serve --max-cache-bytes` for your VPS.
- The request journal defaults to 100,000 claims. Full journal fails closed;
  explicitly increase `--max-journal-records`. Do not erase claims while any
  client could still replay old IDs.
- Request bodies are reconstructed into an anonymous temporary file and deleted
  when the provider job ends. Only provider **responses** persist, as checksummed
  frames, until acknowledged or expired (`--response-retention`, default 24 h).
  Diagnostic `sync` still stores complete bodies.
- Defaults: 256 MiB request body, 256 MiB response per request, 4 GiB aggregate
  response storage, 2 h maximum provider job runtime. A full response store
  refuses new work with `507`; nothing is silently dropped.
- Default maximum request size is 256 MiB. Concurrency limits bound active
  processing. Do not share a data directory between server processes.
- VPS header/idle timeouts default to 5/15 minutes. Gateway RPC attempts use
  `--header-timeout` (2 min) and `--stall-timeout` (2 min); a long generation is
  never bounded by a total call timeout unless `--request-timeout` is set.
- Cache, tokens and diagnostic files are plaintext with private permissions,
  not encrypted at rest. Use encrypted disks if your threat model requires it.

## Disable or troubleshoot

Remove the plugin entry or set `options.enabled: false` and reload OpenCode.
The provider/model transforms and hooks are disposed; ordinary provider behavior
returns. Stop the gateway/tunnel afterwards if desired. Merely stopping the
gateway while the plugin is active intentionally makes model requests fail.

Common checks:

| Symptom | Check |
| --- | --- |
| Local 401 | Plugin and gateway must read the same private `local.token` |
| `doctor` fails | Tunnel/TLS, relay token, server process, and VPS `--upstreams` |
| 403 | Original API origin/path must match both allowlists |
| 415 | A provider/model/variant still sends unsupported request encoding |
| 409 | Used request ID or an upload budget; inspect metadata-only error code |
| 507 | Explicit cache or request-journal limit reached |
| Midstream error | Provider/network disconnect or idle timeout; output is aborted, not replaced with fake SSE |
| No gateway counters | Wrong provider ID, plugin load failure, or a different OpenCode server |
| Provider 401/403 | Original account credential, region, model entitlement, or VPS IP restriction |
| ChatGPT token sharing rejects an unsupported feature after changing reasoning | Enable `chatgptTokenSharingProviders: ["openai"]` in this profile's DeltaRelay options; see persistent compatibility above |

Do not paste tokens, provider headers, original request bodies, or full URLs
containing query credentials into bug reports. Share sanitized metadata only.
