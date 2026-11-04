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
	"sync"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/gateway"
	"deltarelay/internal/inspection"
	"deltarelay/internal/protocol"
	"deltarelay/internal/upstream"
)

func gatewayCommand(ctx context.Context, args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("gateway", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", defaultGatewayListen, "loopback listen address")
	endpoint := flags.String("server", defaultEnv("DELTARELAY_SERVER", defaultRelayOrigin), "VPS HTTPS origin or SSH tunnel")
	rulesFile := flags.String("upstreams", os.Getenv("DELTARELAY_UPSTREAMS_FILE"), "required JSON upstream allowlist")
	tokenFile := flags.String("token-file", os.Getenv("DELTARELAY_TOKEN_FILE"), "private VPS token file; otherwise DELTARELAY_TOKEN")
	localFile := flags.String("local-token-file", os.Getenv("DELTARELAY_LOCAL_TOKEN_FILE"), "private gateway token file; otherwise DELTARELAY_LOCAL_TOKEN")
	allowHTTP := flags.Bool("allow-http", false, "explicitly allow insecure non-loopback VPS HTTP")
	allowPrivate := flags.Bool("allow-private-upstreams", false, "allow HTTP/private mock providers for testing only")
	budget := flags.Int64("max-upload-bytes", -1, "missing raw-byte budget per call; -1 unlimited, 0 cache hits only")
	maxBody := flags.Int64("max-body-bytes", protocol.DefaultMaxBodySize, "maximum decoded model request size")
	workers := flags.Int("workers", client.DefaultWorkers, "parallel chunk-upload batches")
	concurrent := flags.Int("concurrency", gateway.DefaultMaxConcurrent, "maximum simultaneously processed provider requests")
	requestTimeout := flags.Duration("request-timeout", 0, "optional total call timeout; 0 permits long streams")
	headerTimeout := flags.Duration("header-timeout", defaultGatewayHeaderTimeout, "response-header timeout per VPS RPC (provider wait uses bounded polls)")
	batch := flags.Int("batch-bytes", client.DefaultBatchBytes, "upload batch size; shrinks after failures")
	recovery := bindRecovery(flags, true)
	quiet := flags.Bool("quiet", false, "disable per-request metadata-only statistics logs")
	statsFile := flags.String("stats-file", defaultEnv("DELTARELAY_STATS_FILE", defaultStatsFile), "private bounded session statistics; empty disables persistence")
	captureDir := flags.String("capture-dir", os.Getenv("DELTARELAY_CAPTURE_DIR"), "opt-in private request/payload captures (sensitive prompts/code); empty disables capture")
	captureBytes := flags.Int64("capture-max-bytes", inspection.DefaultMaxBytes, "maximum retained inspection bytes, including metadata")
	captureRequestBytes := flags.Int64("capture-max-request-bytes", inspection.DefaultMaxCaptureBytes, "maximum inspection bytes per request including its evidence index; excess is explicitly truncated")
	captureCount := flags.Int("capture-max-requests", inspection.DefaultMaxCaptures, "maximum retained inspection captures")
	captureAge := flags.Duration("capture-max-age", inspection.DefaultMaxAge, "maximum age of retained inspection captures")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *budget < -1 || *headerTimeout <= 0 || *maxBody < 1 {
		return errors.New("invalid gateway arguments")
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || (host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback())) {
		return errors.New("gateway must listen on a loopback address")
	}
	token, err := readToken(*tokenFile, "DELTARELAY_TOKEN")
	if err != nil {
		return err
	}
	localToken, err := readToken(*localFile, "DELTARELAY_LOCAL_TOKEN")
	if err != nil {
		return err
	}
	rules, err := upstream.Load(*rulesFile)
	if err != nil {
		return err
	}
	config := client.Config{URL: *endpoint, Token: token, AllowHTTP: *allowHTTP, Workers: *workers, MaxBodySize: *maxBody, HeaderTimeout: *headerTimeout, BatchBytes: *batch}
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
	var logMu sync.Mutex
	handler, err := gateway.New(gateway.Config{
		Client: c, LocalToken: localToken, Upstreams: rules, AllowPrivateUpstreams: *allowPrivate,
		MaxBodySize: *maxBody, MaxConcurrent: *concurrent, RequestTimeout: *requestTimeout,
		StatsFile:  *statsFile,
		Inspection: inspection.Config{Dir: *captureDir, MaxBytes: *captureBytes, MaxCaptureBytes: *captureRequestBytes, MaxCaptures: *captureCount, MaxAge: *captureAge},
		OnStart: func(id string) {
			if !*quiet {
				logMu.Lock()
				defer logMu.Unlock()
				_ = json.NewEncoder(stderr).Encode(map[string]string{"event": "request_started", "request_id": id})
			}
		},
		OnResult: func(result gateway.Result) {
			if !*quiet {
				logMu.Lock()
				defer logMu.Unlock()
				_ = json.NewEncoder(stderr).Encode(result)
			}
		},
	})
	if err != nil {
		return err
	}
	defer handler.Close()
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 128 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	fmt.Fprintf(stderr, "deltarelay gateway listening on %s; direct-provider fallback disabled\n", *listen)
	return runHTTPServer(ctx, srv, 10*time.Second, srv.ListenAndServe)
}
