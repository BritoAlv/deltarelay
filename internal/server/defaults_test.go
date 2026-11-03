package server

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"deltarelay/internal/mailbox"
	"deltarelay/internal/protocol"
	"deltarelay/internal/store"
)

// Constructor normalization and the CLI flags both use the owning package's
// defaults. This guards the wire-visible limits against silent drift.
func TestConstructorDefaultsMatchOwnerConstants(t *testing.T) {
	storage, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(Config{Store: storage, Token: "defaults-test-token"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(handler.Close)
	request := httptest.NewRequest("GET", "/v2/info", nil)
	request.Header.Set("Authorization", "Bearer defaults-test-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var info protocol.Info
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &info) != nil {
		t.Fatalf("v2 info failed: %d %s", response.Code, response.Body.String())
	}
	for name, check := range map[string]struct{ got, want int64 }{
		"max body":            {info.MaxBodyBytes, protocol.DefaultMaxBodySize},
		"max response":        {info.MaxResponseBytes, mailbox.DefaultResponseBytes},
		"max response store":  {info.MaxResponseStorageBytes, mailbox.DefaultStorageBytes},
		"retention seconds":   {info.RetentionSeconds, int64(mailbox.DefaultRetention / time.Second)},
		"max runtime seconds": {info.MaxRuntimeSeconds, int64(DefaultMaxRuntime / time.Second)},
		"max journal records": {int64(info.MaxJournalRecords), DefaultMaxJournalRecords},
		"max concurrent":      {int64(info.MaxConcurrent), DefaultMaxConcurrent},
	} {
		if check.got != check.want {
			t.Fatalf("%s: got %d, want %d", name, check.got, check.want)
		}
	}
}
