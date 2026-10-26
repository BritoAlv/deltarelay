package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
	"deltarelay/internal/upstream"
)

func v2Request(t *testing.T,h *Server,method,path string,input any,stateID string)*httptest.ResponseRecorder {
	t.Helper()
	var body io.Reader
	if input != nil { data,err := json.Marshal(input); if err != nil { t.Fatal(err) }; body = bytes.NewReader(data) }
	r := httptest.NewRequest(method,path,body)
	r.Header.Set("Authorization","Bearer secret")
	if input != nil { r.Header.Set("Content-Type","application/json") }
	if stateID != "" { r.Header.Set("X-DeltaRelay-State-ID",stateID) }
	w := httptest.NewRecorder()
	h.ServeHTTP(w,r)
	return w
}

func waitTerminal(t *testing.T,h *Server,id string)protocol.RequestStatus {
	t.Helper()
	ctx,cancel := context.WithTimeout(context.Background(),3*time.Second)
	defer cancel()
	for {
		r,changed,err := h.mailbox.Lookup(id)
		if err != nil { t.Fatal(err) }
		if protocol.Terminal(r.State) { return r }
		select { case <-ctx.Done(): t.Fatal(ctx.Err()); case <-changed: }
	}
}

func TestV2ContractPersistenceIdentityAndLegacyClaims(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer private-provider-credential" { t.Error("provider credential changed") }
		_,_ = io.Copy(io.Discard,r.Body)
		w.Header().Set("Content-Type","text/event-stream")
		_,_ = io.WriteString(w,"data: saved\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(provider.Close)
	directory := t.TempDir()
	storage,err := store.Open(directory)
	if err != nil { t.Fatal(err) }
	config := Config{Store:storage,Token:"secret",Upstreams:[]upstream.Rule{{Name:"mock",Origin:provider.URL,PathPrefix:"/"}},AllowPrivateUpstreams:true}
	h,err := New(config)
	if err != nil { t.Fatal(err) }
	t.Cleanup(h.Close)
	infoResponse := v2Request(t,h,"GET","/v2/info",nil,"")
	var info protocol.Info
	if infoResponse.Code != 200 || json.Unmarshal(infoResponse.Body.Bytes(),&info) != nil || info.Version != 2 || info.StateID == "" { t.Fatal("missing v2 discovery contract") }
	body := []byte("private-original-request")
	m := manifest(body)
	if err := storage.PutChunk(m.Chunks[0],body); err != nil { t.Fatal(err) }
	input := protocol.ForwardRequest{Version:2,ID:"persistent-v2-request-0001",Target:provider.URL+"/responses",Method:"POST",Headers:http.Header{"Authorization":[]string{"Bearer private-provider-credential"}},Manifest:m}
	path := "/v2/requests/"+input.ID
	if w := v2Request(t,h,"PUT",path,input,""); w.Code != 409 || calls.Load() != 0 { t.Fatal("missing identity allowed dispatch") }
	if w := v2Request(t,h,"PUT",path,input,protocol.Sum([]byte("different relay"))); w.Code != 409 { t.Fatal("changed identity allowed dispatch") }
	if w := v2Request(t,h,"PUT",path,input,info.StateID); w.Code != 202 { t.Fatalf("submit: %d %s",w.Code,w.Body.String()) }
	status := waitTerminal(t,h,input.ID)
	if status.State != protocol.Completed { t.Fatalf("generation failed: %+v",status) }
	h.Close()
	restarted,err := New(config)
	if err != nil { t.Fatal(err) }
	t.Cleanup(restarted.Close)
	if restarted.mailbox.StateID() != info.StateID { t.Fatal("restart changed relay identity") }
	if w := v2Request(t,restarted,"PUT",path,input,info.StateID); w.Code != 200 || calls.Load() != 1 { t.Fatalf("repeat submission regenerated: %d %d",w.Code,calls.Load()) }
	w := v2Request(t,restarted,"GET",path+"/response?offset=6",nil,info.StateID)
	if w.Code != 200 || w.Body.String() != "saved\n\ndata: [DONE]\n\n" || w.Header().Get("X-DeltaRelay-Segment-Hash") != protocol.Sum(w.Body.Bytes()) { t.Fatalf("resume contract failed: %d %q",w.Code,w.Body.String()) }
	data,err := os.ReadFile(filepath.Join(directory,"mailbox","records",protocol.Sum([]byte(input.ID))))
	if err != nil { t.Fatal(err) }
	for _,secret := range []string{"private-provider-credential","private-original-request",provider.URL} {
		if bytes.Contains(data,[]byte(secret)) { t.Fatal("provider credentials, body or URL persisted in request metadata") }
	}
	for i:=0;i<2;i++ {
		w := v2Request(t,restarted,"POST",path+"/ack",protocol.Receipt{Size:status.Bytes,Hash:status.Hash},info.StateID)
		if w.Code != 200 { t.Fatalf("idempotent ACK failed: %d %s",w.Code,w.Body.String()) }
	}
	if w := v2Request(t,restarted,"GET",path+"/response?offset=0",nil,info.StateID); w.Code != 410 { t.Fatal("acknowledged response was not explicitly gone") }
	if w := v2Request(t,restarted,"PUT",path,input,info.StateID); w.Code != 200 || calls.Load() != 1 { t.Fatal("ACK removed dispatch protection") }
	legacy := input
	legacy.Version = 1
	encoded,_ := json.Marshal(legacy)
	if w := request(restarted,"/v1/forward","application/json",encoded,""); w.Code != 409 || calls.Load() != 1 { t.Fatal("legacy API bypassed v2 dispatch protection") }
}

func TestV2CancellationTombstoneAndInvalidBodyNeverDispatch(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){calls.Add(1)}))
	t.Cleanup(provider.Close)
	storage,_ := store.Open(t.TempDir())
	h,err := New(Config{Store:storage,Token:"secret",Upstreams:[]upstream.Rule{{Name:"mock",Origin:provider.URL,PathPrefix:"/"}},AllowPrivateUpstreams:true})
	if err != nil { t.Fatal(err) }
	t.Cleanup(h.Close)
	stateID := h.mailbox.StateID()
	body := []byte("verified body")
	m := manifest(body)
	_ = storage.PutChunk(m.Chunks[0],body)
	input := protocol.ForwardRequest{Version:2,ID:"cancel-before-arrival-0001",Target:provider.URL+"/responses",Method:"POST",Manifest:m}
	path := "/v2/requests/"+input.ID
	if w := v2Request(t,h,"POST",path+"/cancel",nil,stateID); w.Code != 200 { t.Fatalf("cancel: %d",w.Code) }
	if w := v2Request(t,h,"PUT",path,input,stateID); w.Code != 409 || calls.Load() != 0 { t.Fatal("late submission escaped cancellation tombstone") }
	input.ID = "invalid-whole-hash-0001"
	input.Manifest.Hash = protocol.Sum([]byte("wrong body"))
	if w := v2Request(t,h,"PUT","/v2/requests/"+input.ID,input,stateID); w.Code != 422 || calls.Load() != 0 { t.Fatal("unverified request reached provider") }
	if w := v2Request(t,h,"GET","/v2/requests/unknown-request-0001",nil,stateID); w.Code != 404 { t.Fatal("unknown operation not reported explicitly") }
}

func TestV2RuntimeAndResponseLimitsFailWithoutReplay(t *testing.T) {
	for _,kind := range []string{"runtime","response-limit"} {
		t.Run(kind,func(t *testing.T){
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
				calls.Add(1)
				_,_ = io.Copy(io.Discard,r.Body)
				if kind == "runtime" { _,_ = io.WriteString(w,"first"); w.(http.Flusher).Flush(); <-r.Context().Done(); return }
				_,_ = io.WriteString(w,strings.Repeat("x",100))
			}))
			t.Cleanup(provider.Close)
			storage,_ := store.Open(t.TempDir())
			config := Config{Store:storage,Token:"secret",Upstreams:[]upstream.Rule{{Name:"mock",Origin:provider.URL,PathPrefix:"/"}},AllowPrivateUpstreams:true}
			if kind == "runtime" { config.MaxRuntime = 30*time.Millisecond } else { config.MaxResponseBytes = 8 }
			h,err := New(config)
			if err != nil { t.Fatal(err) }
			t.Cleanup(h.Close)
			body := []byte("request")
			m := manifest(body)
			_ = storage.PutChunk(m.Chunks[0],body)
			input := protocol.ForwardRequest{Version:2,ID:"bounded-job-request-0001",Target:provider.URL+"/responses",Method:"POST",Manifest:m}
			path := "/v2/requests/"+input.ID
			if w := v2Request(t,h,"PUT",path,input,h.mailbox.StateID()); w.Code != 202 { t.Fatal(w.Body.String()) }
			status := waitTerminal(t,h,input.ID)
			if status.State == protocol.Completed || status.ErrorCode == "" { t.Fatalf("bounded failure looked successful: %+v",status) }
			if w := v2Request(t,h,"PUT",path,input,h.mailbox.StateID()); w.Code != 200 || calls.Load() != 1 { t.Fatal("bounded failure was regenerated") }
		})
	}
}
