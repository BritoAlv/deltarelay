package dashboard

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

const goUsageCacheTTL = 30 * time.Second

// API keys are sent only to OpenCode's usage endpoint, never a URL supplied by
// the browser or credential metadata. Redirects are disabled by h.client.
const goUsageURL = "https://opencode.ai/zen/go/v1/usage"

// AllowanceMeter is the sanitized OpenCode Go allowance for one window. The
// browser only needs the percentage, whether the window is exhausted, and the
// reset time; workspace identifiers and credentials stay on the server.
type AllowanceMeter struct {
	Percent  float64   `json:"percent"`
	Limited  bool      `json:"limited"`
	ResetsAt time.Time `json:"resets_at"`
}

// GoAllowance is the OpenCode Go usage shown on the Provider details card.
// Stale means the last successful observation is still displayed after a
// failed refresh; the rest of the system status remains usable.
type GoAllowance struct {
	Rolling   AllowanceMeter `json:"rolling"`
	Weekly    AllowanceMeter `json:"weekly"`
	Monthly   AllowanceMeter `json:"monthly"`
	CheckedAt time.Time      `json:"checked_at"`
	Stale     bool           `json:"stale"`
}

// GoAccountUsage exposes a saved key's display label, selection state, allowance
// and an opaque view ID. Neither the key nor its credential/workspace identifiers
// are sent to the browser. The private identity also prevents stale usage
// surviving a key replacement.
type GoAccountUsage struct {
	ID        string       `json:"id"`
	Label     string       `json:"label"`
	Active    bool         `json:"active"`
	State     string       `json:"state"`
	Allowance *GoAllowance `json:"allowance,omitempty"`

	credentialID string
	keyHash      [32]byte
}

type goCredential struct {
	ID          string `json:"id"`
	Integration string `json:"integrationID"`
	Label       string `json:"label"`
	Active      bool   `json:"active"`
	Value       struct {
		Type string `json:"type"`
		Key  string `json:"key"`
	} `json:"value"`
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

// goAllowances returns immediately with cached allowances, refreshing expired
// observations in the background. Usage service latency must never delay system
// status, including concurrent requests while a refresh is already in flight.
func (h *Handler) goAllowances(ctx context.Context) (*GoAllowance, []GoAccountUsage) {
	if h.config.OpenCodeServiceFile == "" {
		return nil, nil
	}
	h.usageMu.Lock()
	defer h.usageMu.Unlock()
	expired := !time.Now().Before(h.usageNext)
	if expired && !h.usageRefreshing {
		h.usageRefreshing = true
		go h.refreshGoAllowance(context.WithoutCancel(ctx))
	}
	stale := expired || h.usageErr != nil
	var allowance *GoAllowance
	if h.usageCache != nil {
		cached := *h.usageCache
		cached.Stale = stale
		allowance = &cached
	}
	accounts := append([]GoAccountUsage(nil), h.usageAccounts...)
	for i := range accounts {
		if accounts[i].Allowance != nil {
			cached := *accounts[i].Allowance
			cached.Stale = cached.Stale || stale
			accounts[i].Allowance = &cached
		}
	}
	return allowance, accounts
}

func (h *Handler) refreshGoAllowance(ctx context.Context) {
	usage, accounts, err := h.readGoUsage(ctx)
	h.usageMu.Lock()
	defer h.usageMu.Unlock()
	h.usageRefreshing = false
	h.usageNext = time.Now().Add(goUsageCacheTTL)
	if err != nil {
		h.usageErr = err
		if h.usageCache == nil && len(h.usageAccounts) == 0 {
			log.Printf("dashboard Go usage unavailable: %v (credentials and response bodies omitted)", err)
		}
		return
	}
	h.usageErr = nil
	for i := range accounts {
		account := &accounts[i]
		if account.State != "unavailable" {
			continue
		}
		for _, previous := range h.usageAccounts {
			if previous.credentialID == account.credentialID && previous.keyHash == account.keyHash && previous.Allowance != nil {
				cached := *previous.Allowance
				cached.Stale = true
				account.Allowance = &cached
				break
			}
		}
	}
	h.usageAccounts = accounts
	if usage != nil {
		usage.CheckedAt, usage.Stale = time.Now().UTC(), false
	}
	h.usageCache = usage
}

func (h *Handler) readGoUsage(ctx context.Context) (*GoAllowance, []GoAccountUsage, error) {
	base, password, err := h.openCodeService()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/credential", nil)
	request.SetBasicAuth("opencode", password)
	request.Header.Set("Accept", "application/json")
	var payload struct {
		Data *[]goCredential `json:"data"`
	}
	if err := h.readUsageJSON(request, &payload); err != nil || payload.Data == nil {
		return nil, nil, errors.New("OpenCode Go credential discovery is unavailable")
	}
	var keys []goCredential
	for _, credential := range *payload.Data {
		// Saved, inactive keys are intentional: switching accounts must not be
		// necessary just to see their allowances. Never activate or resolve them.
		if (credential.Integration == "opencode-go" || credential.Integration == "opencode") && credential.Value.Type == "key" && credential.Value.Key != "" && credential.ID != "" {
			keys = append(keys, credential)
		}
	}
	if len(keys) == 0 {
		// Retain Console-sign-in usage when no API keys are saved.
		usage, err := h.readGoAllowance(ctx)
		return usage, nil, err
	}
	accounts := make([]GoAccountUsage, len(keys))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for range min(4, len(keys)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				accounts[i] = h.readGoKeyUsage(ctx, keys[i], i)
			}
		}()
	}
	for i := range keys {
		jobs <- i
	}
	close(jobs)
	workers.Wait()
	return nil, accounts, nil
}

func (h *Handler) readGoKeyUsage(ctx context.Context, credential goCredential, index int) GoAccountUsage {
	label := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.ReplaceAll(credential.Label, credential.Value.Key, "[redacted]")))
	if label == "" {
		label = fmt.Sprintf("API key %d", index+1)
	}
	if runes := []rune(label); len(runes) > 80 {
		label = string(runes[:80])
	}
	identity := credential.Integration + ":" + credential.ID
	viewID := sha256.Sum256([]byte(h.nonce + ":" + identity))
	result := GoAccountUsage{
		ID:    fmt.Sprintf("%x", viewID[:16]),
		Label: label, Active: credential.Active, State: "unavailable",
		credentialID: identity,
		keyHash:      sha256.Sum256([]byte(credential.Value.Key)),
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, goUsageURL, nil)
	request.Header.Set("Authorization", "Bearer "+credential.Value.Key)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "deltarelay-dashboard")
	response, err := h.client.Do(request)
	if err != nil {
		return result
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusUnauthorized:
		result.State = "invalid_key"
		return result
	case http.StatusForbidden:
		result.State = "forbidden"
		return result
	}
	var payload struct {
		Usage *struct {
			Rolling *goKeyMeterPayload `json:"rolling"`
			Weekly  *goKeyMeterPayload `json:"weekly"`
			Monthly *goKeyMeterPayload `json:"monthly"`
		} `json:"usage"`
	}
	if decodeUsageJSON(response, &payload) != nil || payload.Usage == nil {
		return result
	}
	rolling, rollingOK := sanitizeGoKeyMeter(payload.Usage.Rolling)
	weekly, weeklyOK := sanitizeGoKeyMeter(payload.Usage.Weekly)
	monthly, monthlyOK := sanitizeGoKeyMeter(payload.Usage.Monthly)
	if !rollingOK || !weeklyOK || !monthlyOK {
		return result
	}
	result.State = "ready"
	result.Allowance = &GoAllowance{Rolling: rolling, Weekly: weekly, Monthly: monthly, CheckedAt: time.Now().UTC()}
	return result
}

type goKeyMeterPayload struct {
	Percent  *float64 `json:"percent"`
	Status   string   `json:"status"`
	ResetsAt string   `json:"resetsAt"`
}

func sanitizeGoKeyMeter(raw *goKeyMeterPayload) (AllowanceMeter, bool) {
	if raw == nil || raw.Percent == nil || (raw.Status != "ok" && raw.Status != "rate-limited") {
		return AllowanceMeter{}, false
	}
	resets, err := time.Parse(time.RFC3339Nano, raw.ResetsAt)
	if err != nil {
		return AllowanceMeter{}, false
	}
	limited, resetsAt := raw.Status == "rate-limited", resets.UnixMilli()
	return sanitizeAllowanceMeter(&usageMeterPayload{Percent: raw.Percent, Limited: &limited, ResetsAt: &resetsAt})
}

func (h *Handler) readUsageJSON(request *http.Request, target any) error {
	response, err := h.client.Do(request)
	if err != nil {
		return errors.New("OpenCode Go usage request failed")
	}
	defer response.Body.Close()
	return decodeUsageJSON(response, target)
}

func decodeUsageJSON(response *http.Response, target any) error {
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return errors.New("OpenCode Go usage is unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || json.Unmarshal(data, target) != nil {
		return errors.New("invalid OpenCode Go usage response")
	}
	return nil
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
	var payload usageLimitsPayload
	if err := h.readUsageJSON(request, &payload); err != nil {
		return nil, err
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
