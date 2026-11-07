# README dashboard captures

These PNGs are cropped captures of the running local DeltaRelay dashboard taken
on November 7, 2026 (UTC), not mockups or synthetic test data.

- `dashboard-savings.png`: Overview upload-composition and cache-reuse panels,
  with the **Last 7 days** range selected. Values are rounded by the dashboard.
  Aggregated traffic starts November 3; earlier totals are preserved but not
  plotted, as the visible chart notice explains.
  The chart reports finished requests only and retains its failed/cancelled
  counts. Cache reuse and encoded-upload reduction are different measurements.
- `dashboard-architecture.png`: System controls connection map, including its
  legend and observed readiness states. The browser layout was widened to fit
  the complete map, then cropped to exclude unrelated controls and account
  metadata. Refresh was paused for capture; node states were not edited.

Only aggregate traffic and component labels are included—no prompts, session
identifiers, host addresses, credentials, or account metadata. These are fixed
snapshots, not live status or guarantees of savings or connectivity. When
replacing them, update the README figures and captions to match the new capture.
