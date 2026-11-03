package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
)

func doctorCommand(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	flags.SetOutput(stderr)
	endpoint := flags.String("gateway", defaultGatewayOrigin, "loopback gateway origin")
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
	ctx, cancel := context.WithTimeout(ctx, defaultDoctorTimeout)
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
