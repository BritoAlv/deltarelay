"""Lifecycle adapters; none recursively recovers a peer component."""

from pathlib import Path

from remote_provider import ProviderError as ControlError, private_json

from .contracts import Observation
from .process import process


class LocalComponent:
    def __init__(self, supervisor, name):
        self.supervisor = supervisor
        self.name = name

    def observe(self):
        s, name = self.supervisor, self.name
        spec = s.config['components'].get(name, {})
        lifecycle = s.state.component_value(name)
        if 'command' in spec:
            # Read-only inspection: no PID adoption/reaping in the observer lane.
            info = s.processes.inspect(name)
            lifecycle = 'running' if info else 'stopped'
        elif name == 'opencode' and s.config.get('opencode_service_file'):
            try:
                registration = private_json(Path(s.config['opencode_service_file']))
                lifecycle = 'running' if process(registration.get('pid', 0)) else 'stopped'
            except (OSError, ValueError, ControlError):
                lifecycle = 'unknown'
        readiness = 'not_ready' if lifecycle == 'stopped' else 'unknown'
        detail = 'Verified process only; application readiness is not confirmed.'
        if name == 'gateway':
            readiness = s.probes.gateway()
            detail = 'Local authenticated readiness; independent of the VPS.'
        elif name == 'opencode':
            readiness = s.probes.opencode()
            detail = 'Read-only API check against the configured private service registration.'
        elif name == 'desktop':
            detail = 'Verified Desktop process; attachment to the OpenCode server is not independently observable.'
        elif name == 'tunnel':
            readiness = 'ready' if s.state.relay_value() == 'connected' else readiness
            detail = 'Process and authenticated end-to-end connectivity are checked separately.'
        result = Observation(lifecycle, readiness, detail)
        s.state.observe(name, result)
        if name in s.config['components']:
            s.state.set_component(name, lifecycle)
        return result

    def start(self):
        self.supervisor.start_component(self.name)

    def recover(self):
        # Do not restart a healthy process merely because its upstream is down.
        s = self.supervisor
        if self.name == 'tunnel':
            s.restart_component(self.name)
        elif s.state.component_value(self.name) not in ('running', 'starting', 'started'):
            self.start()
        elif self.name in ('gateway', 'opencode'):
            observation = self.observe()
            if observation.readiness == 'not_ready':
                # An independently failed local API, not a failed upstream.
                s.restart_component(self.name)

    def restart(self):
        self.supervisor.restart_component(self.name)

    def stop(self):
        self.supervisor.stop_component(self.name)

    def verify(self):
        return self.observe()


class RemoteHost:
    def __init__(self, supervisor):
        self.supervisor = supervisor

    def observe(self):
        s = self.supervisor
        host = s.provider_call('status')['host_state']
        s.state.set_host_state(host)
        s.state.observe('remote', Observation(host, 'ready' if host == 'running' else 'unknown',
                                            'Provider power observation; not connection readiness.'))
        return host

    def start(self):
        s = self.supervisor
        s.expected_identity()
        s.state.update_recovery(phase='waking_remote_host')
        s.wait_for_host('running', s.provider_call('host.wake'))

    def recover(self):
        # Wake policy is enforced by the coordinator, never inferred here.
        return self.verify()

    def verify(self):
        s = self.supervisor
        s.state.update_recovery(phase='waiting_for_remote_host')
        s.wait_for_host('running', {'host_state': s.state.host_value()})

    def stop(self):
        # Tunnel shutdown is a separate coordinator step, not a hidden peer
        # mutation inside this host adapter.
        self.supervisor.stop_host(stop_tunnel=False)


class RemoteRelay:
    def __init__(self, supervisor):
        self.supervisor = supervisor

    def observe(self):
        return self.supervisor.observe_relay()

    def start(self):
        return self.recover()

    def recover(self):
        self.supervisor.remote(wake=False)

    def restart(self):
        self.supervisor.remote(wake=False, restart=True)

    def verify(self):
        self.supervisor.state.update_recovery(phase='verifying_connection')
        return self.supervisor.wait_for_relay()


class RemoteProvider:
    def __init__(self, supervisor):
        self.supervisor = supervisor

    def observe(self):
        self.supervisor.prepare_provider()


def registry(supervisor):
    return {**{name: LocalComponent(supervisor, name)
               for name in ('dashboard', 'gateway', 'opencode', 'desktop', 'tunnel')},
            'remote': RemoteHost(supervisor), 'relay': RemoteRelay(supervisor),
            'remote_provider': RemoteProvider(supervisor)}
