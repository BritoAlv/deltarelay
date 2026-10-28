package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"deltarelay/internal/dashboard"
)

func dashboardCommand(ctx context.Context, args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("dashboard", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", "127.0.0.1:8790", "loopback dashboard listen address")
	endpoint := flags.String("gateway", "http://127.0.0.1:8788", "loopback gateway HTTP origin")
	assets := flags.String("assets", "web/dist", "Astro build directory; empty serves only the development API")
	localFile := flags.String("local-token-file", defaultEnv("DELTARELAY_LOCAL_TOKEN_FILE", ""), "private local gateway token file; otherwise DELTARELAY_LOCAL_TOKEN")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	host, _, err := net.SplitHostPort(*listen)
	if flags.NArg() != 0 || err != nil || !dashboard.LoopbackHost(host) {
		return errors.New("dashboard must listen on a loopback address")
	}
	token, err := readToken(*localFile, "DELTARELAY_LOCAL_TOKEN")
	if err != nil {
		return err
	}
	handler, err := dashboard.New(dashboard.Config{GatewayURL: *endpoint, LocalToken: token, Assets: *assets})
	if err != nil {
		return err
	}
	defer handler.Close()
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	done, shutdownDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if srv.Shutdown(shutdown) != nil {
				_ = srv.Close()
			}
		case <-done:
		}
	}()
	fmt.Fprintf(stderr, "DeltaRelay dashboard: http://%s (read-only, local access only)\n", *listen)
	err = srv.ListenAndServe()
	close(done)
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
