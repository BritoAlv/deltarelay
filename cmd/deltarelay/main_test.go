package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"deltarelay/internal/client"
	"deltarelay/internal/protocol"
	"deltarelay/internal/server"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func TestCLITransfer(t *testing.T) {
	t.Setenv("DELTARELAY_TOKEN", "cli-test-secret")
	storage, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler, err := server.New(server.Config{Store: storage, Token: "cli-test-secret"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(handler.Close)
	ts := httptest.NewServer(handler)
	defer ts.Close()
	dir := t.TempDir()
	input := filepath.Join(dir, "input.json")
	body := []byte(`{"messages":[{"role":"user","content":"hello"}]}`)
	if err := os.WriteFile(input, body, 0600); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), []string{"sync", "--server", ts.URL, "--input", input}, &stdout, &stderr); err != nil {
			t.Fatalf("sync: %v %s", err, stderr.String())
		}
		var stats client.Stats
		if err := json.Unmarshal(stdout.Bytes(), &stats); err != nil || stats.Hash != protocol.Sum(body) {
			t.Fatalf("bad statistics: %s", stdout.String())
		}
		if attempt == 1 && stats.UploadedChunks != 0 {
			t.Fatal("warm CLI sync uploaded repeated content")
		}
	}
	output := filepath.Join(dir, "verified.json")
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"fetch", "--server", ts.URL, "--hash", protocol.Sum(body), "--output", output}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("CLI reconstruction differs")
	}
}

func TestCLIRequestRecoveryAndAcknowledgment(t *testing.T) {
	t.Setenv("DELTARELAY_TOKEN","cli-test-secret")
	var calls atomic.Int32
	payload := "data: original response\n\ndata: [DONE]\n\n"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){ calls.Add(1); _,_ = io.Copy(io.Discard,r.Body); _,_ = io.WriteString(w,payload) }))
	t.Cleanup(provider.Close)
	storage,err := store.Open(t.TempDir())
	if err != nil { t.Fatal(err) }
	h,err := server.New(server.Config{Store:storage,Token:"cli-test-secret",Upstreams:[]upstream.Rule{{Name:"mock",Origin:provider.URL,PathPrefix:"/"}},AllowPrivateUpstreams:true})
	if err != nil { t.Fatal(err) }
	t.Cleanup(h.Close)
	remote := httptest.NewServer(h)
	t.Cleanup(remote.Close)
	c,err := client.New(client.Config{URL:remote.URL,Token:"cli-test-secret"})
	if err != nil { t.Fatal(err) }
	t.Cleanup(c.Close)
	id := "cli-recovered-request-0001"
	response,_,err := c.Forward(context.Background(),client.Request{ID:id,Target:provider.URL+"/responses",Method:"POST"},strings.NewReader("request"))
	if err != nil { t.Fatal(err) }
	if _,err := io.Copy(io.Discard,response.Body); err != nil { t.Fatal(err) }
	response.Body.Close()
	directory := t.TempDir()
	stateDir := filepath.Join(directory,"state")
	execute := func(action string,args ...string)[]byte {
		t.Helper()
		command := []string{"request",action,"--server",remote.URL,"--state-dir",stateDir}
		command = append(command,args...)
		var stdout,stderr bytes.Buffer
		if err := run(context.Background(),command,&stdout,&stderr); err != nil { t.Fatalf("%v: %v %s",command,err,stderr.String()) }
		return stdout.Bytes()
	}
	var info protocol.Info
	if err := json.Unmarshal(execute("info"),&info); err != nil || info.Version != 2 { t.Fatal("CLI did not expose v2 info") }
	var status protocol.RequestStatus
	if err := json.Unmarshal(execute("status","--id",id),&status); err != nil || status.State != protocol.Completed { t.Fatal("CLI did not inspect saved request") }
	output := filepath.Join(directory,"answer.sse")
	execute("fetch","--id",id,"--output",output,"--ack")
	data,err := os.ReadFile(output)
	if err != nil || string(data) != payload { t.Fatal("CLI changed saved response") }
	if err := json.Unmarshal(execute("status","--id",id),&status); err != nil || !status.Acknowledged { t.Fatal("CLI did not acknowledge after publication") }
	execute("ack","--id",id,"--hash",protocol.Sum(data),"--size",fmt.Sprint(len(data)))
	if calls.Load() != 1 { t.Fatal("recovery CLI regenerated response") }
}

func TestCLIHelpAndInvalidArguments(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"serve", "-h"}, {"sync", "-h"}, {"fetch", "-h"}, {"gateway", "-h"}, {"doctor", "-h"}, {"gen-token", "-h"}, {"request", "-h"}, {"request", "fetch", "-h"}} {
		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), args, &stdout, &stderr); err != nil {
			t.Fatalf("help %v: %v", args, err)
		}
	}
	t.Setenv("DELTARELAY_TOKEN", "")
	for _, args := range [][]string{nil, {"unknown"}, {"sync"}, {"serve"}, {"serve", "--tls-cert", "only-cert"}, {"sync", "--timeout", "0"}} {
		var stdout, stderr bytes.Buffer
		if err := run(context.Background(), args, &stdout, &stderr); err == nil {
			t.Fatalf("invalid arguments accepted: %v", args)
		}
	}
}

func TestPrivateTokenGenerationAndNoOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), []string{"gen-token", "--output", path}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("generated token is not private")
	}
	first, err := os.ReadFile(path)
	if err != nil || len(bytes.TrimSpace(first)) != 64 {
		t.Fatal("incorrect token length")
	}
	if bytes.Contains(stdout.Bytes(), bytes.TrimSpace(first)) {
		t.Fatal("token value printed")
	}
	if err := run(context.Background(), []string{"gen-token", "--output", path}, &stdout, &stderr); err == nil {
		t.Fatal("existing token overwritten")
	}
	second, _ := os.ReadFile(path)
	if !bytes.Equal(first, second) {
		t.Fatal("existing token changed")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readToken(path, "IGNORED"); err == nil {
		t.Fatal("world-readable token accepted")
	}
}
