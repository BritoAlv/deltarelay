package upstream

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestDestinationPolicyAndHeaders(t *testing.T) {
	p, err := NewPolicy([]Rule{{Name: "openai", Origin: "https://api.openai.com", PathPrefix: "/v1/"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Match("https://api.openai.com/v1/responses?x=1"); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"https://evil.example/v1/responses", "https://api.openai.com.evil.example/v1/responses", "http://api.openai.com/v1/responses", "https://user@api.openai.com/v1/responses", "https://api.openai.com/v1/../admin", "https://api.openai.com/v1/%2e%2e/admin", "https://api.openai.com/v1/%2fadmin", "https://api.openai.com/v1/responses#fragment"} {
		if _, err := p.Match(target); err == nil {
			t.Fatalf("accepted %s", target)
		}
	}
	headers := http.Header{"Authorization": {"Bearer provider-token"}, "X-DeltaRelay-Local-Token": {"local-secret"}, "Connection": {"X-Remove"}, "X-Remove": {"hop"}, "Proxy-Authorization": {"secret"}, "Content-Length": {"123"}}
	clean := CleanHeaders(headers)
	if clean.Get("Authorization") != "Bearer provider-token" || clean.Get("X-DeltaRelay-Local-Token") != "" || clean.Get("X-Remove") != "" || clean.Get("Proxy-Authorization") != "" || clean.Get("Content-Length") != "" {
		t.Fatal("header isolation failed")
	}
	if err := ValidateHeaders(http.Header{"Invalid Name": {"x"}}); err == nil {
		t.Fatal("invalid header name accepted")
	}
	if err := ValidateHeaders(http.Header{"X-Test": {"x\r\nInjected: value"}}); err == nil {
		t.Fatal("header injection accepted")
	}
}

func TestPrivateDNSIsForbidden(t *testing.T) {
	p, err := NewPolicy([]Rule{{Name: "test", Origin: "https://127.0.0.1", PathPrefix: "/"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://127.0.0.1/", nil)
	if response, err := p.HTTPClient(time.Second).Do(r); err == nil {
		response.Body.Close()
		t.Fatal("private address was dialed")
	}
}

func TestSpecialNetworksAreNotPublic(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "169.254.169.254", "100.100.100.200", "198.18.0.1", "192.0.2.3", "::1", "::ffff:127.0.0.1", "fd00::1"} {
		if publicIP(net.ParseIP(address)) {
			t.Fatalf("accepted special address %s", address)
		}
	}
	if !publicIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("public address rejected")
	}
}
