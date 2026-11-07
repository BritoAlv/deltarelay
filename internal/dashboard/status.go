package dashboard

import (
	"bytes"
	"encoding/json"
	"regexp"
	"time"
)

// Decode the supervisor boundary before adding browser-only authorization/auth
// fields. A typed unmarshal alone silently turns missing/null fields into zeroes.
// Unknown fields are still stripped, not forwarded to the browser.
func decodeSupervisorStatus(data []byte) (SystemStatus, bool) {
	var state SystemStatus
	if json.Unmarshal(data, &state) != nil || state.Version != 2 || !state.Managed || !statusTimestamp(state.CollectedAt) || state.Recovery.Attempts < 0 || len(state.Components) > 6 {
		return SystemStatus{}, false
	}
	root := statusFields(data, "version", "managed", "collected_at", "settings", "recovery", "relay_state", "components")
	if root == nil || bytes.Equal(root["error"], []byte("null")) || bytes.Equal(root["internet_state"], []byte("null")) {
		return SystemStatus{}, false
	}
	if root["internet_state"] == nil {
		return SystemStatus{}, false
	}
	if root["internet_checked_at"] == nil {
		return SystemStatus{}, false
	}
	if raw := root["topology"]; raw != nil && !validTopology(state.Topology, raw) {
		return SystemStatus{}, false
	}
	if statusFields(root["settings"], "auto_reconnect", "auto_wake") == nil {
		return SystemStatus{}, false
	}
	recovery := statusFields(root["recovery"], "busy", "phase", "attempts", "last_error")
	if recovery == nil || recovery["last_connected_at"] == nil || recovery["next_retry_at"] == nil || !nullableStatusTimestamp(state.Recovery.LastConnectedAt) || !nullableStatusTimestamp(state.Recovery.NextRetryAt) || !nullableStatusTimestamp(state.InternetCheckedAt) {
		return SystemStatus{}, false
	}
	if statusFields(root["remote"], "id", "label", "host_state", "capabilities") == nil {
		return SystemStatus{}, false
	}
	if !validRemote(state.Remote) {
		return SystemStatus{}, false
	}
	var components []json.RawMessage
	if json.Unmarshal(root["components"], &components) != nil {
		return SystemStatus{}, false
	}
	for i, component := range state.Components {
		if statusFields(components[i], "id", "label", "state", "can_start", "can_restart") == nil {
			return SystemStatus{}, false
		}
		switch component.ID {
		case "dashboard", "gateway", "tunnel", "relay", "opencode", "desktop":
		default:
			return SystemStatus{}, false
		}
	}
	return state, true
}

func statusFields(data []byte, required ...string) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return nil
	}
	for _, name := range required {
		if fields[name] == nil || bytes.Equal(fields[name], []byte("null")) {
			return nil
		}
	}
	return fields
}

var statusTime = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

func statusTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && statusTime.MatchString(value)
}

func nullableStatusTimestamp(value *string) bool {
	return value == nil || statusTimestamp(*value)
}
