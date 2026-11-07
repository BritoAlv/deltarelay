package dashboard

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"regexp"
	"time"
	"unicode"
	"unicode/utf8"
)

type ComponentStatus struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	State      string `json:"state"`
	CanStart   bool   `json:"can_start"`
	CanRestart bool   `json:"can_restart"`
}

type RemoteStatus struct {
	ID           string   `json:"id"`
	Label        string   `json:"label"`
	HostState    string   `json:"host_state"`
	Capabilities []string `json:"capabilities"`
}

type SystemStatus struct {
	Version     int    `json:"version"`
	Managed     bool   `json:"managed"`
	CollectedAt string `json:"collected_at"`
	CSRFToken   string `json:"csrf_token"`
	Error       string `json:"error,omitempty"`
	Settings    struct {
		AutoReconnect bool `json:"auto_reconnect"`
		AutoWake      bool `json:"auto_wake"`
	} `json:"settings"`
	Recovery struct {
		Busy            bool    `json:"busy"`
		Phase           string  `json:"phase"`
		Attempts        int     `json:"attempts"`
		LastError       string  `json:"last_error"`
		LastConnectedAt *string `json:"last_connected_at"`
		NextRetryAt     *string `json:"next_retry_at"`
	} `json:"recovery"`
	RelayState        string            `json:"relay_state"`
	InternetState     string            `json:"internet_state"`
	InternetCheckedAt *string           `json:"internet_checked_at"`
	Remote            RemoteStatus      `json:"remote"`
	Components        []ComponentStatus `json:"components"`
	Auth              AuthStatus        `json:"auth"`
	Topology          *TopologyStatus   `json:"topology,omitempty"`
}

var remoteID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

func validRemote(remote RemoteStatus) bool {
	if !remoteID.MatchString(remote.ID) || utf8.RuneCountInString(remote.Label) == 0 || utf8.RuneCountInString(remote.Label) > 80 || len(remote.Capabilities) > 4 || remote.Capabilities == nil {
		return false
	}
	for _, r := range remote.Label {
		if unicode.IsControl(r) {
			return false
		}
	}
	switch remote.HostState {
	case "running", "stopped", "starting", "stopping", "unknown":
	default:
		return false
	}
	seen := map[string]bool{}
	for _, capability := range remote.Capabilities {
		switch capability {
		case "relay.ensure", "relay.restart", "host.wake", "host.stop":
		default:
			return false
		}
		if seen[capability] {
			return false
		}
		seen[capability] = true
	}
	return true
}

func controlClient(socket string) *http.Client {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	return &http.Client{Transport: transport, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (h *Handler) system(w http.ResponseWriter, r *http.Request) {
	result := SystemStatus{Version: 2, CollectedAt: time.Now().UTC().Format(time.RFC3339), Components: []ComponentStatus{}, Error: "controls_not_configured", Remote: RemoteStatus{ID: "configured", Label: "Remote host", HostState: "unknown", Capabilities: []string{}}}
	if h.control != nil {
		result.Error = "supervisor_unavailable"
		request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "http://supervisor/status", nil)
		response, err := h.control.Do(request)
		if err == nil {
			defer response.Body.Close()
			data, readErr := io.ReadAll(io.LimitReader(response.Body, 65537))
			if response.StatusCode == 200 && readErr == nil && len(data) <= 65536 {
				if state, ok := decodeSupervisorStatus(data); ok {
					result = state
				}
			}
		}
	}
	result.CSRFToken = h.nonce
	result.Auth = h.authStatus(r.Context())
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(result)
	}
}

func (h *Handler) writeControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.RawQuery != "" || r.URL.Fragment != "" {
		http.Error(w, "query parameters are not accepted", http.StatusBadRequest)
		return
	}
	// Unlike read-only diagnostics, actions require an exact Origin and an
	// unpredictable per-process nonce. Never put service tokens in browser storage.
	if r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Content-Type") != "application/json" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-DeltaRelay-Control")), []byte(h.nonce)) != 1 {
		http.Error(w, "same-origin control authorization required", http.StatusForbidden)
		return
	}
	if h.control == nil {
		writeUnavailable(w, 503, "controls_not_configured")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		writeUnavailable(w, 400, "invalid_request")
		return
	}
	path := "/action"
	if r.URL.Path == "/api/system/settings" {
		path = "/settings"
	} else if r.URL.Path == "/api/system/setup" {
		path = "/setup"
	}
	// The supervisor validates fixed schemas, including the setup destination.
	// No shell commands, incoming headers, or queries follow.
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, "http://supervisor"+path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	response, err := h.control.Do(request)
	if err != nil {
		writeUnavailable(w, 503, "supervisor_unavailable")
		return
	}
	defer response.Body.Close()
	var answer struct {
		Accepted bool   `json:"accepted"`
		Error    string `json:"error,omitempty"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&answer) != nil {
		writeUnavailable(w, 502, "invalid_supervisor_response")
		return
	}
	status := response.StatusCode
	if status != 202 && status != 400 && status != 409 {
		writeUnavailable(w, 502, "supervisor_unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(answer)
}
