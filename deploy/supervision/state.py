"""Single owner of the supervisor's observable state.

All fields in :class:`SupervisorState` are guarded by one re-entrant lock.
Slow network and process work must happen outside that lock; callers apply the
result with one short update. ``snapshot`` returns copies so callers cannot
mutate live state by retaining a response.
"""

import json
import os
from pathlib import Path
import tempfile
import threading
import time

from remote_provider import private_json

from .config import COMPONENTS, LABELS


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
        finally:
            temporary.unlink(missing_ok=True)


class SupervisorState:
    def __init__(self, config, settings, metadata):
        self.lock = threading.RLock()
        self.settings_lock = threading.Lock()
        self.settings = dict(settings)
        self.metadata = dict(metadata)
        self.states = {name: 'unknown' if name in config['components'] else 'unmanaged' for name in COMPONENTS}
        self.recovery = dict(INITIAL_RECOVERY)
        self.relay_state = 'unknown'
        self.host_state = 'unknown'
        self.internet_state = 'unknown'
        self.internet_checked_at = None
        self.internet_next = 0.0
        self.dashboard_enabled = True
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
            self.metadata = dict(metadata)
            capabilities = self.metadata.get('capabilities', ())
            for name, spec in self._specs.items():
                self._can_start[name] = bool(spec.get('command') or spec.get('start_command') or
                                               name == 'relay' and 'relay.ensure' in capabilities)
                self._can_restart[name] = bool(spec.get('command') or spec.get('restart_command') or
                                               name == 'relay' and 'relay.restart' in capabilities)


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
            }

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
                self.settings = dict(value)

    def set_component(self, name, value):
        with self.lock:
            self.states[name] = value

    def component_value(self, name):
        with self.lock:
            return self.states[name]

    def set_relay_state(self, value):
        with self.lock:
            self.relay_state = value

    def relay_value(self):
        with self.lock:
            return self.relay_state

    def set_host_state(self, value):
        with self.lock:
            self.host_state = value

    def host_value(self):
        with self.lock:
            return self.host_state

    def set_internet(self, state, checked_at, next_at):
        with self.lock:
            self.internet_state = state
            self.internet_checked_at = checked_at
            self.internet_next = next_at

    def update_recovery(self, **changes):
        with self.lock:
            self.recovery.update(changes)

    def recovery_value(self, key):
        with self.lock:
            return self.recovery[key]

    def begin_operation(self, phase):
        with self.lock:
            self.recovery.update(busy=True, phase=phase, last_error='', next_retry_at=None)

    def begin_attempt(self, phase):
        with self.lock:
            self.recovery.update(busy=True, phase=phase, attempts=self.recovery['attempts'] + 1,
                                 next_retry_at=None)

    def finish_operation(self):
        with self.lock:
            self.recovery.update(busy=False, phase='monitoring')

    def record_relay(self, relay_state):
        """Apply one completed relay probe atomically."""
        with self.lock:
            self.relay_state = relay_state
            stopped = relay_state == 'unreachable' and self.host_state == 'stopped'
            self.states['relay'] = ('running' if relay_state == 'connected'
                                    else 'stopped' if stopped else 'unknown')
            if relay_state == 'connected':
                self.recovery.update(last_connected_at=stamp(), last_error='', next_retry_at=None)

    def set_dashboard_enabled(self, value):
        with self.lock:
            self.dashboard_enabled = bool(value)

    def dashboard_is_enabled(self):
        with self.lock:
            return self.dashboard_enabled
