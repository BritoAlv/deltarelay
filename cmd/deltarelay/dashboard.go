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
	listen := flags.String("listen", defaultDashboardListen, "loopback dashboard listen address")
	endpoint := flags.String("gateway", defaultGatewayOrigin, "loopback gateway HTTP origin")
	assets := flags.String("assets", defaultAssets, "Astro build directory; empty serves only the development API")
	localFile := flags.String("local-token-file", defaultEnv("DELTARELAY_LOCAL_TOKEN_FILE", ""), "private local gateway token file; otherwise DELTARELAY_LOCAL_TOKEN")
	controlSocket := flags.String("control-socket", "", "optional private supervisor Unix socket; omission keeps controls disabled")
	serviceFile := flags.String("opencode-service-file", "", "optional private OpenCode V2 service registration for read-only OAuth expiry and session catalog metadata")
	authIntegration := flags.String("auth-integration", dashboard.DefaultAuthIntegration, "OpenCode integration whose active OAuth expiry is displayed")
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
	handler, err := dashboard.New(dashboard.Config{GatewayURL: *endpoint, LocalToken: token, Assets: *assets,
		ControlSocket: *controlSocket, OpenCodeServiceFile: *serviceFile, AuthIntegration: *authIntegration})
	if err != nil {
		return err
	}
	defer handler.Close()
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	fmt.Fprintf(stderr, "DeltaRelay dashboard: http://%s (local access only; controls require a configured supervisor)\n", *listen)
	return runHTTPServer(ctx, srv, 5*time.Second, srv.ListenAndServe)
}
