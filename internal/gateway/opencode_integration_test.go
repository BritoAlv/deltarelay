package gateway_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Opt-in test: executes the actual installed OpenCode against a mock model,
// isolated HOME/XDG directories, and fake credentials. No shared service, user
// configuration, real account, or paid inference endpoint is used.
func TestInstalledOpenCodePlugin(t *testing.T) {
	if os.Getenv("DELTARELAY_TEST_OPENCODE") != "1" {
		t.Skip("set DELTARELAY_TEST_OPENCODE=1 to test the installed OpenCode V2 integration")
	}
	executable, err := exec.LookPath("opencode")
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer fake-provider-key" {
			t.Error("native provider credential was not preserved")
		}
		body, _ := io.ReadAll(r.Body)
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		if request["stream"] == true {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"mock\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"DeltaRelay integration OK\"},\"finish_reason\":null}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n\n")
		} else {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"id":"chatcmpl-test","object":"chat.completion","created":1,"model":"mock","choices":[{"index":0,"message":{"role":"assistant","content":"DeltaRelay integration OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
		}
	}))
	defer provider.Close()
	f := newFixture(t, provider, 0)
	directory := t.TempDir()
	project := filepath.Join(directory, "project")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(directory, "local.token")
	if err := os.WriteFile(tokenFile, []byte(localToken), 0600); err != nil {
		t.Fatal(err)
	}
	_, file, _, _ := runtime.Caller(0)
	plugin := filepath.Clean(filepath.Join(filepath.Dir(file), "../../integration/opencode"))
	config := map[string]any{
		"$schema": "https://opencode.ai/config.json", "model": "delta-test/mock",
		"plugins":   []any{map[string]any{"package": plugin, "options": map[string]any{"gateway": f.gateway.URL, "localTokenFile": tokenFile, "providers": []string{"delta-test"}, "headerTimeout": 10000}}},
		"providers": map[string]any{"delta-test": map[string]any{"name": "DeltaRelay mock", "env": []string{"DELTA_TEST_API_KEY"}, "package": "@opencode/ai/providers/openai-compatible", "settings": map[string]any{"baseURL": provider.URL + "/v1"}, "models": map[string]any{"mock": map[string]any{"name": "Mock model", "limit": map[string]int{"context": 32768, "output": 1024}, "capabilities": map[string]bool{"tools": false}}}}},
	}
	encoded, _ := json.Marshal(config)
	if err := os.WriteFile(filepath.Join(project, "opencode.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"home", "config/opencode", "data", "cache", "state", "tmp"} {
		if err := os.MkdirAll(filepath.Join(directory, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "config/opencode/opencode.json"), []byte(`{"update":"disable"}`), 0600); err != nil {
		t.Fatal(err)
	}
	environment := []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + filepath.Join(directory, "home"),
		"XDG_CONFIG_HOME=" + filepath.Join(directory, "config"), "XDG_DATA_HOME=" + filepath.Join(directory, "data"),
		"XDG_CACHE_HOME=" + filepath.Join(directory, "cache"), "XDG_STATE_HOME=" + filepath.Join(directory, "state"),
		"TMPDIR=" + filepath.Join(directory, "tmp"), "DELTA_TEST_API_KEY=fake-provider-key",
	}
	run := func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, "run", "--standalone", "--format", "json", "--model", "delta-test/mock", "Reply with the integration test message; do not use tools.")
		cmd.Dir = project
		cmd.Env = environment
		return cmd.CombinedOutput()
	}
	output, err := run()
	if err != nil || !strings.Contains(string(output), "DeltaRelay integration OK") {
		t.Fatalf("real OpenCode integration failed: %v\n%s", err, output)
	}
	entries, err := os.ReadDir(filepath.Join(f.directory, "requests"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 || int(calls.Load()) != len(entries) {
		t.Fatalf("native provider calls bypassed gateway: calls=%d journal=%d", calls.Load(), len(entries))
	}
	before := calls.Load()
	f.gateway.Close()
	output, _ = run()
	if calls.Load() != before || strings.Contains(string(output), "DeltaRelay integration OK") {
		t.Fatalf("OpenCode bypassed failed gateway: %s", output)
	}
	t.Logf("real OpenCode V2 plugin: %d provider call(s) traversed the relay; stopping gateway prevented direct fallback", before)
}
