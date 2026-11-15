import { startMeasurementPage } from "./measurement-page.js"
import { startSystemStatus } from "./system.js"

const system = startSystemStatus(document, { manageHeader: false })
startMeasurementPage(document, {
  onPauseChange: (paused) => paused ? system.pause() : system.resume(),
})
