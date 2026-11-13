package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const goUsageCacheTTL = 30 * time.Second

// AllowanceMeter is the sanitized OpenCode Go allowance for one window. The
// browser only needs the percentage, whether the window is exhausted, and the
// reset time; workspace identifiers and credentials stay on the server.
type AllowanceMeter struct {
	Percent  float64   `json:"percent"`
	Limited  bool      `json:"limited"`
	ResetsAt time.Time `json:"resets_at"`
}

// GoAllowance is the OpenCode Go usage shown on the Provider forwarding card.
// Stale means the last successful observation is still displayed after a
// failed refresh; the rest of the system status remains usable.
type GoAllowance struct {
	Rolling   AllowanceMeter `json:"rolling"`
	Weekly    AllowanceMeter `json:"weekly"`
	Monthly   AllowanceMeter `json:"monthly"`
	CheckedAt time.Time      `json:"checked_at"`
	Stale     bool           `json:"stale"`
}

type usageMeterPayload struct {
	Percent  *float64 `json:"percent"`
	Limited  *bool    `json:"limited"`
	ResetsAt *int64   `json:"resetsAt"`
}

type usageLimitsPayload struct {
	Data *struct {
		Go *struct {
			Rolling *usageMeterPayload `json:"rolling"`
			Weekly  *usageMeterPayload `json:"weekly"`
			Monthly *usageMeterPayload `json:"monthly"`
		} `json:"go"`
	} `json:"data"`
}

// goAllowance returns the cached Go allowance. A missing subscription or a
// profile that is not signed in returns nil rather than an error so the card
// can stay neutral.
func (h *Handler) goAllowance(ctx context.Context) *GoAllowance {
	if h.config.OpenCodeServiceFile == "" {
		return nil
	}
	h.usageMu.Lock()
	defer h.usageMu.Unlock()
	if time.Now().Before(h.usageNext) {
		if h.usageCache == nil {
			return nil
		}
		cached := *h.usageCache
		cached.Stale = h.usageErr != nil
		return &cached
	}
	usage, err := h.readGoAllowance(ctx)
	h.usageNext = time.Now().Add(goUsageCacheTTL)
	if err != nil {
		h.usageErr = err
		if h.usageCache != nil {
			cached := *h.usageCache
			cached.Stale = true
			return &cached
		}
		log.Printf("dashboard Go usage unavailable: %v (credentials and response bodies omitted)", err)
		return nil
	}
	h.usageErr = nil
	if usage == nil {
		h.usageCache = nil
		return nil
	}
	usage.CheckedAt, usage.Stale = time.Now().UTC(), false
	h.usageCache = usage
	return usage
}

func (h *Handler) readGoAllowance(ctx context.Context) (*GoAllowance, error) {
	base, password, err := h.openCodeService()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/experimental/usage/limits", nil)
	if err != nil {
		return nil, err
	}
	// OpenCode's registered local service authenticates with HTTP Basic.
	request.SetBasicAuth("opencode", password)
	response, err := h.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return nil, errors.New("OpenCode Go usage is unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return nil, errors.New("invalid OpenCode Go usage response")
	}
	var payload usageLimitsPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, errors.New("invalid OpenCode Go usage response")
	}
	// A missing Go block means this profile has no Go subscription or is not
	// signed in; that is a normal state, not a failed observation.
	if payload.Data == nil || payload.Data.Go == nil {
		return nil, nil
	}
	rolling, ok := sanitizeAllowanceMeter(payload.Data.Go.Rolling)
	if !ok {
		return nil, errors.New("invalid OpenCode Go rolling allowance")
	}
	weekly, ok := sanitizeAllowanceMeter(payload.Data.Go.Weekly)
	if !ok {
		return nil, errors.New("invalid OpenCode Go weekly allowance")
	}
	monthly, ok := sanitizeAllowanceMeter(payload.Data.Go.Monthly)
	if !ok {
		return nil, errors.New("invalid OpenCode Go monthly allowance")
	}
	return &GoAllowance{Rolling: rolling, Weekly: weekly, Monthly: monthly}, nil
}

func sanitizeAllowanceMeter(raw *usageMeterPayload) (AllowanceMeter, bool) {
	if raw == nil || raw.Percent == nil || raw.Limited == nil || raw.ResetsAt == nil {
		return AllowanceMeter{}, false
	}
	if math.IsNaN(*raw.Percent) || math.IsInf(*raw.Percent, 0) || *raw.Percent < 0 || *raw.Percent > 100 || *raw.ResetsAt <= 0 {
		return AllowanceMeter{}, false
	}
	return AllowanceMeter{Percent: *raw.Percent, Limited: *raw.Limited, ResetsAt: time.UnixMilli(*raw.ResetsAt).UTC()}, true
}

func (h *Handler) openCodeService() (string, string, error) {
	var registration struct {
		URL      string `json:"url"`
		Password string `json:"password"`
	}
	if err := privateFile(h.config.OpenCodeServiceFile, &registration); err != nil {
		return "", "", errors.New("invalid OpenCode service registration")
	}
	u, err := url.Parse(registration.URL)
	if err != nil || u.Scheme != "http" || !LoopbackHost(u.Hostname()) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || registration.Password == "" {
		return "", "", errors.New("invalid OpenCode service registration")
	}
	return strings.TrimSuffix(registration.URL, "/"), registration.Password, nil
}
