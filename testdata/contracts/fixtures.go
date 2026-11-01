// Package contracts loads the shared, sanitized test corpus. It is imported only
// by tests; no runtime schema library or generated production code is involved.
package contracts

import (
	"embed"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Embed only in test binaries, so loading is independent of cwd and -trimpath.
//
//go:embed *.json
var fixtures embed.FS

type Case struct {
	Name              string   `json:"name"`
	Fixture           string   `json:"fixture"`
	SupervisorFixture string   `json:"supervisor_fixture"`
	Boundary          string   `json:"boundary"`
	Valid             bool     `json:"valid"`
	Changes           []Change `json:"changes"`
}

type Change struct {
	Path   string `json:"path"`
	Value  any    `json:"value"`
	Remove bool   `json:"remove"`
	Copies int    `json:"copies"`
}

func Read(t testing.TB, name string) []byte {
	t.Helper()
	data, err := fixtures.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func Cases(t testing.TB, name string) []Case {
	t.Helper()
	var cases []Case
	if err := json.Unmarshal(Read(t, name), &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func (c Case) Payload(t testing.TB, fallback string) []byte {
	t.Helper()
	name := c.Fixture
	if name == "" {
		name = fallback
	}
	var value any
	if err := json.Unmarshal(Read(t, name), &value); err != nil {
		t.Fatal(err)
	}
	for _, change := range c.Changes {
		parts := strings.Split(change.Path, ".")
		parent := value
		for _, part := range parts[:len(parts)-1] {
			switch node := parent.(type) {
			case map[string]any:
				parent = node[part]
			case []any:
				index, err := strconv.Atoi(part)
				if err != nil || index < 0 || index >= len(node) {
					t.Fatalf("invalid fixture path %s", change.Path)
				}
				parent = node[index]
			default:
				t.Fatalf("invalid fixture path %s", change.Path)
			}
		}
		node, ok := parent.(map[string]any)
		if !ok {
			t.Fatalf("fixture change must target an object field: %s", change.Path)
		}
		key := parts[len(parts)-1]
		switch {
		case change.Remove:
			delete(node, key)
		case change.Copies > 0:
			original, ok := node[key].([]any)
			if !ok || len(original) == 0 {
				t.Fatalf("fixture copies require a nonempty array: %s", change.Path)
			}
			copies := make([]any, change.Copies)
			for i := range copies {
				encoded, err := json.Marshal(original[0])
				if err != nil || json.Unmarshal(encoded, &copies[i]) != nil {
					t.Fatalf("cannot copy fixture value: %s", change.Path)
				}
			}
			node[key] = copies
		default:
			node[key] = change.Value
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// EqualJSON ignores object key order, but not missing/extra fields, nulls, array
// order or values. This checks Go tags and omitempty behavior.
func EqualJSON(t testing.TB, got, want []byte) {
	t.Helper()
	var a, b any
	if err := json.Unmarshal(got, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &b); err != nil {
		t.Fatal(err)
	}
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	if string(left) != string(right) {
		t.Fatalf("contract changed\ngot:  %s\nwant: %s", left, right)
	}
}
