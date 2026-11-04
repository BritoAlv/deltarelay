package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"deltarelay/internal/inspection"
)

var forwardedCaptureErrors = map[string]bool{
	"capture_disabled": true, "capture_not_retained": true, "attempt_not_captured": true,
	"artifact_not_captured": true, "inventory_not_captured": true,
	"artifact_unavailable_or_incomplete": true, "artifact_read_failed": true,
	"offset_out_of_range": true, "invalid_inspection_route": true,
}

func (h *Handler) inspect(w http.ResponseWriter, r *http.Request) {
	suffix := strings.TrimPrefix(r.URL.Path, "/api/inspection/")
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || !inspection.ValidRoute(suffix, query) {
		writeUnavailable(w, http.StatusBadRequest, "invalid_inspection_route")
		return
	}
	target := h.config.GatewayURL + "/v1/inspection/" + suffix
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		writeUnavailable(w, http.StatusInternalServerError, "invalid_gateway_configuration")
		return
	}
	// No browser headers, cookies or credentials are forwarded. Only validated
	// inspection parameters cross this narrowly scoped boundary.
	req.Header.Set("X-DeltaRelay-Local-Token", h.config.LocalToken)
	client := *h.client
	client.Timeout = time.Minute
	response, err := client.Do(req)
	if err != nil {
		writeUnavailable(w, http.StatusBadGateway, "capture_gateway_unreachable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		// Preserve only known capture semantics. Generic upstream details and
		// credentials never cross this boundary.
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		var detail struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &detail) == nil && forwardedCaptureErrors[detail.Error] {
			writeUnavailable(w, response.StatusCode, detail.Error)
		} else if response.StatusCode == http.StatusNotFound {
			writeUnavailable(w, http.StatusNotFound, "capture_not_retained")
		} else {
			writeUnavailable(w, http.StatusBadGateway, "capture_unavailable")
		}
		return
	}
	download := strings.HasSuffix(suffix, "/download")
	if download && response.Header.Get("Content-Type") == "application/octet-stream" {
		w.Header().Set("Content-Type", "application/octet-stream")
		// Construct an inert filename, rather than trusting upstream headers.
		w.Header().Set("Content-Disposition", `attachment; filename="deltarelay-capture.bin"`)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, io.LimitReader(response.Body, 1<<30))
		}
		return
	}
	if download || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		writeUnavailable(w, http.StatusBadGateway, "invalid_capture_response")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
	if err != nil || len(data) > 8<<20 {
		writeUnavailable(w, http.StatusBadGateway, "invalid_capture_response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
