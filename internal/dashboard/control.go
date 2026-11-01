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
	CodespaceState    string            `json:"codespace_state,omitempty"` // Decode old supervisors only.
	Components        []ComponentStatus `json:"components"`
	Auth              AuthStatus        `json:"auth"`
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

func legacyRemote(state string) RemoteStatus {
	remote := RemoteStatus{ID: "configured", Label: "Remote host", HostState: "unknown", Capabilities: []string{}}
	if state == "" || state == "not_configured" {
		return remote
	}
	remote.ID, remote.Label = "codespaces", "GitHub Codespaces"
	remote.Capabilities = []string{"relay.ensure", "relay.restart", "host.wake", "host.stop"}
	switch state {
	case "Available":
		remote.HostState = "running"
	case "Shutdown":
		remote.HostState = "stopped"
	case "ShuttingDown":
		remote.HostState = "stopping"
	case "Starting", "Queued", "Provisioning", "Awaiting":
		remote.HostState = "starting"
	}
	return remote
}

func controlClient(socket string) *http.Client {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	return &http.Client{Transport: transport, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (h *Handler) system(w http.ResponseWriter, r *http.Request) {
	result := SystemStatus{Version: 2, CollectedAt: time.Now().UTC().Format(time.RFC3339), Components: []ComponentStatus{}, Error: "controls_not_configured", Remote: legacyRemote("")}
	if h.control != nil {
		result.Error = "supervisor_unavailable"
		request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "http://supervisor/status", nil)
		response, err := h.control.Do(request)
		if err == nil {
			defer response.Body.Close()
			var state SystemStatus
			if response.StatusCode == 200 && json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&state) == nil && (state.Version == 1 || state.Version == 2) && state.Managed && len(state.Components) <= 6 {
				if state.Version == 1 {
					state.Remote = legacyRemote(state.CodespaceState)
				}
				state.CodespaceState = ""
				if validRemote(state.Remote) {
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
	}
	// The supervisor validates the fixed action/settings schema; it never accepts
	// commands or paths from this endpoint. No incoming headers or queries follow.
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
