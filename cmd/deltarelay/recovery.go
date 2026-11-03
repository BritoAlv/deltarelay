package main

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"time"

	"deltarelay/internal/client"
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
		window:    flags.Duration("retry-window", client.DefaultRetryWindow, "maximum recovery time for a temporary RPC outage"),
		min:       flags.Duration("retry-min", client.DefaultRetryMin, "initial retry backoff"),
		max:       flags.Duration("retry-max", client.DefaultRetryMax, "maximum retry backoff (Retry-After may be longer)"),
		stall:     flags.Duration("stall-timeout", client.DefaultStallTimeout, "RPC inactivity watchdog; increase for very slow links"),
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
