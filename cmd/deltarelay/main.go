package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"deltarelay/internal/protocol"
)

const version = "0.3.0"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "deltarelay:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: deltarelay <serve|gateway|dashboard|sync|fetch|request|doctor|gen-token> [flags]")
	}
	switch args[0] {
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "deltarelay %s (relay protocol %d, chunk format %d)\n", version, protocol.RelayVersion, protocol.Version)
		return nil
	case "serve":
		return serve(ctx, args[1:], stderr)
	case "sync", "fetch":
		return transferCommand(ctx, args[0], args[1:], stdout, stderr)
	case "gateway":
		return gatewayCommand(ctx, args[1:], stderr)
	case "dashboard":
		return dashboardCommand(ctx, args[1:], stderr)
	case "doctor":
		return doctorCommand(ctx, args[1:], stdout, stderr)
	case "request":
		return requestCommand(ctx, args[1:], stdout, stderr)
	case "gen-token":
		return tokenCommand(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, "Usage: deltarelay <command> [flags]\n\n  serve      VPS chunk store and durable response mailbox\n  gateway    Authenticated PC loopback gateway for OpenCode\n  dashboard  Local dashboard; controls are optional and supervisor-backed\n  request    Inspect, fetch, acknowledge or cancel a saved request\n  doctor     Check gateway, VPS readiness, and transfer counters\n  gen-token  Generate a private authentication token file\n  sync       Synchronize a file body (diagnostic)\n  fetch      Resume a verified body export (diagnostic)\n\nRun a command with -h for flags. See README.md for setup.")
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
