package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestDashboardCLIHelpAndLocalOnlyValidation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"dashboard", "-h"}, &stdout, &stderr); err != nil || !strings.Contains(stderr.String(), "local-token-file") {
		t.Fatalf("dashboard help failed: %v %s", err, stderr.String())
	}
	for _, args := range [][]string{
		{"dashboard", "--listen", "0.0.0.0:8790"},
		{"dashboard", "--listen", ":8790"},
		{"dashboard", "extra"},
	} {
		if err := run(context.Background(), args, &stdout, &stderr); err == nil || !strings.Contains(err.Error(), "loopback") {
			t.Fatalf("accepted unsafe dashboard arguments: %v %v", args, err)
		}
	}
	t.Setenv("DELTARELAY_LOCAL_TOKEN", "")
	t.Setenv("DELTARELAY_LOCAL_TOKEN_FILE", "")
	if err := run(context.Background(), []string{"dashboard"}, &stdout, &stderr); err == nil {
		t.Fatal("dashboard accepted missing local credentials")
	}
}
