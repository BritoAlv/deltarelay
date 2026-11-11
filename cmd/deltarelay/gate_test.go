package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestGateCommandHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"gate", "-h"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{"-service-file", "-workspace-directory", "-password-file", "-health-cache"} {
		if !strings.Contains(stderr.String(), flag) {
			t.Fatalf("missing flag %s", flag)
		}
	}
}

func TestGateCommandRejectsPublicListener(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{"gate", "--listen", "0.0.0.0:18789"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("unexpected error: %v", err)
	}
}
