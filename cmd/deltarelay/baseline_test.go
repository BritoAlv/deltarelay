package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// Help exits before token loading, state-file access, or listener creation.
func baselineHelp(t *testing.T, command ...string) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	args := append(append([]string{}, command...), "-h")
	if err := run(context.Background(), args, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	return stderr.String()
}

func assertHelpDefault(t *testing.T, help, name, want string) {
	t.Helper()
	lines := strings.Split(help, "\n")
	for i, line := range lines {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "-"+name || i+1 == len(lines) {
			continue
		}
		description := lines[i+1]
		if want == "" {
			if strings.Contains(description, "(default ") {
				t.Fatalf("-%s: expected an implicit zero/empty default, got %s", name, description)
			}
		} else if !strings.HasSuffix(description, "(default "+want+")") {
			t.Fatalf("-%s: want default %s, got %s", name, want, description)
		}
		return
	}
	t.Fatalf("flag -%s missing from help", name)
}

func TestCLIBaselineDefaults(t *testing.T) {
	for _, name := range []string{"DELTARELAY_SERVER", "DELTARELAY_TOKEN_FILE", "DELTARELAY_LOCAL_TOKEN_FILE", "DELTARELAY_UPSTREAMS_FILE", "DELTARELAY_STATS_FILE", "DELTARELAY_CAPTURE_DIR"} {
		t.Setenv(name, "")
	}
	state := filepath.Join(t.TempDir(), "state")
	t.Setenv("XDG_STATE_HOME", state)
	for _, tc := range []struct {
		command  []string
		defaults map[string]string
	}{
		{[]string{"serve"}, map[string]string{
			"listen": `"127.0.0.1:8787"`, "data": `"./data"`, "concurrency": "8", "max-body-bytes": "268435456",
			"max-cache-bytes": "10737418240", "max-journal-records": "100000", "header-timeout": "5m0s", "idle-timeout": "15m0s",
			"response-retention": "24h0m0s", "max-response-bytes": "268435456", "max-response-storage-bytes": "4294967296", "max-runtime": "2h0m0s",
			"token-file": "", "upstreams": "", "allow-private-upstreams": "",
		}},
		{[]string{"gateway"}, map[string]string{
			"listen": `"127.0.0.1:8788"`, "server": `"http://127.0.0.1:8787"`, "workers": "4", "batch-bytes": "262144", "concurrency": "8",
			"max-body-bytes": "268435456", "max-upload-bytes": "-1", "request-timeout": "", "header-timeout": "2m0s", "stats-file": `".runtime/dashboard-stats.json"`,
			"capture-dir": "", "capture-max-bytes": "536870912", "capture-max-request-bytes": "67108864", "capture-max-requests": "100", "capture-max-age": "24h0m0s",
		}},
		{[]string{"sync"}, map[string]string{"server": `"http://127.0.0.1:8787"`, "timeout": "4h0m0s", "workers": "4", "batch-bytes": "262144", "max-upload-bytes": "-1", "input": `"-"`, "state-dir": ""}},
		{[]string{"fetch"}, map[string]string{"server": `"http://127.0.0.1:8787"`, "timeout": "4h0m0s", "output": "", "state-dir": ""}},
		{[]string{"request", "info"}, map[string]string{"server": `"http://127.0.0.1:8787"`, "timeout": "4h0m0s", "state-dir": strconv.Quote(filepath.Join(state, "deltarelay"))}},
		{[]string{"dashboard"}, map[string]string{"listen": `"127.0.0.1:8790"`, "gateway": `"http://127.0.0.1:8788"`, "assets": `"web/dist"`, "auth-integration": `"openai"`, "control-socket": ""}},
		{[]string{"doctor"}, map[string]string{"gateway": `"http://127.0.0.1:8788"`, "local-token-file": ""}},
		{[]string{"gen-token"}, map[string]string{"output": ""}},
	} {
		t.Run(strings.Join(tc.command, "-"), func(t *testing.T) {
			help := baselineHelp(t, tc.command...)
			for name, want := range tc.defaults {
				assertHelpDefault(t, help, name, want)
			}
			if tc.command[0] == "gateway" || tc.command[0] == "sync" || tc.command[0] == "fetch" || tc.command[0] == "request" {
				for name, want := range map[string]string{"retry-window": "1h0m0s", "retry-min": "1s", "retry-max": "30s", "stall-timeout": "2m0s", "no-retry": ""} {
					assertHelpDefault(t, help, name, want)
				}
			}
		})
	}
}

func TestCLIEnvironmentPrecedence(t *testing.T) {
	root := t.TempDir()
	t.Setenv("DELTARELAY_SERVER", "https://relay.example.invalid")
	t.Setenv("DELTARELAY_TOKEN_FILE", filepath.Join(root, "relay.token"))
	t.Setenv("DELTARELAY_LOCAL_TOKEN_FILE", filepath.Join(root, "local.token"))
	t.Setenv("DELTARELAY_UPSTREAMS_FILE", filepath.Join(root, "upstreams.json"))
	t.Setenv("DELTARELAY_STATS_FILE", filepath.Join(root, "stats.json"))
	t.Setenv("DELTARELAY_CAPTURE_DIR", filepath.Join(root, "captures"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "xdg-state"))
	t.Setenv("HOME", filepath.Join(root, "home"))
	for _, command := range [][]string{{"gateway"}, {"request", "info"}} {
		help := baselineHelp(t, command...)
		assertHelpDefault(t, help, "server", `"https://relay.example.invalid"`)
		assertHelpDefault(t, help, "token-file", strconv.Quote(filepath.Join(root, "relay.token")))
		assertHelpDefault(t, help, "state-dir", strconv.Quote(filepath.Join(root, "xdg-state", "deltarelay")))
	}
	help := baselineHelp(t, "gateway")
	for name, file := range map[string]string{"local-token-file": "local.token", "upstreams": "upstreams.json", "stats-file": "stats.json", "capture-dir": "captures"} {
		assertHelpDefault(t, help, name, strconv.Quote(filepath.Join(root, file)))
	}
	for _, command := range []string{"dashboard", "doctor"} {
		assertHelpDefault(t, baselineHelp(t, command), "local-token-file", strconv.Quote(filepath.Join(root, "local.token")))
	}
	// Diagnostic transfers and serve intentionally do not inherit these file/URL defaults.
	for _, command := range []string{"sync", "fetch"} {
		help := baselineHelp(t, command)
		assertHelpDefault(t, help, "server", `"http://127.0.0.1:8787"`)
		assertHelpDefault(t, help, "token-file", "")
		assertHelpDefault(t, help, "state-dir", "")
	}
	assertHelpDefault(t, baselineHelp(t, "serve"), "token-file", "")
	t.Setenv("XDG_STATE_HOME", "")
	if got, want := defaultStateDir(), filepath.Join(root, "home", ".local", "state", "deltarelay"); got != want {
		t.Fatalf("HOME fallback: got %q, want %q", got, want)
	}
	if got := defaultEnv("DELTARELAY_SERVER", "fallback"); got != "https://relay.example.invalid" {
		t.Fatalf("environment default: %q", got)
	}
	t.Setenv("DELTARELAY_SERVER", "")
	if got := defaultEnv("DELTARELAY_SERVER", "fallback"); got != "fallback" {
		t.Fatalf("empty environment default: %q", got)
	}
}

func TestCLIExplicitFlagsOverrideEnvironment(t *testing.T) {
	var calls atomic.Int32
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "unexpected discovery", http.StatusBadRequest)
	}))
	t.Cleanup(relay.Close)
	t.Setenv("DELTARELAY_SERVER", relay.URL)
	t.Setenv("DELTARELAY_TOKEN", "synthetic-token")
	t.Setenv("DELTARELAY_TOKEN_FILE", filepath.Join(t.TempDir(), "missing.token"))
	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{"request", "info", "--server", "not-an-origin", "--token-file", "", "--state-dir", "", "--no-retry"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "server URL must be") || calls.Load() != 0 {
		t.Fatalf("explicit URL/empty token-file did not replace environment defaults: %v; calls=%d", err, calls.Load())
	}
}

func TestTokenFilePrecedenceFailsClosed(t *testing.T) {
	t.Setenv("DELTARELAY_TOKEN", "environment-token")
	path := filepath.Join(t.TempDir(), "relay.token")
	if err := os.WriteFile(path, []byte("  file-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := readToken("", "DELTARELAY_TOKEN"); err != nil || got != "environment-token" {
		t.Fatalf("environment token: %q %v", got, err)
	}
	if got, err := readToken(path, "DELTARELAY_TOKEN"); err != nil || got != "file-token" {
		t.Fatalf("file must override environment: %q %v", got, err)
	}
	for _, contents := range []string{"", "\n", "two\nlines", strings.Repeat("x", 4097)} {
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readToken(path, "DELTARELAY_TOKEN"); err == nil {
			t.Fatal("invalid explicit token file fell back to environment")
		}
	}
	if _, err := readToken(path+".missing", "DELTARELAY_TOKEN"); err == nil {
		t.Fatal("missing explicit token file fell back to environment")
	}
}
