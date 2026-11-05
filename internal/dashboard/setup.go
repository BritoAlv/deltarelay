package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

type SetupTarget struct {
	Provider        string `json:"provider"`
	Target          string `json:"target"`
	RemoteDirectory string `json:"remote_directory"`
	SSHPort         int    `json:"ssh_port"`
	RemotePort      int    `json:"remote_port"`
}

type SetupStatus struct {
	Version   int          `json:"version"`
	Available bool         `json:"available"`
	Required  bool         `json:"required"`
	Busy      bool         `json:"busy"`
	LastError string       `json:"last_error"`
	Target    *SetupTarget `json:"target"`
}

var setupCode = regexp.MustCompile(`^[a-z_]{0,80}$`)

func (h *Handler) setupStatus(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeUnavailable(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if h.control == nil {
		writeUnavailable(w, http.StatusServiceUnavailable, "controls_not_configured")
		return
	}
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "http://supervisor/setup", nil)
	response, err := h.control.Do(request)
	if err != nil {
		writeUnavailable(w, http.StatusServiceUnavailable, "supervisor_unavailable")
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	var status SetupStatus
	fields := statusFields(data, "version", "available", "required", "busy", "last_error")
	if err != nil || response.StatusCode != http.StatusOK || len(data) > 4096 || fields == nil || fields["target"] == nil || json.Unmarshal(data, &status) != nil || status.Version != 1 || !setupCode.MatchString(status.LastError) || status.Available && !status.Required {
		writeUnavailable(w, http.StatusBadGateway, "invalid_supervisor_response")
		return
	}
	if target := status.Target; target != nil {
		if statusFields(fields["target"], "provider", "target", "remote_directory", "ssh_port", "remote_port") == nil || target.Provider != "ssh" && target.Provider != "codespaces" || len(target.Target) == 0 || len(target.Target) > 255 || len(target.RemoteDirectory) > 512 || !strings.HasPrefix(target.RemoteDirectory, "/") && !strings.HasPrefix(target.RemoteDirectory, "~/") || target.SSHPort < 1 || target.SSHPort > 65535 || target.RemotePort < 1024 || target.RemotePort > 65535 {
			writeUnavailable(w, http.StatusBadGateway, "invalid_supervisor_response")
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(status)
	}
}
