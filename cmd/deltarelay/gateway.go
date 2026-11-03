package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"deltarelay/internal/client"
	"deltarelay/internal/fsx"
	"deltarelay/internal/gateway"
	"deltarelay/internal/protocol"
	"deltarelay/internal/upstream"
)

func readToken(path, environment string) (string, error) {
	token := os.Getenv(environment)
	if path != "" {
		info, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() || info.Size() > 4096 || info.Mode().Perm()&0077 != 0 {
			return "", errors.New("token file must be regular, small, and accessible only to its owner (chmod 600)")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		token = strings.TrimSpace(string(data))
	}
	if token == "" || len(token) > 4096 || strings.ContainsAny(token, "\r\n") {
		return "", fmt.Errorf("set %s or supply a private token file", environment)
	}
	return token, nil
}

func defaultEnv(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func gatewayCommand(ctx context.Context, args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("gateway", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", "127.0.0.1:8788", "loopback listen address")
	endpoint := flags.String("server", defaultEnv("DELTARELAY_SERVER", "http://127.0.0.1:8787"), "VPS HTTPS origin or SSH tunnel")
	rulesFile := flags.String("upstreams", os.Getenv("DELTARELAY_UPSTREAMS_FILE"), "required JSON upstream allowlist")
	tokenFile := flags.String("token-file", os.Getenv("DELTARELAY_TOKEN_FILE"), "private VPS token file; otherwise DELTARELAY_TOKEN")
	localFile := flags.String("local-token-file", os.Getenv("DELTARELAY_LOCAL_TOKEN_FILE"), "private gateway token file; otherwise DELTARELAY_LOCAL_TOKEN")
	allowHTTP := flags.Bool("allow-http", false, "explicitly allow insecure non-loopback VPS HTTP")
	allowPrivate := flags.Bool("allow-private-upstreams", false, "allow HTTP/private mock providers for testing only")
	budget := flags.Int64("max-upload-bytes", -1, "missing raw-byte budget per call; -1 unlimited, 0 cache hits only")
	maxBody := flags.Int64("max-body-bytes", protocol.DefaultMaxBodySize, "maximum decoded model request size")
	workers := flags.Int("workers", 4, "parallel chunk-upload batches")
	concurrent := flags.Int("concurrency", 8, "maximum simultaneously processed provider requests")
	requestTimeout := flags.Duration("request-timeout", 0, "optional total call timeout; 0 permits long streams")
	headerTimeout := flags.Duration("header-timeout", 2*time.Minute, "response-header timeout per VPS RPC (provider wait uses bounded polls)")
	batch := flags.Int("batch-bytes", 256<<10, "upload batch size; shrinks after failures")
	recovery := bindRecovery(flags, true)
	quiet := flags.Bool("quiet", false, "disable per-request metadata-only statistics logs")
	statsFile := flags.String("stats-file", defaultEnv("DELTARELAY_STATS_FILE", ".runtime/dashboard-stats.json"), "private bounded session statistics; empty disables persistence")
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
		StatsFile: *statsFile,
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
	done := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if srv.Shutdown(shutdown) != nil {
				_ = srv.Close()
			}
		case <-done:
		}
	}()
	fmt.Fprintf(stderr, "deltarelay gateway listening on %s; direct-provider fallback disabled\n", *listen)
	err = srv.ListenAndServe()
	close(done)
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func tokenCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("gen-token", flag.ContinueOnError)
	flags.SetOutput(stderr)
	output := flags.String("output", "", "new token file, mode 600; never overwrites existing files")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *output == "" || flags.NArg() != 0 {
		return errors.New("gen-token requires --output; create the private parent directory first")
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return err
	}
	_, err := fsx.CreateExclusive(*output, 0600, func(f *os.File) error {
		_, err := fmt.Fprintln(f, hex.EncodeToString(secret[:]))
		return err
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(map[string]string{"token_file": *output})
}

func doctorCommand(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	flags.SetOutput(stderr)
	endpoint := flags.String("gateway", "http://127.0.0.1:8788", "loopback gateway origin")
	localFile := flags.String("local-token-file", os.Getenv("DELTARELAY_LOCAL_TOKEN_FILE"), "private local gateway token file")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	u, err := url.Parse(*endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Hostname() != "localhost" && (net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback())) {
		return errors.New("doctor requires a loopback HTTP origin")
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected doctor arguments")
	}
	token, err := readToken(*localFile, "DELTARELAY_LOCAL_TOKEN")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	result := make(map[string]any)
	ready := true
	for _, path := range []string{"/healthz", "/metrics"} {
		r, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(*endpoint, "/")+path, nil)
		r.Header.Set("X-DeltaRelay-Local-Token", token)
		response, err := c.Do(r)
		if err != nil {
			return errors.New("cannot reach local gateway")
		}
		var value any
		err = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&value)
		response.Body.Close()
		if err != nil {
			return errors.New("invalid gateway diagnostic response")
		}
		if response.StatusCode != http.StatusOK {
			ready = false
		}
		result[strings.TrimPrefix(path, "/")] = value
	}
	if err := json.NewEncoder(stdout).Encode(result); err != nil {
		return err
	}
	if !ready {
		return errors.New("gateway is not ready; local metrics above include pending cancellations; check relay connectivity, identity and configuration")
	}
	return nil
}
