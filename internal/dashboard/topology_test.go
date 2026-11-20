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
	var editor TopologyStatus
	_ = json.Unmarshal(raw, &editor)
	for i := range editor.Nodes {
		if editor.Nodes[i].ID == "vscode" {
			editor.Nodes[i].Actions = []string{"open"}
		}
	}
	if !validTopology(&editor, raw) {
		t.Fatal("one-shot editor open action rejected")
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

func TestTopologyMailboxIsOwnedFilesAndRemainsOptionalInV1(t *testing.T) {
	raw := contracts.Read(t, "topology-v1.json")
	var topology TopologyStatus
	if err := json.Unmarshal(raw, &topology); err != nil {
		t.Fatal(err)
	}
	found := false
	nodes := make([]TopologyNode, 0, len(topology.Nodes))
	for _, node := range topology.Nodes {
		if node.ID == "mailbox" {
			found = true
			if node.Kind != "storage" || node.Group != "remote" || node.Owner != "relay" || node.Managed || len(node.Actions) != 0 {
				t.Fatalf("mailbox is not relay-owned files: %+v", node)
			}
		} else {
			nodes = append(nodes, node)
		}
	}
	if !found {
		t.Fatal("response mailbox is missing from the shared topology")
	}
	edges := make([]TopologyEdge, 0, len(topology.Edges))
	for _, edge := range topology.Edges {
		if edge.Source != "mailbox" && edge.Target != "mailbox" {
			edges = append(edges, edge)
		}
	}
	topology.Nodes, topology.Edges = nodes, edges
	legacy, err := json.Marshal(topology)
	if err != nil || !validTopology(&topology, legacy) {
		t.Fatalf("older topology v1 without mailbox rejected: %v", err)
	}
}
