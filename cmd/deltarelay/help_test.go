package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestTopLevelHelpDescribesOptionalSupervisorControls(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"--help"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	help := stdout.String()
	if !strings.Contains(help, "controls are optional and supervisor-backed") {
		t.Fatalf("dashboard help does not describe optional controls: %s", help)
	}
	if strings.Contains(help, "read-only dashboard") {
		t.Fatal("dashboard help still labels the command read-only")
	}
}
