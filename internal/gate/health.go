package gate

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Status struct {
	Ready   bool          `json:"ready"`
	Gateway GatewayStatus `json:"gateway"`
	Service ServiceStatus `json:"service"`
	Plugin  *PluginStatus `json:"plugin,omitempty"`
	Error   string        `json:"error,omitempty"`
	Message string        `json:"message,omitempty"`
	Reason  string        `json:"reason,omitempty"`
}

type GatewayStatus struct {
	Ready      bool `json:"ready"`
	Forwarding bool `json:"forwarding"`
}

type ServiceStatus struct {
	Ready   bool   `json:"ready"`
	Version string `json:"version,omitempty"`
}

type PluginStatus struct {
	Ready bool   `json:"ready"`
	ID    string `json:"id"`
}

func (s *Status) fail(reason string) {
	s.Ready = false
	s.Error, s.Message, s.Reason = "backend_unavailable", unavailableMessage, reason
}

type healthFlight struct {
	input    registration
	done     chan struct{}
	status   Status
	identity registration
}

func (g *Gate) health(ctx context.Context) (Status, registration) {
	// Validate on every request, including cached health: invalid/deleted
	// registrations and credential rotation must not be hidden by the cache.
	identity, err := g.readRegistration()
	var status Status
	if err != nil {
		status.fail("registration_invalid")
		return status, registration{}
	}
	g.mu.Lock()
	if identity == g.identity && !g.checked.IsZero() && time.Since(g.checked) < g.config.HealthCache {
		status = g.cached
		g.mu.Unlock()
		return status, identity
	}
	// Coalesce concurrent probes, even when completed-result caching is off.
	// Never hold the state lock during network I/O: editor startup fans out
	// many requests and serializing their relay round trips causes timeouts.
	if flight := g.flight; flight != nil && flight.input == identity {
		g.mu.Unlock()
		select {
		case <-flight.done:
			return flight.status, flight.identity
		case <-ctx.Done():
			status.fail("gateway_down")
			return status, identity
		}
	}
	flight := &healthFlight{input: identity, done: make(chan struct{})}
	g.flight = flight
	g.mu.Unlock()
	status, identity = g.checkHealth(ctx, identity)
	g.mu.Lock()
	flight.status, flight.identity = status, identity
	if g.flight == flight {
		g.flight = nil
		if status.Ready {
			g.cached, g.identity, g.checked = status, identity, time.Now()
		} else {
			g.checked = time.Time{}
		}
	}
	close(flight.done)
	g.mu.Unlock()
	return status, identity
}

func (g *Gate) checkHealth(ctx context.Context, identity registration) (Status, registration) {
	var status Status
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(g.config.Gateway, "/")+"/healthz", nil)
	request.Header.Set("X-DeltaRelay-Local-Token", g.config.LocalToken)
	response, err := g.client.Do(request)
	var gateway struct {
		Ready bool `json:"ready"`
		VPS   struct {
			Forwarding bool `json:"forwarding"`
		} `json:"vps"`
	}
	if err == nil {
		err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&gateway)
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			gateway.Ready = false
		}
	}
	status.Gateway = GatewayStatus{Ready: err == nil && gateway.Ready, Forwarding: gateway.VPS.Forwarding}
	if !status.Gateway.Ready || !status.Gateway.Forwarding {
		status.fail("gateway_down")
		return status, identity
	}
	var info struct {
		Version string `json:"version"`
	}
	var invalid bool
	identity, invalid, err = g.serviceJSON(ctx, identity, "/api/info", &info)
	if invalid {
		status.fail("registration_invalid")
		return status, identity
	}
	if err != nil || !strings.HasPrefix(info.Version, "2.") {
		status.fail("service_down")
		return status, identity
	}
	status.Service = ServiceStatus{Ready: true, Version: info.Version}
	if g.config.WorkspaceDirectory != "" {
		status.Plugin = &PluginStatus{ID: "deltarelay"}
		var plugins struct {
			Data []struct {
				ID    string `json:"id"`
				State struct {
					Status string `json:"status"`
				} `json:"state"`
			} `json:"data"`
		}
		query := url.Values{"location[directory]": {g.config.WorkspaceDirectory}}
		identity, invalid, err = g.serviceJSON(ctx, identity, "/api/plugin?"+query.Encode(), &plugins)
		if invalid {
			status.fail("registration_invalid")
			return status, identity
		}
		if err == nil {
			for _, plugin := range plugins.Data {
				if plugin.ID == "deltarelay" && plugin.State.Status == "active" {
					status.Plugin.Ready = true
				}
			}
		}
		if !status.Plugin.Ready {
			status.fail("plugin_unavailable")
			return status, identity
		}
	}
	status.Ready = true
	return status, identity
}
