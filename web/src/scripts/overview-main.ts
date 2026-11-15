import { startDashboard } from "./dashboard.js"
import { startSystemStatus } from "./system.js"

const system = startSystemStatus(document, { manageHeader: false })
startDashboard(document, {
  onPauseChange: (paused) => paused ? system.pause() : system.resume(),
})
