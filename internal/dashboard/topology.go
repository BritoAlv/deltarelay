package dashboard

import (
	"encoding/json"
	"regexp"
	"unicode"
)

// Topology has its own version. Supervisor v2 remains compatible with existing
// read-only clients; unknown/private adapter fields never cross this bridge.
type TopologyStatus struct {
	Version          int             `json:"version"`
	Nodes            []TopologyNode  `json:"nodes"`
	Edges            []TopologyEdge  `json:"edges"`
	Intent           TopologyIntent  `json:"intent"`
	Network          TopologyNetwork `json:"network"`
	Run              *RecoveryRun    `json:"run"`
	ShutdownBlockers []string        `json:"shutdown_blockers"`
}

type TopologyIntent struct {
	System string `json:"system"`
	Remote string `json:"remote"`
}

type TopologyNetwork struct {
	Generation int64   `json:"generation"`
	ChangedAt  *string `json:"changed_at"`
}

type TopologyNode struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Kind      string   `json:"kind"`
	Group     string   `json:"group"`
	Owner     string   `json:"owner"`
	Managed   bool     `json:"managed"`
	Desired   string   `json:"desired"`
	Lifecycle string   `json:"lifecycle"`
	Readiness string   `json:"readiness"`
	Activity  string   `json:"activity"`
	CheckedAt *string  `json:"checked_at"`
	Detail    string   `json:"detail"`
	Actions   []string `json:"actions"`
}

type TopologyEdge struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	Relation string `json:"relation"`
	Protocol string `json:"protocol"`
	State    string `json:"state"`
}

type RecoveryRun struct {
	Version          int            `json:"version"`
	ID               string         `json:"id"`
	RequestID        string         `json:"request_id"`
	Target           string         `json:"target"`
	Action           string         `json:"action"`
	Trigger          string         `json:"trigger"`
	Status           string         `json:"status"`
	CurrentComponent string         `json:"current_component"`
	CurrentAction    string         `json:"current_action"`
	StartedAt        string         `json:"started_at"`
	FinishedAt       *string        `json:"finished_at"`
	Error            string         `json:"error"`
	Steps            []RecoveryStep `json:"steps"`
}

type RecoveryStep struct {
	Component  string  `json:"component"`
	Action     string  `json:"action"`
	Status     string  `json:"status"`
	StartedAt  string  `json:"started_at"`
	FinishedAt *string `json:"finished_at"`
	Error      string  `json:"error"`
}

var topologyIDs = map[string]bool{
	"desktop": true, "opencode": true, "plugin": true, "gateway": true,
	"tunnel": true, "network": true, "remote": true, "relay": true,
	"storage": true, "provider": true, "dashboard_ui": true, "dashboard": true,
	"supervisor": true, "remote_provider": true,
}
var recoveryOperationID = regexp.MustCompile(`^[a-f0-9]{16}$`)
var requestID = regexp.MustCompile(`^(?:[a-f0-9]{32})?$`)
var safeCode = regexp.MustCompile(`^[a-z_]{0,64}$`)

func oneOf(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}

func safeText(value string, maximum int) bool {
	if len([]rune(value)) > maximum {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func topologyAction(value string) bool {
	return oneOf(value, "start", "restart", "recover", "stop", "wake", "observe", "verify")
}

func topologyReadiness(value string) bool {
	return oneOf(value, "ready", "not_ready", "blocked", "unknown")
}

func validTopology(t *TopologyStatus, raw json.RawMessage) bool {
	if t == nil || t.Version != 1 || len(t.Nodes) == 0 || len(t.Nodes) > 32 || t.Edges == nil || len(t.Edges) > 64 || t.ShutdownBlockers == nil || len(t.ShutdownBlockers) > 6 {
		return false
	}
	root := statusFields(raw, "version", "nodes", "edges", "intent", "network", "shutdown_blockers")
	if root == nil || root["run"] == nil || statusFields(root["intent"], "system", "remote") == nil || statusFields(root["network"], "generation") == nil ||
		!oneOf(t.Intent.System, "running", "stopped") || !oneOf(t.Intent.Remote, "running", "stopped") ||
		t.Network.Generation < 0 || t.Network.Generation > 9007199254740991 || !nullableStatusTimestamp(t.Network.ChangedAt) {
		return false
	}
	var nodes []json.RawMessage
	if json.Unmarshal(root["nodes"], &nodes) != nil {
		return false
	}
	seen := map[string]bool{}
	for i, n := range t.Nodes {
		if !topologyIDs[n.ID] || seen[n.ID] || statusFields(nodes[i], "id", "label", "kind", "group", "owner", "managed", "desired", "lifecycle", "readiness", "activity", "detail", "actions") == nil ||
			n.Label == "" || !safeText(n.Label, 80) || !safeText(n.Detail, 400) || !safeCode.MatchString(n.Kind) ||
			!oneOf(n.Group, "local", "network", "remote", "external", "control") ||
			!(topologyIDs[n.Owner] || oneOf(n.Owner, "external", "user", "launcher")) ||
			!oneOf(n.Desired, "running", "stopped", "external", "unmanaged") ||
			!oneOf(n.Lifecycle, "running", "stopped", "starting", "stopping", "started", "unknown", "unmanaged") ||
			!topologyReadiness(n.Readiness) || !(n.Activity == "idle" || topologyAction(n.Activity)) ||
			!nullableStatusTimestamp(n.CheckedAt) || n.Actions == nil || len(n.Actions) > 5 {
			return false
		}
		seen[n.ID] = true
		actions := map[string]bool{}
		for _, action := range n.Actions {
			if !oneOf(action, "start", "restart", "recover", "stop", "wake") || actions[action] {
				return false
			}
			actions[action] = true
		}
	}
	edges := map[string]bool{}
	for _, e := range t.Edges {
		if !seen[e.Source] || !seen[e.Target] || e.ID != e.Source+"_"+e.Target || edges[e.ID] ||
			!oneOf(e.Relation, "traffic", "requires", "contains", "manages") || !safeText(e.Protocol, 80) || !topologyReadiness(e.State) {
			return false
		}
		edges[e.ID] = true
	}
	for _, name := range t.ShutdownBlockers {
		if !seen[name] {
			return false
		}
	}
	if r := t.Run; r != nil {
		if r.Version != 1 || !recoveryOperationID.MatchString(r.ID) || !requestID.MatchString(r.RequestID) ||
			!(topologyIDs[r.Target] || oneOf(r.Target, "all", "connection")) || !topologyAction(r.Action) ||
			!oneOf(r.Trigger, "manual", "automatic", "startup") || !oneOf(r.Status, "running", "completed", "failed", "interrupted") ||
			!(r.CurrentComponent == "" || topologyIDs[r.CurrentComponent]) || !(r.CurrentAction == "" || topologyAction(r.CurrentAction)) ||
			!statusTimestamp(r.StartedAt) || !nullableStatusTimestamp(r.FinishedAt) || !safeCode.MatchString(r.Error) || r.Steps == nil || len(r.Steps) > 64 {
			return false
		}
		for _, s := range r.Steps {
			if !topologyIDs[s.Component] || !topologyAction(s.Action) || !oneOf(s.Status, "running", "completed", "failed", "interrupted") ||
				!statusTimestamp(s.StartedAt) || !nullableStatusTimestamp(s.FinishedAt) || !safeCode.MatchString(s.Error) {
				return false
			}
		}
	}
	return true
}
