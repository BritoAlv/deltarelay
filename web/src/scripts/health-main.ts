import { startDashboard } from "./dashboard.js"
import { startSystemStatus } from "./system.js"

// System health combines gateway diagnostics with the supervisor's network
// observation. The supervisor poller leaves the shared header to the dashboard
// poller, and pausing the page freezes both schedules.
const system = startSystemStatus(document, { manageHeader: false })
startDashboard(document, {
  waitingLabel: "Waiting for local gateway",
  onPauseChange: (paused) => {
    if (paused) system.pause()
    else system.resume()
  },
})
