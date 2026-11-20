"""Single owner of the supervisor's observable state.

All fields in :class:`SupervisorState` are guarded by one re-entrant lock.
Slow network and process work must happen outside that lock; callers apply the
result with one short update. ``snapshot`` returns copies so callers cannot
mutate live state by retaining a response.
"""

import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from remote_provider import private_json

from .config import COMPONENTS, FRONTENDS, LABELS


INITIAL_RECOVERY = {
    'busy': False,
    'phase': 'starting',
    'attempts': 0,
    'last_error': '',
    'last_connected_at': None,
    'next_retry_at': None,
}


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def save_json(path, value):
    if path.exists() or path.is_symlink():
        private_json(path)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)


class SupervisorState:
    def __init__(self, config, settings, metadata, journal=None, on_change=None):
        self.journal = journal
        self.on_change = on_change
        self.lock = threading.RLock()
        self.settings_lock = threading.Lock()
        self.settings = dict(settings)
        self.metadata = dict(metadata)
        self.opencode_directory = bool(config.get('opencode_directory'))
        self.editor_open = bool(config.get('vscode', {}).get('open_command'))
        self.configured_components = set(config['components'])
        self.states = {name: 'unknown' if name in config['components'] else 'unmanaged' for name in COMPONENTS}
        self.recovery = dict(INITIAL_RECOVERY)
        self.relay_state = 'unknown'
        self.host_state = 'unknown'
        self.internet_state = 'unknown'
        self.internet_checked_at = None
        self.internet_next = 0.0
        self.dashboard_enabled = True
        self.intent = {'system': 'running', 'remote': 'running', 'components': {}}
        self.observations = {}
        self.network = {'generation': 0, 'changed_at': None}
        self.run = None
        self._managed = {}
        self._can_start = {}
        self._can_restart = {}
        self._specs = {}
        capabilities = self.metadata.get('capabilities', ())
        for name in COMPONENTS:
            self.register_component(name, config['components'].get(name, {}), capabilities=capabilities,
                                    managed=name in config['components'])
            self.states[name] = 'unknown' if self._managed[name] else 'unmanaged'
        if 'relay.ensure' in capabilities:
            self.states['relay'] = 'unknown'

    def register_component(self, name, spec, capabilities=None, managed=None):
        """Register runtime tunnel metadata without exposing the config object."""
        spec = spec or {}
        capabilities = self.metadata.get('capabilities', ()) if capabilities is None else capabilities
        with self.lock:
            previous = self.states.get(name)
            self._managed[name] = bool(spec) if managed is None else managed
            if self._managed[name]:
                self.configured_components.add(name)
            else:
                self.configured_components.discard(name)
            self._specs[name] = dict(spec)
            self._can_start[name] = bool(spec.get('command') or spec.get('start_command') or
                                           name == 'relay' and 'relay.ensure' in capabilities)
            self._can_restart[name] = bool(spec.get('command') or spec.get('restart_command') or
                                           name == 'relay' and 'relay.restart' in capabilities)
            if previous is None or not self._managed[name]:
                self.states[name] = 'unmanaged'
            elif previous == 'unmanaged':
                self.states[name] = 'unknown'

    def set_metadata(self, metadata):
        """Apply provider discovery metadata and recompute capability flags."""
        with self.lock:
            previous = dict(self.metadata)
            self.metadata = dict(metadata)
            capabilities = self.metadata.get('capabilities', ())
            for name, spec in self._specs.items():
                self._can_start[name] = bool(spec.get('command') or spec.get('start_command') or
                                               name == 'relay' and 'relay.ensure' in capabilities)
                self._can_restart[name] = bool(spec.get('command') or spec.get('restart_command') or
                                                name == 'relay' and 'relay.restart' in capabilities)
        self._changed('Provider metadata', previous, self.metadata, 'provider')

    def _changed(self, name, previous, value, component=None):
        if previous == value:
            return
        if self.journal:
            self.journal.write('event', f'{name}: {previous} -> {value}', component=component)
        if self.on_change:
            try:
                self.on_change()
            except Exception as error:
                if self.journal:
                    self.journal.write('error', f'State history update failed: {type(error).__name__}', component='state')

    def snapshot(self):
        with self.lock:
            components = []
            for name in COMPONENTS:
                components.append({'id': name, 'label': LABELS[name], 'state': self.states[name],
                                   'can_start': self._can_start[name], 'can_restart': self._can_restart[name]})
            return {
                'version': 2,
                'managed': True,
                'collected_at': stamp(),
                'settings': dict(self.settings),
                'recovery': dict(self.recovery),
                'relay_state': self.relay_state,
                'internet_state': self.internet_state,
                'internet_checked_at': self.internet_checked_at,
                'remote': {**self.metadata, 'host_state': self.host_state},
                'components': components,
                'topology': self.topology_snapshot(),
            }

    def topology_snapshot(self):
        # Called with the re-entrant state lock; no probes or I/O under it.
        from .topology import snapshot
        return snapshot(self)

    def observe(self, name, observation):
        with self.lock:
            self.observations[name] = {'lifecycle': observation.lifecycle,
                                       'readiness': observation.readiness,
                                       'detail': observation.detail, 'checked_at': stamp()}

    def intent_copy(self):
        with self.lock:
            return copy.deepcopy(self.intent)

    def set_intent(self, value):
        with self.lock:
            previous = self.intent
            self.intent = copy.deepcopy(value)
        self._changed('System intent', previous, self.intent)

    def history_observation(self):
        """Copy only the facts that classify one system-state interval."""
        with self.lock:
            return {
                'intent': self.intent['system'],
                'busy': self.recovery['busy'],
                'relay_state': self.relay_state,
                'host_state': self.host_state,
                'internet_state': self.internet_state,
            }

    def wanted(self, name):
        with self.lock:
            if name in ('dashboard', 'supervisor'):
                return True
            # Frontends never auto-start; an explicit component Start records
            # their desired state but normal startup and Start system skip them.
            default = name not in FRONTENDS
            return self.intent['system'] == 'running' and self.intent['components'].get(name, default)

    def network_changed(self):
        with self.lock:
            self.network = {'generation': self.network['generation'] + 1, 'changed_at': stamp()}
            self.internet_next = 0.0

    def set_run(self, run):
        with self.lock:
            self.run = copy.deepcopy(run)

    def run_copy(self):
        with self.lock:
            return copy.deepcopy(self.run)

    def settings_copy(self):
        with self.lock:
            return dict(self.settings)

    def recovery_copy(self):
        with self.lock:
            return dict(self.recovery)

    def states_copy(self):
        with self.lock:
            return dict(self.states)

    def apply_settings(self, value, persist):
        # Settings writes are serialized separately so disk and published state
        # cannot diverge, while fsync still happens outside the snapshot lock.
        with self.settings_lock:
            persist(value)
            with self.lock:
                previous = self.settings
                self.settings = dict(value)
            self._changed('Recovery settings saved', previous, value, 'settings')

    def set_component(self, name, value):
        with self.lock:
            previous = self.states[name]
            self.states[name] = value
        self._changed('Service state', previous, value, name)

    def component_value(self, name):
        with self.lock:
            return self.states[name]

    def set_relay_state(self, value):
        with self.lock:
            previous = self.relay_state
            self.relay_state = value
        self._changed('Relay connectivity', previous, value, 'relay')

    def relay_value(self):
        with self.lock:
            return self.relay_state

    def set_host_state(self, value):
        with self.lock:
            previous = self.host_state
            self.host_state = value
            self.observations['remote'] = {
                'lifecycle': value, 'readiness': 'ready' if value == 'running' else 'unknown',
                'detail': 'Power state reported by the hosting provider; not connection readiness.',
                'checked_at': stamp(),
            }
            if value == 'stopped' and self.relay_state == 'connected':
                # Power-off invalidates an earlier authenticated probe, even
                # when monitoring is intentionally paused.
                self.relay_state = 'unknown'
                self.states['relay'] = 'stopped'
        self._changed('Host state', previous, value, 'provider')

    def host_value(self):
        with self.lock:
            return self.host_state

    def set_internet(self, state, checked_at, next_at):
        with self.lock:
            previous = self.internet_state
            self.internet_state = state
            self.internet_checked_at = checked_at
            self.internet_next = next_at
        self._changed('Internet connectivity', previous, state, 'network')

    def update_recovery(self, **changes):
        with self.lock:
            previous = dict(self.recovery)
            self.recovery.update(changes)
        for name, value in changes.items():
            self._changed(f'Recovery {name}', previous.get(name), value)

    def recovery_value(self, key):
        with self.lock:
            return self.recovery[key]

    def begin_operation(self, phase):
        self.update_recovery(busy=True, phase=phase, last_error='', next_retry_at=None)

    def begin_attempt(self, phase):
        with self.lock:
            attempts = self.recovery['attempts'] + 1
        self.update_recovery(busy=True, phase=phase, attempts=attempts, next_retry_at=None)

    def finish_operation(self):
        intent = self.intent_copy()
        phase = ('system_stopped' if intent['system'] == 'stopped' else
                 'remote_stopped' if intent['remote'] == 'stopped' else 'monitoring')
        self.update_recovery(busy=False, phase=phase,
                             **({'next_retry_at': None} if phase != 'monitoring' else {}))

    def record_relay(self, relay_state):
        """Apply one completed relay probe atomically."""
        with self.lock:
            previous = self.relay_state
            self.relay_state = relay_state
            stopped = relay_state == 'unreachable' and self.host_state == 'stopped'
            self.states['relay'] = ('running' if relay_state == 'connected'
                                    else 'stopped' if stopped else 'unknown')
            if relay_state == 'connected':
                self.recovery.update(last_connected_at=stamp(), last_error='', next_retry_at=None)
        self._changed('Relay connectivity', previous, relay_state, 'relay')

    def set_dashboard_enabled(self, value):
        with self.lock:
            self.dashboard_enabled = bool(value)

    def dashboard_is_enabled(self):
        with self.lock:
            return self.dashboard_enabled
