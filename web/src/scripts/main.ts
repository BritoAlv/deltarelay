import { startDashboard } from "./dashboard.js"
import { startSystemControls } from "./system.js"

// Two independent lifecycles share the page and the manual Refresh button.
// Dashboard diagnostics and supervisor controls never gate each other.
startDashboard()
startSystemControls()
