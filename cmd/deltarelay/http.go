package main

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// runHTTPServer starts one already configured server and coordinates graceful
// shutdown. TLS selection, listener startup, timeouts, header limits, and
// component cleanup remain explicit at each call site.
func runHTTPServer(ctx context.Context, srv *http.Server, shutdownTimeout time.Duration, start func() error) error {
	done := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
			defer cancel()
			if srv.Shutdown(shutdown) != nil {
				_ = srv.Close()
			}
		case <-done:
		}
	}()
	err := start()
	close(done)
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
