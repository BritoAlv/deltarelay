import type { NodeID } from "./topology.js"

export const controlComponents: { id: NodeID; category: string; description: string }[] = [
  { id: "desktop", category: "Applications", description: "The desktop application used to interact with OpenCode. Start it from these controls; it never opens automatically." },
  { id: "openchamber", category: "Applications", description: "Supervised frontend that attaches to the shared OpenCode service through the frontend health gate. Start it from these controls; it never opens automatically." },
  { id: "opencode", category: "Applications", description: "Runs OpenCode and loads the DeltaRelay plugin." },
  { id: "vscode", category: "Applications", description: "Editor where Varro attaches to the shared OpenCode service. Open it from here or yourself; the supervisor never starts it automatically, restarts it, or observes it." },
  { id: "gate", category: "Connections", description: "The loopback frontend health gate Varro and OpenChamber use to attach to the shared OpenCode service." },
  { id: "gateway", category: "Connections", description: "Accepts authenticated requests on this computer." },
  { id: "tunnel", category: "Connections", description: "Carries relay traffic to the configured remote endpoint." },
  { id: "remote", category: "Connections", description: "The existing remote machine hosting the relay." },
  { id: "relay", category: "Connections", description: "Handles relayed requests and owns persistent cache files." },
  { id: "dashboard", category: "Background services", description: "Serves this dashboard independently of the gateway." },
  { id: "supervisor", category: "Background services", description: "Monitors components and coordinates automatic recovery." },
  { id: "remote_provider", category: "Background services", description: "On-demand helper for managing the remote host." },
]
