# Recovery acceptance testing

This is the live acceptance test for automatic network recovery, the component
map, and intentional shutdown. It is written for an **independent OpenCode
instance** that does not route through DeltaRelay. That instance acts as the
tester and observer; its own provider traffic must stay direct.

Offline contract, lifecycle, build, and browser tests are already covered by:

```sh
make verify
```

Do not run these live tests from a session that depends on the deployment being
tested. Changing Wi-Fi, Ethernet, or VPN state can drop **every** connection on
the PC, including the tester. A separate machine, a second unaffected network
path, or a locally recorded test run is the reliable way to observe a full
outage. If the tester shares the same network, expect its own prompt to pause or
fail during a total outage; that is not a DeltaRelay recovery failure unless the
managed path also fails to return.

Suggested handoff to the independent OpenCode instance:

> Read `docs/RECOVERY_TESTING.md` and execute the live matrix. Use your direct
> provider configuration, not DeltaRelay or the local gateway. Do not modify
> networking from inside a relay-routed session. Record map states, process
> PIDs, journal excerpts, and pass/fail results for every row.

## Safety and preparation

1. Finish and review the implementation. Keep the currently running services and
   a rollback copy of the working binary/assets.
2. Build the new revision in a maintenance window. Existing processes are not
   replaced merely by rebuilding:

   ```sh
   cp bin/deltarelay bin/deltarelay.rollback
   go build -trimpath -o bin/deltarelay ./cmd/deltarelay
   pnpm --filter @deltarelay/dashboard build
   ```

3. Restart the supervisor and dashboard once so they use the new code and assets.
   Existing managed applications are adopted if still running. Do not delete the
   relay store, identity pin, tokens, or lease/cache state.
4. Start the independent OpenCode tester with a profile/config that does **not**
   contain the DeltaRelay plugin and does **not** submit to the local gateway.
   Verify its model request works directly before toggling the managed stack.
   Keep it in a separate terminal/window from the managed Desktop instance.
5. Record a baseline in the dashboard map and in a terminal:

   ```sh
   opencode service status
   ps -o pid,lstart,cmd -C opencode -C deltarelay
   ```

   Also record the dashboard and supervisor PIDs, and whether the remote host is
   running. On the map, note which nodes are **Ready**, **Running · unverified**,
   **Unknown**, or intentionally **Stopped**. Do not treat a running process as a
   working connection.
6. Keep a terminal available that is not managed by the stack, for example a
   local shell/SSH session on another machine, so you can collect evidence during
   a full outage. The private journal is at
   `<supervisor profile>/control/activity.jsonl`; it remains available even
   though the browser log console was removed.

## What must remain true

- No manual dashboard action is needed before or after a Wi-Fi/Ethernet/VPN
  change. Recovery continues with the dashboard closed.
- The supervisor checks the actual authenticated relay path before changing a
  service. A route change alone never restarts a healthy component.
- Desktop, the OpenCode server, and the gateway keep the same PIDs across an
  unrelated transport repair. The tunnel may be rebuilt; the remote host and
  relay should not be restarted unless the verified path requires it.
- A running host, a started command, and a provider "running" response are not
  reported as connection success. Only authenticated relay health with the pinned
  identity completes recovery.
- An intentionally stopped VPS or system is not silently woken or restarted by a
  later network change or supervisor restart.
- The dashboard and supervisor survive **Shut down system**. Your PC is never
  powered off by these controls.
- Recovery never resets credentials, cache, mailbox state, or response offsets,
  and never submits an extra model request/generation.
- A temporary outage may interrupt an in-flight request. The client resumes the
  same durable request where the protocol allows it; it must not blindly create a
  second provider generation.

## Test matrix

Use the map as the primary observation, with the journal and process list as
supporting evidence. Mark each row pass/fail and save timestamps.

### 1. Wi-Fi network change

1. With the relay connected, switch from Wi-Fi network A to B.
2. Do not touch the dashboard.
3. Observe the map and wait for the configured recovery window.

Expected: the Internet/interface node leaves Ready; the active recovery component
(usually transport) shows a spinner and its actual action. The gateway, OpenCode
server, and Desktop remain running with unchanged PIDs. After the new network is
usable, replay/health returns within one retry window and the map returns to
Ready. A different BSSID on the same subnet should normally need no repair at all.

### 2. Ethernet ↔ Wi-Fi switch

1. Connect Ethernet while Wi-Fi remains active, then disable Wi-Fi (or the
   reverse, depending on the PC).
2. Keep an OpenCode direct-provider prompt ready but do not submit during the
   switch.
3. Confirm the monitored path changes even though an interface name changed.

Expected: detection is based on the usable link/address/route/DNS state, not a
hardcoded Wi-Fi name. No manual **Recover** is needed. The map shows no invented
failure merely because an interface disappeared.

### 3. VPN on/off and split routes

1. Turn the VPN on, wait for reconnect, then turn it off.
2. Repeat while the dashboard is closed, then reopen it.
3. If the VPN supports split tunneling, change the route for the VPS subnet only.

Expected: a route change triggers a check, not a blind restart. If relay traffic
is still authenticated, nothing is restarted. If the route is genuinely broken,
transport/relay recovery runs once and verifies again. Disabling the VPN must not
leave the stack stopped or require **Recover**. Authentication/TLS failures are
reported as blockers, never "repaired" by resetting credentials.

### 4. DNS-only change

Change the system resolver (or `/etc/resolv.conf`) without changing link state,
then restore it. If the relay uses a loopback tunnel URL, DNS may be irrelevant;
record that no restart is expected. The supervisor must still notice the change
and recheck, rather than assuming the cached path is healthy forever.

### 5. Full outage and return

1. Disconnect every path for 30–60 seconds.
2. Confirm the map reports **No internet**/not ready and retries with backoff.
3. Restore any previously working path.
4. Do not press anything.

Expected: the stack reconnects automatically. Total outage is distinguishable
from VPS failure. The tester's own direct request may also fail; that is separate
from the managed path returning. If the dashboard was closed, reopen it and
confirm recovery already happened (the supervisor has no browser dependency).

### 6. Hung versus exited tunnel

Stop or freeze the local forwarder (for example `SIGSTOP` or `SIGTERM` on the
configured tunnel PID) without touching the remote relay.

Expected: an exited process is restarted; a hung-but-running forward is rebuilt
after the health probes fail. Gateway/Desktop/OpenCode PIDs stay unchanged. The
relay is not restarted unless the verified path still fails. Confirm the map
shows the new tunnel as **running/unverified** until relay verification succeeds,
not instantly **Ready**.

### 7. Active request during a short interruption

This test must not be run through the tester's own relay-routed session. Use a
separate managed Desktop/OpenCode request, or a dedicated client request, and
interrupt only the transport briefly. Record the request ID and retained
response offsets before and after.

Expected: the gateway retains one request ID and resumes the saved response where
the protocol allows. The request count may increase for legitimate resume
attempts, but there must be no new provider generation for the same request. If
the outage exceeds the configured recovery window, the map shows the real error
and saved-response recovery remains available; do not send the same prompt again
blindly.

### 8. Automatic remote wake

Test both policies:

- **Auto-wake off / no consent:** stop the VPS, trigger network changes, and
  confirm the map stays stopped. No billing should resume.
- **Auto-wake explicitly enabled:** stop the VPS, cause a connection failure,
  and confirm recovery waits for **running** and then verifies the relay. A host
  state of `running` alone is not success.

Use disposable infrastructure or accept the displayed compute-billing warning.
Never enable auto-wake silently.

### 9. VPS shutdown and Start system

1. Press **Shut down VPS…** and confirm.
2. Change Wi-Fi/VPN while it is stopped.
3. Confirm the dashboard and supervisor remain reachable and the VPS is not
   re-woken.
4. Use **Start system** (or the explicit wake action if offered), confirm the
   billing warning, and verify the relay is authenticated before the map says
   Ready.

**Shut down VPS** saves automatic reconnect/wake as off before requesting
shutdown. These settings remain off even if shutdown fails or is incomplete.

### 10. System shutdown, persistence, and resume

1. Press **Shut down system…** and confirm.
2. Verify the dashboard stays reachable, the supervisor is running, and local
   Desktop/OpenCode/gateway/tunnel are stopped (or independently verified). The
   VPS is stopped only when the provider advertises `host.stop`.
3. Change networks and wait; nothing may restart automatically.
4. Restart the supervisor (`startup.sh`) with the dashboard still available.
   Confirm the persisted intent keeps the system stopped.
5. Press **Start system**, confirm, and verify local applications plus the
   authenticated relay return.

If the button is disabled, the map names components lacking `stop_command`.
Configure explicit stop commands and retry; do not add broad process matching.
A service-manager stop that cannot be independently verified is reported as
unverified, not invented as stopped.

### 11. Supervisor restart during recovery

Terminate the supervisor while a recovery step is active, then start it again.

Expected: the interrupted run is shown as interrupted/uncertain. No command is
blindly replayed. The new supervisor observes actual state first and only then
plans the next repair. The dashboard/supervisor pairing remains usable, and the
map does not lie about the uncertain step.

## Evidence to save

- Dashboard screenshots or exported timestamps for each map transition.
- Supervisor journal excerpt showing the network hint, decision, action, and
  verification (`<profile>/control/activity.jsonl`).
- `ps` PID/birth evidence for Desktop, OpenCode, gateway, tunnel, dashboard, and
  supervisor before/after each scenario.
- Git revision and build commands.
- For request resumption: request ID, initial/final response offsets, gateway
  request count, and proof that no second generation was submitted.
- Pass/fail for every matrix row, including expected pauses during total outages.

## Pass/fail summary

A release passes when every non-optional row recovers without a dashboard click,
no healthy unrelated process is restarted, no intentional stop is overridden, the
dashboard/supervisor remain available after system shutdown, and no duplicate
provider generation is observed. A failed row must be recorded with the actual map
state and journal excerpt; do not "fix" it by clearing relay state, deleting the
identity pin, weakening TLS, or adding a direct-provider fallback.

## Rollback

Restore `bin/deltarelay.rollback` and the previous `web/dist`, restart the
supervisor/dashboard, and re-check the relay identity and saved responses. Do not
delete private state or the relay store. If the new supervisor wrote intent or
recovery checkpoints, they are private diagnostic state; resetting intent requires
an explicit **Start system** or a reviewed private configuration change, not
deleting the relay data.
