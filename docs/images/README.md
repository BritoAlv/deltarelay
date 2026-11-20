# README dashboard captures

These PNGs are cropped captures of the running local DeltaRelay dashboard, not
mockups or synthetic test data. The savings capture is from November 12, 2026;
the architecture capture was refreshed on November 18, 2026 (local time).

- `dashboard-savings.png`: Overview upload-composition and cache-reuse panels,
  with the **Last 7 days** range selected. Values are rounded by the dashboard.
  Automatic refresh was paused for the capture. The chart reports finished
  requests only and retains its failed/cancelled counts. Cache reuse and
  encoded-upload reduction are different measurements.
- `dashboard-architecture.png`: the read-only **Architecture** view under System
  controls, including its legend and the OpenChamber / Varro in VS Code
  health-gate fan. It shows live supervisor topology, but lifecycle status and
  actions live on the **Controls** tab. The map viewport was laid out to fit the
  complete map, then cropped to exclude the page header and unrelated controls.
  No topology or connection state was edited. This archived capture predates the
  separate **Response mailbox** node and its saved-bytes return lane; it shows
  the former combined cache/saved-responses node.

Only aggregate traffic and component labels are included—no prompts, session
identifiers, host addresses, credentials, or account metadata. These are fixed
snapshots, not live status or guarantees of savings or connectivity. When
replacing them, update the README figures and captions to match the new capture.
