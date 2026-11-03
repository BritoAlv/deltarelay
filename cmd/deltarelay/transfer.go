package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
)

func transferCommand(ctx context.Context, command string, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	endpoint := flags.String("server", defaultRelayOrigin, "VPS HTTPS origin or local SSH-tunnel origin")
	insecure := flags.Bool("allow-http", false, "explicitly allow plaintext HTTP to a non-loopback host (unsafe)")
	timeout := flags.Duration("timeout", defaultTransferTimeout, "whole-operation timeout, including link recovery")
	input := flags.String("input", "-", "body file, or - for standard input (sync)")
	output := flags.String("output", "", "new destination file; existing files are never overwritten (fetch)")
	hash := flags.String("hash", "", "SHA-256 of reconstructed body (fetch)")
	workers := flags.Int("workers", client.DefaultWorkers, "parallel upload batches (sync)")
	batch := flags.Int("batch-bytes", client.DefaultBatchBytes, "uncompressed batch size including framing; shrinks after failures (sync)")
	noCompression := flags.Bool("no-compression", false, "disable adaptive gzip compression (sync)")
	budget := flags.Int64("max-upload-bytes", -1, "missing raw-byte budget; -1 unlimited, 0 cache hits only (sync)")
	maxBody := flags.Int64("max-body-bytes", protocol.DefaultMaxBodySize, "maximum input/download size")
	tokenFile := flags.String("token-file", "", "private relay token file; otherwise DELTARELAY_TOKEN")
	recovery := bindRecovery(flags, false)
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *timeout <= 0 || *budget < -1 || *maxBody < 1 || *maxBody > protocol.DefaultMaxBodySize {
		return errors.New("invalid arguments, timeout, or upload budget")
	}
	token, err := readToken(*tokenFile, "DELTARELAY_TOKEN")
	if err != nil {
		return err
	}
	config := client.Config{
		URL: *endpoint, Token: token, AllowHTTP: *insecure,
		Workers: *workers, BatchBytes: *batch, NoCompression: *noCompression, MaxBodySize: *maxBody,
	}
	if err := recovery.apply(&config); err != nil {
		return err
	}
	if *budget >= 0 {
		config.MaxUploadBytes = budget
	}
	c, err := client.New(config)
	if err != nil {
		return err
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	if command == "fetch" {
		if *output == "" || *hash == "" {
			return errors.New("fetch requires --hash and --output")
		}
		if err := c.Fetch(ctx, *hash, *output); err != nil {
			return err
		}
		return json.NewEncoder(stdout).Encode(map[string]any{"hash": *hash, "output": *output, "verified": true})
	}
	var source io.Reader = os.Stdin
	if *input != "-" {
		f, err := os.Open(*input)
		if err != nil {
			return err
		}
		defer f.Close()
		source = f
	}
	stats, syncErr := c.Sync(ctx, source)
	encodeErr := json.NewEncoder(stdout).Encode(stats)
	if syncErr != nil {
		return syncErr
	}
	return encodeErr
}
