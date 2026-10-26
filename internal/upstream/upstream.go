// Package upstream validates destinations and strips transport-only headers.
package upstream

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"

	"deltarelay/internal/protocol"
)

type Rule struct {
	Name       string `json:"name"`
	Origin     string `json:"origin"`
	PathPrefix string `json:"path_prefix"`
}

type Policy struct {
	rules        []Rule
	allowPrivate bool
}

func NewPolicy(rules []Rule, allowPrivate bool) (*Policy, error) {
	p := &Policy{allowPrivate: allowPrivate}
	for _, rule := range rules {
		u, err := url.Parse(rule.Origin)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(allowPrivate && u.Scheme == "http")) {
			return nil, errors.New("upstream rules require HTTPS origins without credentials, paths, or queries")
		}
		if rule.Name == "" || len(rule.Name) > 64 || !strings.HasPrefix(rule.PathPrefix, "/") || !strings.HasSuffix(rule.PathPrefix, "/") || strings.ContainsAny(rule.PathPrefix, "%?#\\") || path.Clean(rule.PathPrefix)+"/" != rule.PathPrefix && rule.PathPrefix != "/" {
			return nil, errors.New("upstream rules require a name and a clean slash-terminated path prefix")
		}
		rule.Origin = strings.TrimSuffix(u.String(), "/")
		p.rules = append(p.rules, rule)
	}
	return p, nil
}

func (p *Policy) Enabled() bool { return p != nil && len(p.rules) > 0 }

func (p *Policy) Match(target string) (Rule, error) {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.RawPath != "" || strings.ContainsAny(u.Path, "\\\x00") {
		return Rule{}, errors.New("invalid upstream URL")
	}
	// Encoded separators and dot segments must not escape an allowed API prefix.
	if path.Clean(u.Path) != strings.TrimSuffix(u.Path, "/") && u.Path != "/" {
		return Rule{}, errors.New("upstream URL must have a clean path")
	}
	for _, rule := range p.rules {
		origin, _ := url.Parse(rule.Origin)
		if u.Scheme == origin.Scheme && strings.EqualFold(u.Host, origin.Host) && strings.HasPrefix(u.Path, rule.PathPrefix) {
			return rule, nil
		}
	}
	return Rule{}, errors.New("upstream URL is not allowlisted")
}

func ValidRequestID(id string) bool {
	if len(id) < 16 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func ValidateHeaders(headers http.Header) error {
	var size, values int
	if len(headers) > 256 {
		return errors.New("too many upstream headers")
	}
	for name, list := range headers {
		if name == "" {
			return errors.New("invalid upstream header name")
		}
		for _, c := range name {
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("!#$%&'*+-.^_`|~", c)) {
				return errors.New("invalid upstream header name")
			}
		}
		for _, value := range list {
			values++
			size += len(name) + len(value) + 4
			for _, c := range value {
				if c == 127 || (c < 32 && c != '\t') {
					return errors.New("invalid upstream header value")
				}
			}
			if size > protocol.MaxHeaderBytes || values > 512 {
				return errors.New("upstream headers exceed limit")
			}
		}
	}
	return nil
}

// CleanHeaders applies to both request and response headers. Relay metadata and
// hop-by-hop headers must never reach a provider or escape as redirect targets.
func CleanHeaders(source http.Header) http.Header {
	result := make(http.Header)
	for name, values := range source {
		result[http.CanonicalHeaderKey(name)] = append(result[http.CanonicalHeaderKey(name)], values...)
	}
	for _, line := range result.Values("Connection") {
		for _, name := range strings.Split(line, ",") {
			result.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{"Connection", "Proxy-Connection", "Proxy-Authenticate", "Proxy-Authorization", "Keep-Alive", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "Host", "Content-Length"} {
		result.Del(name)
	}
	for name := range result {
		if strings.HasPrefix(strings.ToLower(name), "x-deltarelay-") {
			result.Del(name)
		}
	}
	return result
}

// HTTPClient resolves and checks the address actually dialed, preventing a DNS
// rebind or redirect from turning an allowed hostname into a private-network
// proxy. Environment HTTP proxies are intentionally not used for VPS egress.
func (p *Policy) HTTPClient(headerTimeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DisableCompression = true
	t.ResponseHeaderTimeout = headerTimeout
	t.MaxIdleConns = 64
	t.MaxIdleConnsPerHost = 16
	t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, errors.New("upstream DNS lookup failed")
		}
		for _, address := range addresses {
			ip := address.IP
			if !p.allowPrivate && !publicIP(ip) {
				return nil, errors.New("upstream DNS resolved to a forbidden network")
			}
		}
		for _, address := range addresses {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, errors.New("cannot connect to upstream")
	}
	return &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// CopyResponse streams through flushes without introducing fake SSE events.
// If a stream fails after headers, abort the HTTP stream rather than append an
// error JSON object to provider output or pretend a truncated answer completed.
func CopyResponse(w http.ResponseWriter, response *http.Response) (int64, error) {
	for name, values := range CleanHeaders(response.Header) {
		w.Header()[name] = values
	}
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	controller := http.NewResponseController(w)
	_ = controller.Flush()
	buffer := make([]byte, 32<<10)
	var total int64
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			written, err := w.Write(buffer[:n])
			total += int64(written)
			if err != nil {
				return total, err
			}
			if written != n {
				return total, io.ErrShortWrite
			}
			if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
				return total, err
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return total, nil
			}
			return total, readErr
		}
	}
}

var specialNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001:db8::/32"),
}

func publicIP(ip net.IP) bool {
	if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() || !ip.IsGlobalUnicast() {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	for _, prefix := range specialNetworks {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}
