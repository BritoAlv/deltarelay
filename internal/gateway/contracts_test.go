package gateway_test

import (
	"encoding/json"
	"testing"

	"deltarelay/internal/gateway"
	"deltarelay/testdata/contracts"
)

func TestDashboardSerializationMatchesSharedContracts(t *testing.T) {
	for _, c := range contracts.Cases(t, "dashboard-cases.json") {
		if !c.Valid {
			continue // Malformed diagnostics are checked by the browser consumer.
		}
		t.Run(c.Name, func(t *testing.T) {
			data := c.Payload(t, "dashboard-v1.json")
			var snapshot gateway.DashboardSnapshot
			if err := json.Unmarshal(data, &snapshot); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			contracts.EqualJSON(t, encoded, data)
		})
	}
}
