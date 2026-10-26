package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/server"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
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
		return errors.New("usage: deltarelay <serve|gateway|sync|fetch|request|doctor|gen-token> [flags]")
	}
	switch args[0] {
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "deltarelay %s (relay protocol %d, chunk format %d)\n", version, protocol.RelayVersion, protocol.Version)
		return nil
	case "serve":
		return serve(ctx, args[1:], stderr)
	case "sync", "fetch":
		return transfer(ctx, args[0], args[1:], stdout, stderr)
	case "gateway":
		return gatewayCommand(ctx, args[1:], stderr)
	case "doctor":
		return doctorCommand(ctx, args[1:], stdout, stderr)
	case "request":
		return requestCommand(ctx, args[1:], stdout, stderr)
	case "gen-token":
		return tokenCommand(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, "Usage: deltarelay <command> [flags]\n\n  serve      VPS chunk store and durable response mailbox\n  gateway    Authenticated PC loopback gateway for OpenCode\n  request    Inspect, fetch, acknowledge or cancel a saved request\n  doctor     Check gateway, VPS readiness, and transfer counters\n  gen-token  Generate a private authentication token file\n  sync       Synchronize a file body (diagnostic)\n  fetch      Resume a verified body export (diagnostic)\n\nRun a command with -h for flags. See README.md for setup.")
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func serve(ctx context.Context, args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", "127.0.0.1:8787", "listen address; loopback is safe for an SSH tunnel")
	directory := flags.String("data", "./data", "private persistent cache directory")
	maxBody := flags.Int64("max-body-bytes", protocol.DefaultMaxBodySize, "maximum reconstructed body size")
	concurrent := flags.Int("concurrency", 8, "maximum concurrent authenticated requests")
	cert := flags.String("tls-cert", "", "TLS certificate PEM (requires --tls-key)")
	key := flags.String("tls-key", "", "TLS private-key PEM")
	rulesFile := flags.String("upstreams", "", "JSON upstream allowlist; omission disables forwarding")
	allowPrivate := flags.Bool("allow-private-upstreams", false, "permit HTTP/private upstreams for local tests only")
	maxCache := flags.Int64("max-cache-bytes", 10<<30, "persistent chunk/body cache limit; no automatic eviction")
	maxJournal := flags.Int("max-journal-records", 100000, "maximum durable provider request claims")
	headerTimeout := flags.Duration("header-timeout", 5*time.Minute, "provider response-header timeout")
	idleTimeout := flags.Duration("idle-timeout", 15*time.Minute, "maximum gap between provider response bytes")
	tokenFile := flags.String("token-file", "", "private relay token file; otherwise DELTARELAY_TOKEN")
	retention := flags.Duration("response-retention", 24*time.Hour, "retain unacknowledged payloads after completion; tombstones are never evicted")
	maxResponse := flags.Int64("max-response-bytes", 256<<20, "maximum raw provider response per request")
	maxResponseStorage := flags.Int64("max-response-storage-bytes", 4<<30, "maximum aggregate checksummed response payload storage")
	maxRuntime := flags.Duration("max-runtime", 2*time.Hour, "maximum provider job lifetime, including while PC is offline")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || (*cert == "") != (*key == "") {
		return errors.New("unexpected arguments or incomplete TLS certificate/key pair")
	}
	if *maxBody < 1 || *maxBody > protocol.DefaultMaxBodySize || *concurrent < 1 || *concurrent > 64 || *maxCache < 1 || *maxJournal < 1 || *headerTimeout <= 0 || *idleTimeout <= 0 || *retention < time.Second || *maxResponse < 1 || *maxResponseStorage < 37 || *maxRuntime <= 0 {
		return errors.New("invalid body size or concurrency limit")
	}
	token, err := readToken(*tokenFile, "DELTARELAY_TOKEN")
	if err != nil {
		return err
	}
	rules, err := upstream.Load(*rulesFile)
	if err != nil {
		return err
	}
	storage, err := store.OpenLimited(*directory, *maxCache)
	if err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(storage.Directory(), ".server.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("data directory is already owned by another server")
	}
	handler, err := server.New(server.Config{Store: storage, Token: token, MaxBodySize: *maxBody, MaxConcurrent: *concurrent,
		Upstreams: rules, AllowPrivateUpstreams: *allowPrivate, HeaderTimeout: *headerTimeout, IdleTimeout: *idleTimeout, MaxJournalRecords: *maxJournal,
		Context: ctx, ResponseRetention: *retention, MaxResponseBytes: *maxResponse, MaxResponseStorageBytes: *maxResponseStorage, MaxRuntime: *maxRuntime})
	if err != nil {
		return err
	}
	defer handler.Close()
	srv := &http.Server{
		Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 16 << 10,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	done := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if srv.Shutdown(shutdownCtx) != nil {
				_ = srv.Close()
			}
		case <-done:
		}
	}()
	fmt.Fprintf(stderr, "deltarelay listening on %s (persistent store: %s)\n", *listen, *directory)
	if *cert != "" {
		err = srv.ListenAndServeTLS(*cert, *key)
	} else {
		err = srv.ListenAndServe()
	}
	close(done)
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func transfer(ctx context.Context, command string, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	endpoint := flags.String("server", "http://127.0.0.1:8787", "VPS HTTPS origin or local SSH-tunnel origin")
	insecure := flags.Bool("allow-http", false, "explicitly allow plaintext HTTP to a non-loopback host (unsafe)")
	timeout := flags.Duration("timeout", 4*time.Hour, "whole-operation timeout, including link recovery")
	input := flags.String("input", "-", "body file, or - for standard input (sync)")
	output := flags.String("output", "", "new destination file; existing files are never overwritten (fetch)")
	hash := flags.String("hash", "", "SHA-256 of reconstructed body (fetch)")
	workers := flags.Int("workers", 4, "parallel upload batches (sync)")
	batch := flags.Int("batch-bytes", 256<<10, "uncompressed batch size including framing; shrinks after failures (sync)")
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
