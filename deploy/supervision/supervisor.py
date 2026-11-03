"""Supervisor orchestration: recovery policy, controls, and collaboration.

This module coordinates configuration, observable state, process ownership,
probes, and scheduling. It deliberately leaves file formats, provider
protocols, and remote helpers in their existing modules.
"""

import copy
import os
from pathlib import Path
import stat
import sys
import threading
import time
import urllib.request

from recover_relay import NoRedirect
from remote_provider import (PERMANENT, ProviderError as ControlError, private_json,
                             run_command)
from providers.legacy import load_provider, normalize_component

from .config import COMPONENTS, INTERNET_CHECK_INTERVAL, validate
from .process import ProcessManager, process
from .probes import RelayProbe
from .recovery import RecoveryPolicy
from .state import SupervisorState, save_json, stamp



class Supervisor:
    def __init__(self, config, *, clock=None, probes=None, processes=None, policy=None,
                 command_runner=None):
        validate(config)
        self.config = copy.deepcopy(config)
        self.root = Path(config['profile'])
        self.directory = self.root / 'control'
        self.directory.mkdir(mode=0o700, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ControlError('unsafe_control_directory')
        settings = {'auto_reconnect': True, 'auto_wake': False}
        settings_file = self.directory / 'settings.json'
        if settings_file.exists() or settings_file.is_symlink():
            loaded = private_json(settings_file)
            if set(loaded) != set(settings) or any(type(v) is not bool for v in loaded.values()):
                raise ControlError('invalid_settings')
            settings = loaded
        self.operation = threading.Lock()
        self.stop = threading.Event()
        self.clock = clock or (lambda: time.monotonic())
        self.command_runner = command_runner
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.provider = load_provider(self.config, self._run, self.stop,
                                      self.start_component, self.restart_component)
        self.state = SupervisorState(self.config, settings, self.provider.metadata)
        self.processes = processes or ProcessManager(self.config, self.root, self.directory,
                                                     self.state, self.stop, clock=self.clock)
        self.probes = probes or RelayProbe(self.config, self.opener)
        self.policy = policy or RecoveryPolicy(clock=self.clock)

    # Compatibility/review accessors. Production code uses the collaborators
    # directly; these keep status inspectable without exposing mutable state.
    @property
    def settings(self):
        return self.state.settings_copy()

    @property
    def recovery(self):
        return self.state.recovery_copy()

    @property
    def states(self):
        return self.state.states_copy()

    @property
    def relay_state(self):
        return self.state.relay_value()

    @relay_state.setter
    def relay_state(self, value):
        self.state.set_relay_state(value)

    @property
    def host_state(self):
        return self.state.host_value()

    @host_state.setter
    def host_state(self, value):
        self.state.set_host_state(value)

    @property
    def internet_state(self):
        with self.state.lock:
            return self.state.internet_state

    @internet_state.setter
    def internet_state(self, value):
        with self.state.lock:
            self.state.internet_state = value

    @property
    def internet_checked_at(self):
        with self.state.lock:
            return self.state.internet_checked_at

    @property
    def internet_next(self):
        with self.state.lock:
            return self.state.internet_next

    @internet_next.setter
    def internet_next(self, value):
        with self.state.lock:
            self.state.internet_next = value

    @property
    def provider_blocked(self):
        return self.policy.provider_blocked_value()

    @provider_blocked.setter
    def provider_blocked(self, value):
        self.policy.set_provider_blocked(value)

    @property
    def next_attempt(self):
        return self.policy.next_attempt_value()

    @next_attempt.setter
    def next_attempt(self, value):
        self.policy.set_next_attempt(value)

    @property
    def children(self):
        return self.processes.children

    @property
    def identities(self):
        return self.processes.identities

    def _run(self, command, **kwargs):
        runner = self.command_runner or run_command
        return runner(command, cancel=self.stop, **kwargs)

    def snapshot(self):
        return self.state.snapshot()

    def supports(self, method):
        return method in self.provider.metadata['capabilities']

    def prepare_provider(self):
        connection = self.provider.prepare()
        self.state.set_metadata(self.provider.metadata)
        tunnel = connection.get('tunnel')
        if tunnel and 'tunnel' not in self.config['components']:
            env = dict(self.provider.spec.get('env', {}))
            env.update({key: os.environ[key] for key in self.provider.spec.get('pass_env', []) if key in os.environ})
            spec = {**tunnel, 'pid_file': str(self.directory / 'provider-tunnel.pid'), 'env': env}
            self.config['components']['tunnel'] = spec
            self.state.register_component('tunnel', spec)

    def expected_identity(self):
        return self.probes.expected_identity()

    def update_settings(self, value):
        if not isinstance(value, dict) or set(value) != set(self.settings) or any(type(v) is not bool for v in value.values()):
            raise ControlError('invalid_settings')
        if value['auto_wake'] and 'remote' in self.config and not self.supports('host.wake'):
            raise ControlError('unsupported_operation')
        self.state.apply_settings(value, lambda settings: save_json(self.directory / 'settings.json', settings))
        self.policy.reset_attempt()

    def _identity(self, name):
        return self.processes.identity(name)

    def start_component(self, name):
        if self.stop.is_set():
            raise ControlError('operation_cancelled')
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if name == 'tunnel' and self.supports('host.wake'):
            host_state = self.provider.call('status')['host_state']
            self.state.set_host_state(host_state)
            if host_state in ('stopped', 'stopping'):
                raise ControlError('host_stopped')
        if 'command' not in spec:
            command = spec.get('start_command')
            if not command:
                raise ControlError('component_unmanaged')
            self._run(command, env=spec.get('env'))
            self.state.set_component(name, 'started')
            return
        self.processes.start(name)

    def restart_component(self, name):
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if 'command' not in spec:
            if not spec.get('restart_command'):
                raise ControlError('component_unmanaged')
            self._run(spec['restart_command'], env=spec.get('env'))
            self.state.set_component(name, 'started')
            return
        self.processes.stop(name)
        self.start_component(name)

    def stop_component(self, name):
        spec = self.config['components'].get(name, {})
        if 'command' not in spec:
            raise ControlError('component_unmanaged')
        self.processes.stop(name)

    def probe(self):
        return self.probes.relay()

    def internet_probe(self):
        return self.probes.internet()

    def update_internet(self, relay_state):
        if relay_state == 'unreachable':
            now = self.clock()
            with self.state.lock:
                due = self.state.internet_state == 'unknown' or now >= self.state.internet_next
            if not due:
                return
            value = self.internet_probe()
            self.state.set_internet(value, stamp(), now + INTERNET_CHECK_INTERVAL)
            return
        if relay_state == 'configuration_error':
            return
        # Authentication, TLS, identity, protocol, forwarding, and connected
        # results all required a live network path to the relay.
        self.state.set_internet('connected', stamp(), 0.0)

    def wait_for_host(self, wanted, result):
        deadline = self.clock() + 120
        self.state.set_host_state(result['host_state'])
        while self.state.host_value() != wanted:
            if self.stop.wait(3):
                raise ControlError('operation_cancelled')
            if self.clock() >= deadline:
                raise ControlError('host_stop_timeout' if wanted == 'stopped' else 'host_unavailable')
            self.state.set_host_state(self.provider.call('status')['host_state'])

    def stop_host(self):
        # Persist suppression before any tunnel/provider operation, including a
        # failed shutdown. Neither a retry nor a supervisor restart may wake it.
        self.update_settings({'auto_reconnect': False, 'auto_wake': False})
        if 'command' in self.config['components'].get('tunnel', {}):
            self.stop_component('tunnel')
        self.wait_for_host('stopped', self.provider.call('host.stop'))
        self.state.set_relay_state('unreachable')
        self.state.set_component('relay', 'stopped')
        self.state.update_recovery(last_error='host_stopped')

    def remote(self, wake=False, restart=False):
        blocked = self.policy.provider_blocked_value()
        if blocked:
            raise ControlError(blocked)
        self.prepare_provider()
        state = self.probe()
        if state not in ('connected', 'unreachable'):
            raise ControlError(state)
        expected = self.expected_identity()
        if wake and self.supports('host.wake'):
            self.state.update_recovery(phase='waking_remote_host')
            self.wait_for_host('running', self.provider.call('host.wake'))
        method = 'relay.restart' if restart else 'relay.ensure'
        if self.supports(method):
            self.state.update_recovery(phase='recovering_remote_relay')
            try:
                result = self.provider.call(method, {'expected_state_id': expected})
            except ControlError as error:
                if str(error) == 'host_stopped':
                    self.state.set_host_state('stopped')
                raise
            if result['state_id'] != expected:
                raise ControlError('identity_mismatch')
            self.state.set_component('relay', 'starting')
        else:
            host_state = self.provider.call('status')['host_state']
            self.state.set_host_state(host_state)
            if host_state == 'stopped':
                raise ControlError('host_stopped')

    def observe_relay(self):
        state = self.probe()
        self.update_internet(state)
        self.state.record_relay(state)
        if state in PERMANENT:
            self.policy.set_provider_blocked(state)
        if state == 'connected':
            self.policy.record_connected()
        return state

    def wait_for_relay(self):
        # Port-forward setup can take longer than one probe. Keep the wait
        # bounded, and never treat a permanent failure as permission to repair.
        for attempt in range(5):
            if self.stop.wait(1 if attempt else 0):
                raise ControlError('operation_cancelled')
            state = self.observe_relay()
            if state == 'connected':
                return True
            if state != 'unreachable':
                raise ControlError(state)
        return False

    def recover(self, wake=False):
        blocked = self.policy.provider_blocked_value()
        if blocked:
            raise ControlError(blocked)
        self.prepare_provider()
        self.state.update_recovery(phase='recovering_connection')
        state = self.observe_relay()
        # Never repair authentication, TLS, integrity, or identity errors by
        # changing state, restarting a service, or weakening verification.
        if state not in ('connected', 'unreachable'):
            raise ControlError(state)
        if state == 'unreachable':
            # A vendor tunnel command must not accidentally resume stopped
            # compute before the supervisor has applied the wake policy.
            host_state = self.provider.call('status')['host_state']
            self.state.set_host_state(host_state)
            if host_state in ('stopped', 'stopping'):
                if not wake:
                    raise ControlError('host_stopped')
                self.remote(wake=True)
            # Rebuild the local link first. A VPN failure is not evidence that
            # the remote daemon needs a restart.
            connected = False
            if 'tunnel' in self.config['components']:
                self.restart_component('tunnel')
                connected = self.wait_for_relay()
            if not connected:
                self.remote(wake=wake)
                # Some forwarders exit on a refused remote connection. The
                # remote daemon is ready now; rebuild the link and verify it.
                if 'tunnel' in self.config['components']:
                    self.restart_component('tunnel')
                if not self.wait_for_relay():
                    raise ControlError('unreachable')
        if 'gateway' in self.config['components']:
            self.start_component('gateway')
        self.state.update_recovery(phase='monitoring')

    def submit(self, value):
        if not isinstance(value, dict) or set(value) - {'component', 'action', 'confirmed'}:
            raise ControlError('invalid_action')
        if self.stop.is_set():
            raise ControlError('operation_cancelled')
        name, action = normalize_component(self.config, value.get('component')), value.get('action')
        if name not in (*COMPONENTS, 'all', 'remote') or action not in ('start', 'restart', 'recover', 'wake', 'stop'):
            raise ControlError('invalid_action')
        if action in ('restart', 'stop', 'wake') and value.get('confirmed') is not True:
            raise ControlError('confirmation_required')
        if action in ('wake', 'stop') and (name != 'remote' or not self.supports('host.' + action)):
            raise ControlError('invalid_action')
        if name == 'remote' and action not in ('wake', 'stop') or action == 'recover' and name != 'all':
            raise ControlError('invalid_action')
        if name == 'relay' and not self.supports('relay.restart' if action == 'restart' else 'relay.ensure'):
            raise ControlError('unsupported_operation')
        if not self.operation.acquire(blocking=False):
            raise ControlError('operation_in_progress')
        self.state.begin_operation(action + '_' + name)

        def work():
            try:
                if action == 'restart' and name in ('dashboard', 'all'):
                    # Let the accepted response reach the browser before its
                    # dashboard connection is deliberately shut down.
                    self.stop.wait(0.5)
                if action == 'stop':
                    self.stop_host()
                elif action == 'wake':
                    self.remote(wake=True)
                    self.recover()
                elif action == 'recover' or name == 'all' and action == 'start':
                    local_error = None
                    for component in ('dashboard', 'gateway', 'opencode', 'desktop'):
                        spec = self.config['components'].get(component, {})
                        if spec.get('command') or spec.get('start_command'):
                            try:
                                self.start_component(component)
                            except ControlError as error:
                                self.state.set_component(component, str(error))
                                local_error = error
                    self.recover(wake=self.state.settings_copy()['auto_wake'])
                    if local_error:
                        raise local_error
                elif name == 'all':
                    self.remote(wake=self.state.settings_copy()['auto_wake'], restart=True)
                    for component in ('tunnel', 'gateway', 'opencode', 'desktop', 'dashboard'):
                        spec = self.config['components'].get(component, {})
                        if spec.get('command') or spec.get('restart_command'):
                            self.restart_component(component)
                    if not self.wait_for_relay():
                        raise ControlError('unreachable')
                elif name == 'relay':
                    self.remote(wake=self.state.settings_copy()['auto_wake'], restart=action == 'restart')
                    if 'tunnel' in self.config['components']:
                        self.restart_component('tunnel')
                    if not self.wait_for_relay():
                        raise ControlError('unreachable')
                elif action == 'restart':
                    self.restart_component(name)
                else:
                    self.start_component(name)
            except ControlError as error:
                self.state.update_recovery(last_error=str(error))
                if str(error) in PERMANENT:
                    self.policy.set_provider_blocked(str(error))
            except Exception as error:
                self.state.update_recovery(last_error='operation_failed')
                print(f'{stamp()} supervisor operation failed: {type(error).__name__}', file=sys.stderr, flush=True)
            finally:
                self.policy.defer()
                self.state.finish_operation()
                self.operation.release()

        threading.Thread(target=work, daemon=True).start()

    def tick(self):
        if not self.operation.acquire(blocking=False):
            return
        try:
            for name, spec in self.config['components'].items():
                if 'command' in spec:
                    self.state.set_component(name, 'running' if self._identity(name) else 'stopped')
                elif name == 'opencode' and self.config.get('opencode_service_file'):
                    try:
                        registered = private_json(Path(self.config['opencode_service_file']))
                        self.state.set_component(name, 'running' if process(registered.get('pid', 0)) else 'stopped')
                    except (OSError, ValueError, ControlError):
                        self.state.set_component(name, 'unknown')
                elif spec.get('status_command'):
                    try:
                        self._run(spec['status_command'], timeout=3, env=spec.get('env'))
                        self.state.set_component(name, 'running')
                    except ControlError:
                        self.state.set_component(name, 'unknown')
            if self.state.dashboard_is_enabled() and 'dashboard' in self.config['components'] and \
                    self.state.component_value('dashboard') == 'stopped':
                self.start_component('dashboard')
            # Plugin failures must not prevent independent relay health checks or
            # local controls. Bound plugin retries separately from network retries.
            if self.policy.provider_due():
                try:
                    self.prepare_provider()
                    if self.policy.host_status_due():
                        host_state = self.provider.call('status')['host_state']
                        self.state.set_host_state(host_state)
                        self.policy.provider_ok(self.clock() + 15)
                    else:
                        self.policy.provider_ok()
                except ControlError as error:
                    self.policy.provider_failed(str(error), str(error) in PERMANENT)
            previous = self.state.relay_value()
            state = self.observe_relay()
            error, blocked, retry_at = self.policy.provider_status()
            if error or blocked:
                self.state.update_recovery(last_error=blocked or error, next_retry_at=retry_at)
                return
            if state == 'connected':
                self.state.update_recovery(phase='monitoring')
                settings = self.state.settings_copy()
                if settings['auto_reconnect'] and 'gateway' in self.config['components'] and \
                        self.state.component_value('gateway') == 'stopped':
                    self.start_component('gateway')
                return
            self.policy.note_failure()
            # Preserve the last recovery failure during the same outage. A
            # generic probe must not erase why SSH/service recovery failed.
            if state != 'unreachable' or previous != state or not self.state.recovery_value('last_error'):
                self.state.update_recovery(last_error=state)
            settings = self.state.settings_copy()
            if state != 'unreachable' or not settings['auto_reconnect'] or blocked:
                self.state.update_recovery(next_retry_at=None)
                return
            if not self.policy.recovery_due():
                return
            self.state.begin_attempt('recovering_connection')
            try:
                self.recover(wake=settings['auto_wake'])
            except ControlError as error:
                self.state.update_recovery(last_error=str(error))
                if str(error) in PERMANENT:
                    self.policy.set_provider_blocked(str(error))
            if self.state.relay_value() == 'connected':
                return
            retry_at = self.policy.schedule_retry()
            self.state.update_recovery(next_retry_at=retry_at)
        except ControlError as error:
            self.state.update_recovery(last_error=str(error))
            if str(error) in PERMANENT:
                self.policy.set_provider_blocked(str(error))
        except Exception as error:
            self.state.update_recovery(last_error='operation_failed')
            # The private controller log gets only the exception type; never
            # command output, credentials, request bodies, or full paths.
            print(f'{stamp()} supervisor tick failed: {type(error).__name__}', file=__import__('sys').stderr, flush=True)
        finally:
            self.state.finish_operation()
            self.operation.release()

    def monitor(self):
        while not self.stop.is_set():
            self.tick()
            self.stop.wait(5)
