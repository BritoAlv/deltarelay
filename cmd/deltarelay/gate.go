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
	"time"

	"deltarelay/internal/gate"
)

func gateCommand(ctx context.Context, args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("gate", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", "127.0.0.1:18789", "literal loopback listen address")
	serviceFile := flags.String("service-file", "", "required private OpenCode v2 service.json")
	gateway := flags.String("gateway", "http://127.0.0.1:18788", "loopback DeltaRelay gateway origin")
	localFile := flags.String("local-token-file", os.Getenv("DELTARELAY_LOCAL_TOKEN_FILE"), "private gateway token file; otherwise DELTARELAY_LOCAL_TOKEN")
	workspace := flags.String("workspace-directory", "", "optional directory whose DeltaRelay plugin must be active")
	cache := flags.Duration("health-cache", 2*time.Second, "successful health cache lifetime; 0 disables caching")
	passwordFile := flags.String("password-file", "", "optional private gate Basic-auth password file (username opencode)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("invalid gate arguments")
	}
	if err := gate.ValidateListen(*listen); err != nil {
		return err
	}
	token, err := readToken(*localFile, "DELTARELAY_LOCAL_TOKEN")
	if err != nil {
		return err
	}
	var password string
	if *passwordFile != "" {
		password, err = readToken(*passwordFile, "DELTARELAY_GATE_PASSWORD")
		if err != nil {
			return err
		}
	}
	handler, err := gate.New(gate.Config{ServiceFile: *serviceFile, Gateway: *gateway, LocalToken: token, WorkspaceDirectory: *workspace, HealthCache: *cache, Password: password, Log: stderr})
	if err != nil {
		return err
	}
	defer handler.Close()
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 128 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	fmt.Fprintf(stderr, "deltarelay gate listening on %s; attach-only, backend lifecycle disabled\n", *listen)
	return runHTTPServer(ctx, srv, 10*time.Second, srv.ListenAndServe)
}
