package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"deltarelay/internal/usage"
)

type namedCredential struct {
	hash        [32]byte
	key         usage.Key
	integration string
}

type savedCredential struct {
	Key         usage.Key
	Integration string
}

// credentialNames polls only the registered, loopback OpenCode service. Secrets
// and their matching hashes live in memory only; historical metrics contain an
// opaque saved-record identity and its sanitized name, never a key fingerprint.
type credentialNames struct {
	mu     sync.RWMutex
	items  []namedCredential
	cancel context.CancelFunc
	done   chan struct{}
	ready  chan struct{}
	once   sync.Once
}

func openCredentialNames(file string) *credentialNames {
	c := &credentialNames{done: make(chan struct{}), ready: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	go func() {
		defer close(c.done)
		if file == "" {
			return
		}
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		defer client.CloseIdleConnections()
		for {
			c.refresh(ctx, client, file)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
		}
	}()
	return c
}

func (c *credentialNames) close() { c.cancel(); <-c.done }

// waitReady reports whether at least one successful credential refresh has
// completed. It also returns when the worker is closed.
func (c *credentialNames) waitReady() bool {
	select {
	case <-c.ready:
		return true
	case <-c.done:
		return false
	}
}

// keys returns every saved credential label once, independent of whether it
// has been observed in retained requests. Secrets and fingerprints are never
// included.
func (c *credentialNames) keys() []usage.Key {
	saved := c.saved()
	keys := make([]usage.Key, 0, len(saved))
	for _, item := range saved {
		keys = append(keys, item.Key)
	}
	return keys
}

// saved returns every matched credential with its local integration hint. The
// integration is used only to assign historical requests to the right saved
// credential; it is never exposed with a request or in an export.
func (c *credentialNames) saved() []savedCredential {
	c.mu.RLock()
	defer c.mu.RUnlock()
	seen := make(map[string]bool, len(c.items))
	saved := make([]savedCredential, 0, len(c.items))
	for _, item := range c.items {
		if seen[item.key.ID] {
			continue
		}
		seen[item.key.ID] = true
		saved = append(saved, savedCredential{Key: item.key, Integration: item.integration})
	}
	return saved
}

func (c *credentialNames) resolve(headers http.Header) *usage.Key {
	secret := ""
	if scheme, value, ok := strings.Cut(headers.Get("Authorization"), " "); ok && strings.EqualFold(scheme, "Bearer") {
		secret = strings.TrimSpace(value)
	}
	for _, name := range []string{"X-Api-Key", "Api-Key", "X-Goog-Api-Key"} {
		if secret == "" {
			secret = headers.Get(name)
		}
	}
	if secret == "" {
		return nil
	}
	hash := sha256.Sum256([]byte(secret))
	c.mu.RLock()
	defer c.mu.RUnlock()
	var found *usage.Key
	for _, item := range c.items {
		if item.hash != hash {
			continue
		}
		// Duplicate saved secrets with different names are ambiguous. Never
		// attribute them according to the currently selected account.
		if found != nil && found.ID != item.key.ID {
			return nil
		}
		key := item.key
		found = &key
	}
	return found
}

func (c *credentialNames) refresh(ctx context.Context, client *http.Client, file string) {
	f, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 8192 {
		return
	}
	var registration struct{ URL, Password string }
	if json.NewDecoder(io.LimitReader(f, 8193)).Decode(&registration) != nil {
		return
	}
	u, err := url.Parse(registration.URL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || registration.Password == "" {
		return
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return
	}
	r, err := http.NewRequestWithContext(ctx, "GET", strings.TrimSuffix(u.String(), "/")+"/api/credential", nil)
	if err != nil {
		return
	}
	r.SetBasicAuth("opencode", registration.Password)
	r.Header.Set("Accept", "application/json")
	response, err := client.Do(r)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return
	}
	var payload struct {
		Data *[]struct {
			ID          string `json:"id"`
			Integration string `json:"integrationID"`
			Label       string `json:"label"`
			Value       struct {
				Type   string `json:"type"`
				Key    string `json:"key"`
				Access string `json:"access"`
			} `json:"value"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &payload) != nil || payload.Data == nil {
		return
	}
	items := []namedCredential{}
	for _, record := range *payload.Data {
		// Saved API keys are matched by their secret. OAuth records are matched
		// by the current access token; token rotation is picked up by the poll.
		secret := ""
		switch record.Value.Type {
		case "key":
			secret = record.Value.Key
		case "oauth":
			secret = record.Value.Access
			if secret == "" {
				secret = record.Value.Key
			}
		}
		if record.ID == "" || secret == "" {
			continue
		}
		// Keep the original derivation so existing retained attribution keeps the
		// same opaque local reference. This is not a provider key fingerprint.
		identity := sha256.Sum256([]byte("deltarelay.saved-key.v1:" + record.Integration + ":" + record.ID))
		name := usage.Label(strings.ReplaceAll(record.Label, secret, "[redacted]"))
		if name == "" {
			name = "Unnamed credential"
		}
		items = append(items, namedCredential{hash: sha256.Sum256([]byte(secret)), key: usage.Key{ID: hex.EncodeToString(identity[:16]), Name: name}, integration: record.Integration})
	}
	c.mu.Lock()
	c.items = items
	c.mu.Unlock()
	c.once.Do(func() { close(c.ready) })
}
