package dashboard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	openCodeCatalogVersion = 1
	openCodePageLimit      = 100
	openCodeMaxPages       = 20
	openCodeMaxSessions    = openCodePageLimit * openCodeMaxPages
	openCodeMaxPageBytes   = 2 << 20
	openCodeCacheTTL       = 15 * time.Second
	openCodeMaxTitleRunes  = 300
	openCodeMaxLabelRunes  = 160
)

// OpenCodeSession is the minimal, local-only session metadata the dashboard
// exposes. It deliberately excludes messages, content, credentials, cost,
// token counts, permissions, and full filesystem paths.
type OpenCodeSession struct {
	ID        string    `json:"id"`
	Title     string    `json:"title,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Project   string    `json:"project,omitempty"`
	Agent     string    `json:"agent,omitempty"`
	Model     string    `json:"model,omitempty"`
}

type OpenCodeSessions struct {
	Version   int               `json:"version"`
	CheckedAt time.Time         `json:"checked_at"`
	Sessions  []OpenCodeSession `json:"sessions"`
	Truncated bool              `json:"truncated"`
	Stale     bool              `json:"stale"`
}

type openCodeSessionPayload struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Time  struct {
		Created int64 `json:"created"`
		Updated int64 `json:"updated"`
	} `json:"time"`
	Location struct {
		Directory string `json:"directory"`
	} `json:"location"`
	Agent string `json:"agent"`
	Model struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	} `json:"model"`
}

type openCodeSessionPage struct {
	Data   []openCodeSessionPayload `json:"data"`
	Cursor struct {
		Next string `json:"next"`
	} `json:"cursor"`
}

func (h *Handler) openCodeSessions(w http.ResponseWriter, r *http.Request) {
	if h.config.OpenCodeServiceFile == "" {
		writeUnavailable(w, http.StatusServiceUnavailable, "opencode_not_configured")
		return
	}
	data, err := h.openCodeCatalog(r.Context())
	if err != nil {
		log.Printf("dashboard OpenCode session catalog unavailable: %v", err)
		writeUnavailable(w, http.StatusBadGateway, "opencode_unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(data)
	}
}

// openCodeCatalog returns the bounded, sanitized OpenCode session catalog. A
// successful observation is cached briefly; a later failure keeps the last
// observation visible and marks it stale instead of hiding the picker.
func (h *Handler) openCodeCatalog(ctx context.Context) (OpenCodeSessions, error) {
	h.catalogMu.Lock()
	if time.Now().Before(h.catalogNext) {
		data, err := h.catalog, h.catalogErr
		h.catalogMu.Unlock()
		if err != nil {
			if data.Sessions == nil {
				return OpenCodeSessions{}, err
			}
			data.Stale = true
		}
		return data, nil
	}
	h.catalogMu.Unlock()

	data, err := h.fetchOpenCodeCatalog(ctx)

	h.catalogMu.Lock()
	defer h.catalogMu.Unlock()
	h.catalogNext = time.Now().Add(openCodeCacheTTL)
	if err != nil {
		h.catalogErr = err
		if h.catalog.Sessions != nil {
			stale := h.catalog
			stale.Stale = true
			return stale, nil
		}
		return OpenCodeSessions{}, err
	}
	h.catalog, h.catalogErr = data, nil
	return data, nil
}

func (h *Handler) fetchOpenCodeCatalog(ctx context.Context) (OpenCodeSessions, error) {
	var registration struct {
		URL      string `json:"url"`
		Password string `json:"password"`
	}
	if err := privateFile(h.config.OpenCodeServiceFile, &registration); err != nil {
		return OpenCodeSessions{}, errors.New("invalid OpenCode service registration")
	}
	u, err := url.Parse(registration.URL)
	if err != nil || u.Scheme != "http" || !LoopbackHost(u.Hostname()) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || registration.Password == "" {
		return OpenCodeSessions{}, errors.New("invalid OpenCode service registration")
	}
	base := strings.TrimSuffix(registration.URL, "/")
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	sessions := make([]OpenCodeSession, 0, openCodePageLimit)
	seen := make(map[string]bool)
	cursors := make(map[string]bool)
	cursor := ""
	truncated := false

	for page := 0; page < openCodeMaxPages; page++ {
		query := url.Values{"limit": []string{strconv.Itoa(openCodePageLimit)}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/session?"+query.Encode(), nil)
		if err != nil {
			return OpenCodeSessions{}, err
		}
		request.SetBasicAuth("opencode", registration.Password)
		response, err := h.client.Do(request)
		if err != nil {
			return OpenCodeSessions{}, err
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, openCodeMaxPageBytes+1))
		response.Body.Close()
		if response.StatusCode != http.StatusOK || readErr != nil || len(data) > openCodeMaxPageBytes || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
			return OpenCodeSessions{}, errors.New("invalid OpenCode session response")
		}
		var pageData openCodeSessionPage
		decoder := json.NewDecoder(bytes.NewReader(data))
		if decoder.Decode(&pageData) != nil {
			return OpenCodeSessions{}, errors.New("invalid OpenCode session response")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF || len(pageData.Data) > openCodePageLimit {
			return OpenCodeSessions{}, errors.New("invalid OpenCode session response")
		}
		for _, raw := range pageData.Data {
			session, ok := sanitizeOpenCodeSession(raw)
			if !ok {
				return OpenCodeSessions{}, errors.New("invalid OpenCode session metadata")
			}
			if seen[session.ID] {
				continue
			}
			seen[session.ID] = true
			sessions = append(sessions, session)
			if len(sessions) >= openCodeMaxSessions {
				truncated = true
				break
			}
		}
		if truncated {
			break
		}
		cursor = strings.TrimSpace(pageData.Cursor.Next)
		if cursor == "" {
			break
		}
		if cursors[cursor] {
			return OpenCodeSessions{}, errors.New("OpenCode session cursor loop")
		}
		cursors[cursor] = true
		if page == openCodeMaxPages-1 {
			truncated = true
		}
	}

	sort.SliceStable(sessions, func(i, j int) bool {
		if sessions[i].UpdatedAt.Equal(sessions[j].UpdatedAt) {
			return sessions[i].CreatedAt.After(sessions[j].CreatedAt)
		}
		return sessions[i].UpdatedAt.After(sessions[j].UpdatedAt)
	})
	return OpenCodeSessions{Version: openCodeCatalogVersion, CheckedAt: time.Now().UTC(), Sessions: sessions, Truncated: truncated}, nil
}

func sanitizeOpenCodeSession(raw openCodeSessionPayload) (OpenCodeSession, bool) {
	id := strings.TrimSpace(raw.ID)
	if !validOpenCodeSessionID(id) || raw.Time.Created <= 0 || raw.Time.Updated <= 0 {
		return OpenCodeSession{}, false
	}
	created := time.UnixMilli(raw.Time.Created).UTC()
	updated := time.UnixMilli(raw.Time.Updated).UTC()
	if updated.Before(created) {
		updated = created
	}
	project := ""
	if directory := strings.TrimSpace(raw.Location.Directory); directory != "" {
		directory = strings.ReplaceAll(directory, "\\", "/")
		if base := path.Base(strings.TrimRight(directory, "/")); base != "." && base != "/" && base != "" {
			project = cleanOpenCodeLabel(base, openCodeMaxLabelRunes)
		}
	}
	model := strings.Trim(strings.TrimSpace(raw.Model.ProviderID)+"/"+strings.TrimSpace(raw.Model.ID), "/")
	return OpenCodeSession{
		ID:        id,
		Title:     cleanOpenCodeLabel(raw.Title, openCodeMaxTitleRunes),
		CreatedAt: created,
		UpdatedAt: updated,
		Project:   project,
		Agent:     cleanOpenCodeLabel(raw.Agent, openCodeMaxLabelRunes),
		Model:     cleanOpenCodeLabel(model, openCodeMaxLabelRunes),
	}, true
}

func validOpenCodeSessionID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

func cleanOpenCodeLabel(value string, maxRunes int) string {
	value = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case unicode.IsControl(r):
			return -1
		case r >= '\u202a' && r <= '\u202e' || r >= '\u2066' && r <= '\u2069':
			return -1
		default:
			return r
		}
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > maxRunes {
		value = string(runes[:maxRunes])
	}
	return value
}
