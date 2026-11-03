package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/server"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func serve(ctx context.Context, args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", defaultServeListen, "listen address; loopback is safe for an SSH tunnel")
	directory := flags.String("data", defaultDataDirectory, "private persistent cache directory")
	maxBody := flags.Int64("max-body-bytes", protocol.DefaultMaxBodySize, "maximum reconstructed body size")
	concurrent := flags.Int("concurrency", server.DefaultMaxConcurrent, "maximum concurrent authenticated requests")
	cert := flags.String("tls-cert", "", "TLS certificate PEM (requires --tls-key)")
	key := flags.String("tls-key", "", "TLS private-key PEM")
	rulesFile := flags.String("upstreams", "", "JSON upstream allowlist; omission disables forwarding")
	allowPrivate := flags.Bool("allow-private-upstreams", false, "permit HTTP/private upstreams for local tests only")
	maxCache := flags.Int64("max-cache-bytes", defaultCacheBytes, "persistent chunk/body cache limit; no automatic eviction")
	maxJournal := flags.Int("max-journal-records", server.DefaultMaxJournalRecords, "maximum durable provider request claims")
	headerTimeout := flags.Duration("header-timeout", server.DefaultHeaderTimeout, "provider response-header timeout")
	idleTimeout := flags.Duration("idle-timeout", server.DefaultIdleTimeout, "maximum gap between provider response bytes")
	tokenFile := flags.String("token-file", "", "private relay token file; otherwise DELTARELAY_TOKEN")
	retention := flags.Duration("response-retention", mailbox.DefaultRetention, "retain unacknowledged payloads after completion; tombstones are never evicted")
	maxResponse := flags.Int64("max-response-bytes", mailbox.DefaultResponseBytes, "maximum raw provider response per request")
	maxResponseStorage := flags.Int64("max-response-storage-bytes", mailbox.DefaultStorageBytes, "maximum aggregate checksummed response payload storage")
	maxRuntime := flags.Duration("max-runtime", server.DefaultMaxRuntime, "maximum provider job lifetime, including while PC is offline")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || (*cert == "") != (*key == "") {
		return errors.New("unexpected arguments or incomplete TLS certificate/key pair")
	}
	// CLI flags are always explicit values, unlike constructor zero values that
	// select a documented default. Keep early errors for invalid limits.
	if *maxBody < 1 || *maxBody > protocol.DefaultMaxBodySize || *concurrent < 1 || *concurrent > 64 || *maxCache < 1 || *maxJournal < 1 || *headerTimeout <= 0 || *idleTimeout <= 0 || *retention < mailbox.MinRetention || *maxResponse < 1 || *maxResponseStorage < mailbox.MinStorageBytes || *maxRuntime <= 0 {
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
	fmt.Fprintf(stderr, "deltarelay listening on %s (persistent store: %s)\n", *listen, *directory)
	return runHTTPServer(ctx, srv, 10*time.Second, func() error {
		if *cert != "" {
			return srv.ListenAndServeTLS(*cert, *key)
		}
		return srv.ListenAndServe()
	})
}
