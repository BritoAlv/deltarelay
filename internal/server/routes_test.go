package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestStatefulRoutesRequirePinnedIdentity(t *testing.T) {
	h, _ := testServer(t)
	for _, route := range []string{
		"POST /missing", "POST /chunks", "POST /assemble",
		"GET /bodies/hash", "HEAD /bodies/hash", "PUT /requests/request-00000001",
		"GET /requests/request-00000001", "HEAD /requests/request-00000001",
		"GET /requests/request-00000001/response?offset=0",
		"POST /requests/request-00000001/ack", "POST /requests/request-00000001/cancel",
	} {
		t.Run(route, func(t *testing.T) {
			method, path, _ := strings.Cut(route, " ")
			for _, identity := range []string{"", strings.Repeat("0", 64)} {
				w := relayRequest(t, h, method, path, nil, identity)
				var failure struct {
					Code string `json:"code"`
				}
				if w.Code != http.StatusConflict || json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != "state_mismatch" {
					t.Fatalf("missing/changed identity accepted: %d %s", w.Code, w.Body)
				}
			}
		})
	}
}

func TestOnlyUnversionedRoutesExist(t *testing.T) {
	h, _ := testServer(t)
	for _, prefix := range []string{"/v1", "/v2"} {
		for _, route := range []string{
			"GET /info", "POST /missing", "POST /chunks", "POST /assemble",
			"GET /bodies/hash", "HEAD /bodies/hash", "POST /forward",
			"PUT /requests/request-00000001", "GET /requests/request-00000001",
			"GET /requests/request-00000001/response?offset=0",
			"POST /requests/request-00000001/ack", "POST /requests/request-00000001/cancel",
		} {
			method, path, _ := strings.Cut(route, " ")
			for _, identity := range []string{"", h.mailbox.StateID()} {
				w := relayRequest(t, h, method, prefix+path, nil, identity)
				if w.Code != http.StatusNotFound || w.Header().Get("Location") != "" {
					t.Fatalf("removed route %s %s%s still exists: %d", method, prefix, path, w.Code)
				}
			}
		}
	}
	for _, route := range []string{"GET /healthz", "POST /forward"} {
		method, path, _ := strings.Cut(route, " ")
		if w := relayRequest(t, h, method, path, nil, ""); w.Code != http.StatusNotFound {
			t.Fatalf("obsolete route %s still exists: %d", route, w.Code)
		}
	}
}
