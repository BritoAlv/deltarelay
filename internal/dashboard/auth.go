package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

// Only this allowlisted metadata is returned, never Credential.Value or its
// access/refresh tokens. Polling reads saved credentials; it does not resolve or
// refresh them, start OpenCode, edit its database, or call a model provider.
type AuthStatus struct {
	State     string     `json:"state"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CheckedAt *time.Time `json:"checked_at,omitempty"`
	Stale     bool       `json:"stale"`
}

func privateFile(path string, value any) error {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 65536 || !ok || owner.Uid != uint32(os.Getuid()) {
		return errors.New("unsafe private service registration")
	}
	return json.NewDecoder(io.LimitReader(f, 65537)).Decode(value)
}

func (h *Handler) authStatus(ctx context.Context) AuthStatus {
	if h.config.OpenCodeServiceFile == "" {
		return AuthStatus{State: "not_configured"}
	}
	h.authMu.Lock()
	defer h.authMu.Unlock()
	if time.Now().Before(h.authNext) {
		return h.authCache
	}
	status, err := h.readAuth(ctx)
	if err != nil {
		log.Printf("dashboard auth metadata check failed: %v (credentials and response bodies omitted)", err)
		status = h.authCache
		status.Stale = true
		status.State = "unavailable"
	}
	log.Printf("dashboard auth metadata check: state=%s stale=%t; no token refresh or model request", status.State, status.Stale)
	h.authCache, h.authNext = status, time.Now().Add(10*time.Second)
	return status
}

func (h *Handler) readAuth(ctx context.Context) (AuthStatus, error) {
	var registration struct {
		URL      string `json:"url"`
		Password string `json:"password"`
	}
	if err := privateFile(h.config.OpenCodeServiceFile, &registration); err != nil {
		return AuthStatus{}, err
	}
	u, err := url.Parse(registration.URL)
	if err != nil || u.Scheme != "http" || !LoopbackHost(u.Hostname()) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || registration.Password == "" {
		return AuthStatus{}, errors.New("invalid local service registration")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	read := func(path string, target any) error {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(registration.URL, "/")+path, nil)
		if err != nil {
			return err
		}
		// OpenCode's registered local service authenticates with HTTP Basic.
		request.SetBasicAuth("opencode", registration.Password)
		started := time.Now()
		log.Printf("dashboard auth metadata: GET %s (authentication headers omitted)", request.URL)
		response, err := h.client.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		log.Printf("dashboard auth metadata: HTTP status=%d elapsed=%s (response body omitted)", response.StatusCode, time.Since(started).Round(time.Millisecond))
		if response.StatusCode != 200 {
			return errors.New("service metadata unavailable")
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		if err != nil || len(data) > 1<<20 {
			return errors.New("invalid service response")
		}
		return json.Unmarshal(data, target)
	}
	var credentials struct {
		Data []struct {
			ID          string `json:"id"`
			Integration string `json:"integrationID"`
			Active      bool   `json:"active"`
			Value       struct {
				Type    string `json:"type"`
				Expires int64  `json:"expires"` // OpenCode V2 Unix milliseconds.
			} `json:"value"`
		} `json:"data"`
	}
	if err := read("/api/credential", &credentials); err != nil {
		return AuthStatus{}, err
	}
	now := time.Now().UTC()
	result := AuthStatus{State: "not_connected", CheckedAt: &now}
	for _, credential := range credentials.Data {
		if credential.Integration != h.config.AuthIntegration || !credential.Active {
			continue
		}
		if credential.Value.Type != "oauth" {
			result.State = "not_oauth"
			return result, nil
		}
		if credential.Value.Expires <= 0 {
			result.State = "expiry_unknown"
			return result, nil
		}
		expires := time.UnixMilli(credential.Value.Expires).UTC()
		result.ExpiresAt, result.State = &expires, "valid"
		if !expires.After(now) {
			result.State = "expired_pending_refresh"
		} else if expires.Sub(now) <= 15*time.Minute {
			result.State = "expires_soon"
		}
		var integration struct {
			Data struct {
				Connections []struct {
					ID     string `json:"id"`
					Status *struct {
						Status string `json:"status"`
					} `json:"status"`
				} `json:"connections"`
			} `json:"data"`
		}
		if err := read("/api/integration/"+url.PathEscape(h.config.AuthIntegration), &integration); err != nil {
			result.Stale = true
			return result, nil
		}
		for _, connection := range integration.Data.Connections {
			if connection.ID == credential.ID && connection.Status != nil && connection.Status.Status == "needs_auth" {
				result.State = "needs_auth"
			}
		}
		return result, nil
	}
	return result, nil
}
