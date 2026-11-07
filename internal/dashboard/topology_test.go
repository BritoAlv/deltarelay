package dashboard

import (
	"encoding/json"
	"strings"
	"testing"

	"deltarelay/testdata/contracts"
)

func TestTopologyContractAndPrivateFieldFiltering(t *testing.T) {
	raw := contracts.Read(t, "topology-v1.json")
	var topology TopologyStatus
	if err := json.Unmarshal(raw, &topology); err != nil || !validTopology(&topology, raw) {
		t.Fatalf("shared topology rejected: %v", err)
	}
	for _, change := range []func(*TopologyStatus){
		func(v *TopologyStatus) { v.Version = 99 },
		func(v *TopologyStatus) { v.Nodes = append(v.Nodes, v.Nodes[0]) },
		func(v *TopologyStatus) { v.Nodes[0].Actions = []string{"shell"} },
		func(v *TopologyStatus) { v.Edges[0].Target = "arbitrary-process" },
		func(v *TopologyStatus) { v.Network.Generation = -1 },
	} {
		var candidate TopologyStatus
		_ = json.Unmarshal(raw, &candidate)
		change(&candidate)
		data, _ := json.Marshal(candidate)
		if validTopology(&candidate, data) {
			t.Fatal("invalid topology accepted")
		}
	}
	var base map[string]any
	_ = json.Unmarshal(contracts.Read(t, "supervisor-v2.json"), &base)
	var graph map[string]any
	_ = json.Unmarshal(raw, &graph)
	graph["private_command"] = "must-not-leak"
	graph["nodes"].([]any)[0].(map[string]any)["password"] = "must-not-leak"
	base["topology"] = graph
	data, _ := json.Marshal(base)
	state, ok := decodeSupervisorStatus(data)
	if !ok || state.Topology == nil {
		t.Fatal("topology envelope rejected")
	}
	public, _ := json.Marshal(state)
	if strings.Contains(string(public), "must-not-leak") {
		t.Fatal("private adapter fields reached browser")
	}
}
