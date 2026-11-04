package protocol

import (
	"strings"
	"testing"
)

func TestValidRequestID(t *testing.T) {
	for _, n := range []int{0, 1, 15, 16, 17, 127, 128, 129} {
		if got := ValidRequestID(strings.Repeat("a", n)); got != (n >= 16 && n <= 128) {
			t.Errorf("length %d: %v", n, got)
		}
	}
	// Freeze every ASCII character, including the distinction from dot-allowing
	// telemetry labels. Check characters at both ends, not just a regexp prefix.
	for c := byte(0); c < 128; c++ {
		allowed := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_'
		for _, id := range []string{string(c) + strings.Repeat("a", 15), strings.Repeat("a", 15) + string(c)} {
			if ValidRequestID(id) != allowed {
				t.Errorf("character %q: %v", c, !allowed)
			}
		}
	}
	for _, id := range []string{"abcdefghijklmnopé", "abcdefghijklmnop\xff", "你好abcdefghijklmnop"} {
		if ValidRequestID(id) {
			t.Errorf("accepted non-ASCII ID %q", id)
		}
	}
}
