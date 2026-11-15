package gateway_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"deltarelay/internal/client"
	"deltarelay/internal/gateway"
	"deltarelay/internal/transfer"
	"deltarelay/internal/upstream"
)

type storageLimitRelay struct {
	finalStateRelay
	code string
}

func (r *storageLimitRelay) Forward(context.Context, client.Request, io.Reader) (*http.Response, transfer.Stats, error) {
	return nil, transfer.Stats{}, fmt.Errorf("forwarding: %w", &client.HTTPError{
		Status: http.StatusInsufficientStorage,
		Code:   r.code,
		Detail: "private-detail provider-secret https://example.com/?key=query-secret",
	})
}

func TestStorageLimitIsActionableAndNeverFallsBack(t *testing.T) {
	for _, code := range []string{"", "storage_full"} {
		t.Run("relay_code="+code, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
			defer provider.Close()
			var result gateway.Result
			g, err := gateway.New(gateway.Config{
				Client:                &storageLimitRelay{code: code},
				LocalToken:            localToken,
				Upstreams:             []upstream.Rule{{Name: "mock", Origin: provider.URL, PathPrefix: "/v1/"}},
				AllowPrivateUpstreams: true,
				OnResult:              func(value gateway.Result) { result = value },
			})
			if err != nil {
				t.Fatal(err)
			}
			defer g.Close()
			request := httptest.NewRequest(http.MethodPost, "/proxy", strings.NewReader(`{"input":"test"}`))
			request.Header.Set("X-DeltaRelay-Local-Token", localToken)
			request.Header.Set("X-DeltaRelay-Target", provider.URL+"/v1/responses?key=target-secret")
			request.Header.Set("X-DeltaRelay-Request-ID", "storage-limit-request-0001")
			response := httptest.NewRecorder()
			g.ServeHTTP(response, request)

			body := response.Body.String()
			if response.Code != http.StatusInsufficientStorage || !strings.Contains(body, "--max-journal-records") || !strings.Contains(body, "No direct-provider fallback") {
				t.Fatalf("storage limit not reported precisely: %d %s", response.Code, body)
			}
			for _, secret := range []string{"private-detail", "provider-secret", "query-secret", "target-secret", localToken, provider.URL} {
				if strings.Contains(body, secret) {
					t.Fatal("storage diagnostic exposed private error details")
				}
			}
			if result.Status != http.StatusInsufficientStorage || result.ErrorCode != "relay_storage_full" || !result.Failed {
				t.Fatalf("storage limit not classified in metadata: %+v", result)
			}
			if calls.Load() != 0 {
				t.Fatal("storage limit caused a direct provider call")
			}
		})
	}
}
