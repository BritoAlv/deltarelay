package main

import (
	"os"
	"time"
)

// Composition defaults belong to the CLI: they select local addresses, files,
// and command-wide timeouts. Component behavior defaults live with the package
// that owns them and are referenced directly from flag registration.
const (
	defaultServeListen           = "127.0.0.1:8787"
	defaultRelayOrigin           = "http://127.0.0.1:8787"
	defaultGatewayListen         = "127.0.0.1:8788"
	defaultGatewayOrigin         = "http://127.0.0.1:8788"
	defaultDashboardListen       = "127.0.0.1:8790"
	defaultDataDirectory         = "./data"
	defaultCacheBytes      int64 = 10 << 30
	defaultAssets                = "web/dist"
	defaultStatsFile             = ".runtime/dashboard-stats.json"
	defaultTransferTimeout       = 4 * time.Hour
	defaultDoctorTimeout         = 10 * time.Second

	// The gateway deliberately uses shorter relay RPC header timeouts than the
	// standalone transfer commands so a stalled provider wait cannot hold a
	// local OpenCode request open indefinitely.
	defaultGatewayHeaderTimeout = 2 * time.Minute
)

// defaultEnv applies the existing environment-first flag default. An empty
// environment value selects the literal fallback.
func defaultEnv(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
