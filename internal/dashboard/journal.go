package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Journal records are generated/redacted by the supervisor. This endpoint is a
// bounded cursor API, never a file reader, shell, or arbitrary supervisor proxy.
type journalEntry struct {
	Sequence  int64  `json:"seq"`
	Time      string `json:"time"`
	Component string `json:"component"`
	Trigger   string `json:"trigger"`
	Operation string `json:"operation"`
	Execution string `json:"execution"`
	Stream    string `json:"stream"`
	Text      string `json:"text"`
}

type journalPage struct {
	Version      int            `json:"version"`
	Entries      []journalEntry `json:"entries"`
	Oldest       int64          `json:"oldest"`
	Newest       int64          `json:"newest"`
	Reset        bool           `json:"reset"`
	StorageError bool           `json:"storage_error"`
}

var journalID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var operationID = regexp.MustCompile(`^(?:[a-f0-9]{16})?$`)
var executionID = regexp.MustCompile(`^(?:[a-f0-9]{8})?$`)

func journalQuery(raw string) (string, bool) {
	if len(raw) > 128 {
		return "", false
	}
	query, err := url.ParseQuery(raw)
	if err != nil || query.Has("after") && query.Has("before") {
		return "", false
	}
	for key, values := range query {
		if key != "after" && key != "before" && key != "limit" || len(values) != 1 || values[0] == "" {
			return "", false
		}
		for _, c := range values[0] {
			if c < '0' || c > '9' {
				return "", false
			}
		}
		value, err := strconv.ParseInt(values[0], 10, 64)
		if err != nil || value > 9007199254740991 || key == "limit" && (value < 1 || value > 100) {
			return "", false
		}
		query.Set(key, strconv.FormatInt(value, 10))
	}
	return query.Encode(), true
}

func validJournal(page journalPage) bool {
	if page.Version != 1 || page.Entries == nil || len(page.Entries) > 100 || page.Oldest < 0 || page.Newest < page.Oldest || page.Newest > 9007199254740991 {
		return false
	}
	var previous int64
	for _, entry := range page.Entries {
		if entry.Sequence <= previous || entry.Sequence < page.Oldest || entry.Sequence > page.Newest || !journalID.MatchString(entry.Component) || !operationID.MatchString(entry.Operation) || !executionID.MatchString(entry.Execution) || len([]rune(entry.Text)) > 4096 {
			return false
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.Time); err != nil {
			return false
		}
		switch entry.Trigger {
		case "startup", "manual", "monitor", "automatic", "service":
		default:
			return false
		}
		switch entry.Stream {
		case "event", "command", "stdout", "stderr", "output", "exit", "error":
		default:
			return false
		}
		previous = entry.Sequence
	}
	return true
}

func (h *Handler) journal(w http.ResponseWriter, r *http.Request) {
	query, ok := journalQuery(r.URL.RawQuery)
	if !ok {
		writeUnavailable(w, 400, "invalid_request")
		return
	}
	if h.control == nil {
		writeUnavailable(w, 503, "controls_not_configured")
		return
	}
	endpoint := "http://supervisor/journal"
	if query != "" {
		endpoint += "?" + query
	}
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, endpoint, nil)
	response, err := h.control.Do(request)
	if err != nil {
		writeUnavailable(w, 503, "supervisor_unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		writeUnavailable(w, 503, "supervisor_upgrade_required")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
	var page journalPage
	if response.StatusCode != 200 || err != nil || len(data) > 8<<20 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") || json.Unmarshal(data, &page) != nil || !validJournal(page) {
		writeUnavailable(w, 502, "invalid_supervisor_response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(page)
	}
}
