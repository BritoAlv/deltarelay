package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
)

func defaultStateDir() string {
	if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "deltarelay")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "state", "deltarelay")
}

type recoveryFlags struct {
	window, min, max, stall *time.Duration
	noRetry                 *bool
	directory, expected     *string
}

func bindRecovery(flags *flag.FlagSet, persistent bool) recoveryFlags {
	directory := ""
	if persistent {
		directory = defaultStateDir()
	}
	return recoveryFlags{
		window:    flags.Duration("retry-window", time.Hour, "maximum recovery time for a temporary RPC outage"),
		min:       flags.Duration("retry-min", time.Second, "initial retry backoff"),
		max:       flags.Duration("retry-max", 30*time.Second, "maximum retry backoff (Retry-After may be longer)"),
		stall:     flags.Duration("stall-timeout", 2*time.Minute, "RPC inactivity watchdog; increase for very slow links"),
		noRetry:   flags.Bool("no-retry", false, "disable automatic link retries"),
		directory: flags.String("state-dir", directory, "private relay identity and pending cancellation directory; empty is memory-only"),
		expected:  flags.String("expected-state-id", "", "require this persistent relay identity (SHA-256-shaped ID)"),
	}
}

func (r recoveryFlags) apply(config *client.Config) error {
	if *r.window <= 0 || *r.min <= 0 || *r.max < *r.min || *r.stall <= 0 {
		return errors.New("invalid retry settings")
	}
	config.RetryWindow, config.RetryMin, config.RetryMax, config.StallTimeout = *r.window, *r.min, *r.max, *r.stall
	config.NoRetry, config.ControlDir, config.ExpectedStateID = *r.noRetry, *r.directory, *r.expected
	return nil
}

func requestCommand(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: deltarelay request <info|status|fetch|ack|cancel> [flags]")
	}
	if args[0] == "-h" || args[0] == "--help" {
		_, err := io.WriteString(stdout, "Usage: deltarelay request <info|status|fetch|ack|cancel> [flags]\n\nInspect or recover an existing durable request; never resubmits generation.\nUse --id, --server, --token-file; fetch requires --output.\nACK requires --hash and --size. Run any action with -h for all flags.\n")
		return err
	}
	action := args[0]
	switch action {
	case "info", "status", "fetch", "ack", "cancel":
	default:
		return errors.New("unknown request action")
	}
	flags := flag.NewFlagSet("request "+action, flag.ContinueOnError)
	flags.SetOutput(stderr)
	endpoint := flags.String("server", defaultEnv("DELTARELAY_SERVER", "http://127.0.0.1:8787"), "relay HTTPS origin or local SSH tunnel")
	tokenFile := flags.String("token-file", os.Getenv("DELTARELAY_TOKEN_FILE"), "private relay token file; otherwise DELTARELAY_TOKEN")
	allowHTTP := flags.Bool("allow-http", false, "allow insecure non-loopback HTTP (unsafe)")
	id := flags.String("id", "", "existing logical request ID")
	output := flags.String("output", "", "new destination for raw provider response (possibly SSE)")
	hash := flags.String("hash", "", "verified response SHA-256 for ACK")
	size := flags.Int64("size", -1, "verified response byte length for ACK")
	ack := flags.Bool("ack", false, "acknowledge response only after verified local file publication (fetch)")
	timeout := flags.Duration("timeout", 4*time.Hour, "whole-command timeout")
	recovery := bindRecovery(flags, true)
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *timeout <= 0 {
		return errors.New("invalid request arguments or timeout")
	}
	if action != "info" && *id == "" {
		return errors.New("request action requires --id")
	}
	if action == "fetch" && *output == "" {
		return errors.New("request fetch requires --output")
	}
	if action == "ack" && (*size < 0 || !protocol.ValidHash(*hash)) {
		return errors.New("request ack requires a valid --hash and non-negative --size")
	}
	token, err := readToken(*tokenFile, "DELTARELAY_TOKEN")
	if err != nil {
		return err
	}
	config := client.Config{URL: *endpoint, Token: token, AllowHTTP: *allowHTTP}
	if err := recovery.apply(&config); err != nil {
		return err
	}
	c, err := client.New(config)
	if err != nil {
		return err
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	var result any
	switch action {
	case "info":
		result, err = c.Info(ctx)
	case "status":
		result, err = c.Status(ctx, *id)
	case "fetch":
		var receipt protocol.Receipt
		receipt, err = c.FetchResponse(ctx, *id, *output, *ack)
		result = map[string]any{"id": *id, "output": *output, "hash": receipt.Hash, "size": receipt.Size, "verified": err == nil, "acknowledged": *ack && err == nil}
	case "ack":
		err = c.Ack(ctx, *id, protocol.Receipt{Hash: *hash, Size: *size})
		result = map[string]any{"id": *id, "acknowledged": err == nil}
	case "cancel":
		err = c.Cancel(ctx, *id)
		if err == nil {
			// Give a reachable relay a chance to receive the command, but do not
			// hide an offline cancellation behind an indefinitely blocking CLI.
			deadline := time.NewTimer(2 * time.Second)
			defer deadline.Stop()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
		wait:
			for {
				pending, _ := c.ControlStatus()
				if pending == 0 {
					break
				}
				select {
				case <-ctx.Done():
					break wait
				case <-deadline.C:
					break wait
				case <-ticker.C:
				}
			}
			pending, controlError := c.ControlStatus()
			result = map[string]any{"id": *id, "cancellation_queued": pending != 0, "control_error": controlError}
		}
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(result)
}
