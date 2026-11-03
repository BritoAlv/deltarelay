// Package client chunks local bodies and transfers only missing content.
package client

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"deltarelay/internal/chunker"
	"deltarelay/internal/protocol"
)

type Config struct {
	URL             string
	Token           string
	HTTPClient      *http.Client
	AllowHTTP       bool
	Chunking        chunker.Config
	Workers         int
	BatchBytes      int
	NoCompression   bool
	MaxBodySize     int64
	HeaderTimeout   time.Duration
	RetryWindow     time.Duration
	RetryMin        time.Duration
	RetryMax        time.Duration
	StallTimeout    time.Duration
	NoRetry         bool
	ControlDir      string
	ExpectedStateID string
	// Nil permits initial synchronization. A non-nil value caps missing raw
	// bytes BEFORE upload; zero allows cache hits only. There is no bypass.
	MaxUploadBytes *int64
	TempDir        string
}

// Defaults are owned by the client because they define its transport and
// recovery behavior. CLI flags reuse them where the command has the same
// semantics; deliberately different composition defaults stay at the call site.
const (
	DefaultWorkers       = 4
	DefaultBatchBytes    = 256 << 10
	DefaultHeaderTimeout = 5 * time.Minute
	DefaultRetryWindow   = time.Hour
	DefaultRetryMin      = time.Second
	DefaultRetryMax      = 30 * time.Second
	DefaultStallTimeout  = 2 * time.Minute
)

type Client struct {
	config     Config
	http       *http.Client
	base       string
	cacheSlots chan struct{}
	stateMu    sync.Mutex
	stateID    string
	control    *controls
}

var ErrUploadBudget = errors.New("upload budget exceeded")
var ErrBodyLimit = errors.New("input exceeds configured body or chunk-count limit")

type HTTPError struct {
	Status     int
	Detail     string
	Code       string
	RetryAfter time.Duration
}

// TransportError means the relay could not be reached, or the connection broke
// before a complete HTTP response. MayHaveDispatched is set only for the final
// forwarding request, where the VPS may already have contacted the provider.
type TransportError struct {
	Err               error
	MayHaveDispatched bool
}

func (e *TransportError) Error() string { return e.Err.Error() }
func (e *TransportError) Unwrap() error { return e.Err }

func (e *HTTPError) Error() string {
	return fmt.Sprintf("relay returned HTTP %d: %s", e.Status, e.Detail)
}

func New(config Config) (*Client, error) {
	u, err := url.Parse(config.URL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("server URL must be an HTTP(S) origin without credentials, path, query, or fragment")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
		if u.Scheme != "http" || (!loopback && !config.AllowHTTP) {
			return nil, errors.New("HTTPS required except on loopback; use an SSH tunnel or explicitly allow insecure HTTP")
		}
	}
	if config.Token == "" {
		return nil, errors.New("authentication token is required")
	}
	if config.Chunking == (chunker.Config{}) {
		config.Chunking = chunker.DefaultConfig()
	}
	if err := config.Chunking.Validate(); err != nil {
		return nil, err
	}
	if config.Workers == 0 {
		config.Workers = DefaultWorkers
	}
	if config.Workers < 1 || config.Workers > 32 {
		return nil, errors.New("workers must be between 1 and 32")
	}
	if config.BatchBytes == 0 {
		config.BatchBytes = DefaultBatchBytes
	}
	if config.BatchBytes < config.Chunking.Max+protocol.ChunkHeaderSize+protocol.BatchHeaderSize || config.BatchBytes > protocol.MaxUploadBatchBytes {
		return nil, errors.New("batch size must fit a maximum-sized chunk and be at most 16 MiB")
	}
	if config.MaxBodySize == 0 {
		config.MaxBodySize = protocol.DefaultMaxBodySize
	}
	if config.MaxBodySize < 1 || config.MaxBodySize > protocol.DefaultMaxBodySize {
		return nil, errors.New("maximum body size must be between 1 and 256 MiB")
	}
	if config.MaxUploadBytes != nil && *config.MaxUploadBytes < 0 {
		return nil, errors.New("upload budget must be non-negative")
	}
	if config.RetryWindow == 0 {
		config.RetryWindow = DefaultRetryWindow
	}
	if config.RetryMin == 0 {
		config.RetryMin = DefaultRetryMin
	}
	if config.RetryMax == 0 {
		config.RetryMax = DefaultRetryMax
	}
	if config.StallTimeout == 0 {
		config.StallTimeout = DefaultStallTimeout
	}
	if config.RetryWindow < 0 || config.RetryMin <= 0 || config.RetryMax < config.RetryMin || config.StallTimeout <= 0 {
		return nil, errors.New("invalid retry or stall timeouts")
	}
	if config.ExpectedStateID != "" && !protocol.ValidHash(config.ExpectedStateID) {
		return nil, errors.New("invalid expected relay state ID")
	}
	var transport *http.Client
	if config.HTTPClient != nil {
		copy := *config.HTTPClient
		transport = &copy
	} else {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.MaxIdleConns = 32
		t.MaxIdleConnsPerHost = config.Workers + 2
		// Long-lived inference streams must not consume every connection and
		// starve chunk uploads. Cache RPC concurrency is bounded separately.
		t.MaxConnsPerHost = 0
		t.ResponseHeaderTimeout = config.HeaderTimeout
		if t.ResponseHeaderTimeout == 0 {
			t.ResponseHeaderTimeout = DefaultHeaderTimeout
		}
		transport = &http.Client{Transport: t}
	}
	// A redirect must never leak the bearer token or silently change endpoints.
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	c := &Client{config: config, http: transport, base: strings.TrimSuffix(config.URL, "/"), cacheSlots: make(chan struct{}, config.Workers), stateID: config.ExpectedStateID}
	if err := c.openControls(); err != nil {
		return nil, err
	}
	return c, nil
}
