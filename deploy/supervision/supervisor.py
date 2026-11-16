"""Supervisor orchestration: recovery policy, controls, and collaboration.

This module coordinates configuration, observable state, process ownership,
probes, and scheduling. It deliberately leaves file formats, provider
protocols, and remote helpers in their existing modules.
"""

import copy
from functools import wraps
import json
import os
from pathlib import Path
import stat
import sys
import threading
import re
import time
import traceback
import urllib.request

from recover_relay import NoRedirect
from remote_provider import (PERMANENT, RETRYABLE, ExecutableProvider, ProviderError as ControlError,
                             private_json, run_command)
from activity import ActivityJournal, operation_id

from .components import registry
from .config import COMPONENTS, INTERNET_CHECK_INTERVAL, default_gate_decision, enable_default_gate, validate
from .process import ProcessManager, process
from .probes import RelayProbe
from .recovery import RecoveryPolicy
from .state import SupervisorState, save_json, stamp
from .state_history import StateHistory, classify
from .onboarding import RemoteSetup
from .contracts import Observation
from .coordinator import Coordinator
from .network import NetworkMonitor
from .cancellation import Cancellation
from .topology import shutdown_blockers


RELAY_READINESS_TIMEOUT = 30
RELAY_READINESS_ATTEMPTS = 16
HOST_STOP_TIMEOUT = 180


def component_step(method):
    @wraps(method)
    def wrapped(self, name):
        with self.journal.context(component=name):
            self.journal.write('event', f'{method.__name__}: {name}')
            try:
                result = method(self, name)
            except Exception as error:
                self.journal.write('error', f'{method.__name__}: {type(error).__name__}: {error}')
                raise
            self.journal.write('event', f'{method.__name__} returned; service state={self.state.component_value(name)}')
            return result
    return wrapped


class Supervisor:
    def __init__(self, config, *, clock=None, probes=None, processes=None, policy=None,
                 command_runner=None, config_file=None):
        validate(config)
        gate_decision = default_gate_decision(config)
        config = enable_default_gate(config)
        validate(config)
        self.config = copy.deepcopy(config)
        self.config_file = Path(config_file) if config_file else None
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
        self.control_lock = threading.RLock()
        self.stop = threading.Event()
        self.interrupt = threading.Event()
        self.cancel = Cancellation(self.stop, self.interrupt)
        self.pending_stop = None
        self.journal = ActivityJournal(self.directory, self.config, self.stop)
        self.journal.write('event', f'Supervisor starting pid={os.getpid()} profile={self.root}; settings={settings}')
        if gate_decision == 'enabled':
            self.journal.write('event', 'Gate enabled by default; add components.gate to persist custom settings.')
        elif gate_decision in ('no_registration', 'no_binary'):
            self.journal.write('error', 'gate not activated; configure opencode_service_file and components.gate.')
        self.clock = clock or (lambda: time.monotonic())
        self.command_runner = command_runner
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.provider = (ExecutableProvider(self.config['remote'], self.config['relay_url'],
                                            self.cancel, trace=self.journal.sink('provider'))
                         if 'remote' in self.config else None)
        metadata = self.provider.metadata if self.provider else {'id': 'unconfigured', 'label': 'Remote host not set up', 'capabilities': []}
        self.state = SupervisorState(self.config, settings, metadata, journal=self.journal)
        self.setup = RemoteSetup(self.config, self.directory, self.journal, self.cancel)
        self.processes = processes or ProcessManager(self.config, self.root, self.directory,
                                                     self.state, self.stop, clock=self.clock, journal=self.journal)
        self.probes = probes or RelayProbe(self.config, self.opener, trace=self.journal.sink('network'))
        self.policy = policy or RecoveryPolicy(clock=self.clock)
        self.intent_lock = threading.RLock()
        intent_file = self.directory / 'intent.json'
        if intent_file.exists() or intent_file.is_symlink():
            intent = private_json(intent_file)
            if (not isinstance(intent, dict) or set(intent) != {'system', 'remote', 'components'} or
                    intent['system'] not in ('running', 'stopped') or intent['remote'] not in ('running', 'stopped') or
                    not isinstance(intent['components'], dict) or
                    any(name not in COMPONENTS or type(value) is not bool for name, value in intent['components'].items())):
                raise ControlError('configuration_error')
            self.state.set_intent(intent)
            # A crash between the intent and settings writes must still load a
            # paused system, not revive an earlier automatic-wake permission.
            if intent['system'] == 'stopped' or intent['remote'] == 'stopped':
                self.update_settings({'auto_reconnect': False, 'auto_wake': False})
        self.history = StateHistory(self.directory / 'state-history.jsonl', journal=self.journal)
        self.state.on_change = self._observe_history
        self.history.start(classify(self.state.history_observation()))
        self.coordinator = Coordinator(self)
        self.network_wakeup = threading.Event()
        self.network_monitor = NetworkMonitor(self.network_changed, self.stop)
        self.observer_thread = None
        self.network_thread = None
        self.journal.write('event', 'Executable provider diagnostics: capturing stdout/stderr and optional child-command trace pipe. A third-party provider cannot expose internal work it does not emit.', component='provider')
        for name in self.config['components']:
            self.journal.follow(name, self.directory / (name + '.log'))

    def _run(self, command, **kwargs):
        runner = self.command_runner or run_command
        return runner(command, cancel=self.cancel, trace=self.journal.sink(), **kwargs)

    def check_cancelled(self):
        if self.cancel.is_set():
            raise ControlError('operation_cancelled')

    def require_running(self, name):
        """All service-start paths honor persisted intent, not just the scheduler."""
        self.check_cancelled()
        intent = self.state.intent_copy()
        if name != 'dashboard' and intent['system'] == 'stopped':
            raise ControlError('system_stopped')
        if name in ('remote', 'relay', 'tunnel') and intent['remote'] == 'stopped':
            raise ControlError('host_stopped')

    def provider_call(self, method, params=None):
        if method in ('host.wake', 'relay.ensure', 'relay.restart'):
            self.require_running('remote')
        self.journal.write('event', f'Provider {method} started', component='provider')
        try:
            result = self.provider.call(method, params)
        except Exception as error:
            self.journal.write('error', f'Provider {method}: {type(error).__name__}: {error}', component='provider')
            raise
        self.journal.write('event', f'Provider {method} returned {json.dumps(result)}', component='provider')
        return result

    def snapshot(self):
        return self.state.snapshot()

    def _observe_history(self):
        self.history.observe(self.state.history_observation())

    def close(self):
        self.stop.set()
        for thread in (self.observer_thread, self.network_thread):
            if thread and thread is not threading.current_thread():
                thread.join(timeout=10)
        self.history.close()
        self.journal.close()

    def persist_intent(self, intent, *, stopping=False):
        with self.intent_lock:
            if not stopping:
                self.check_cancelled()
            save_json(self.directory / 'intent.json', intent)
            self.state.set_intent(intent)

    def suspend_recovery(self, *, system=False, interrupt=False):
        """Commit stop intent before cancelling work or changing any service."""
        with self.intent_lock:
            intent = self.state.intent_copy()
            intent['remote'] = 'stopped'
            if system:
                intent['system'] = 'stopped'
            self.persist_intent(intent, stopping=True)
            if interrupt:
                self.interrupt.set()
            self.update_settings({'auto_reconnect': False, 'auto_wake': False})
            self.state.update_recovery(next_retry_at=None)

    def network_changed(self):
        self.state.network_changed()
        self.policy.network_changed()
        self.network_wakeup.set()

    def observe_components(self):
        """Read-only observation lane; never starts, adopts or stops services."""
        # The mutation lane already refreshes the same facts while executing.
        # Avoiding overlap prevents a fast observer from overwriting an
        # in-progress lifecycle transition or duplicating network traffic.
        if self.operation.locked():
            return
        for name in ('dashboard', 'gate', 'gateway', 'opencode', 'desktop', 'tunnel'):
            try:
                self.coordinator.adapters[name].observe()
            except (OSError, ValueError, ControlError):
                self.state.observe(name, Observation(detail='Local check unavailable.'))
        plugin = self.probes.plugin()
        self.state.observe('plugin', Observation('unknown', plugin,
                           'Read-only plugin status for the explicitly configured OpenCode location; not proof of provider access.'))
        if self.provider is not None:
            self.observe_relay()

    def observe_loop(self):
        while not self.stop.is_set():
            try:
                self.observe_components()
            except Exception:
                self.journal.write('error', 'Independent observation unavailable; retaining last checked states.')
            self.stop.wait(3)

    def supports(self, method):
        return self.provider is not None and method in self.provider.metadata['capabilities']

    def prepare_provider(self):
        if self.provider is None:
            raise ControlError('setup_required')
        discovering = self.provider.connection is None
        if discovering:
            self.journal.write('event', 'Discovering provider description and connection', component='provider')
        connection = self.provider.prepare()
        self.state.set_metadata(self.provider.metadata)
        tunnel = connection.get('tunnel')
        if tunnel and 'tunnel' not in self.config['components']:
            env = dict(self.provider.spec.get('env', {}))
            env.update({key: os.environ[key] for key in self.provider.spec.get('pass_env', []) if key in os.environ})
            spec = {**tunnel, 'pid_file': str(self.directory / 'provider-tunnel.pid'), 'env': env}
            self.config['components']['tunnel'] = spec
            self.state.register_component('tunnel', spec)
            self.journal.follow('tunnel', self.directory / 'tunnel.log')
        if discovering:
            self.journal.write('event', f'Provider ready: {self.provider.metadata}; connection={json.dumps(connection)}', component='provider')
        self.state.observe('remote_provider', Observation('running', 'ready', 'Provider contract and stable connection description verified.'))

    def expected_identity(self):
        return self.probes.expected_identity()

    def setup_status(self):
        return self.setup.status(self.state.recovery_value('busy'))

    def submit_setup(self, value):
        self.require_running('remote')
        if not self.operation.acquire(blocking=False):
            raise ControlError('operation_in_progress')
        try:
            request = self.setup.request(value)
        except Exception:
            self.operation.release()
            raise
        operation = operation_id()
        self.setup.last_error = ''
        self.state.begin_operation('setting_up_remote_host')

        def work():
            with self.journal.context(trigger='manual', operation=operation, component='setup'):
                self.journal.write('event', f'Confirmed first-time remote setup: {request}')
                try:
                    remote = self.setup.install(request)
                    self.config['remote'] = remote
                    self.provider = ExecutableProvider(remote, self.config['relay_url'], self.cancel,
                                                       trace=self.journal.sink('provider'))
                    self.recover()
                except ControlError as error:
                    self.setup.last_error = str(error)
                    self.state.update_recovery(last_error=str(error))
                    self.journal.write('error', f'Remote setup failed: {error}; retry resumes only this same deployment')
                except Exception:
                    self.setup.last_error = 'setup_failed'
                    self.state.update_recovery(last_error='setup_failed')
                    self.journal.write('error', traceback.format_exc())
                else:
                    self.journal.write('event', 'Remote setup complete; authenticated relay and local gateway ready. No model request was submitted.')
                finally:
                    self.state.finish_operation()
                    self.operation.release()

        threading.Thread(target=work, daemon=True).start()

    def update_settings(self, value):
        if not isinstance(value, dict) or set(value) != {'auto_reconnect', 'auto_wake'} or any(type(v) is not bool for v in value.values()):
            raise ControlError('invalid_settings')
        if value['auto_wake'] and not self.supports('host.wake'):
            raise ControlError('unsupported_operation')
        with self.intent_lock:
            if any(value.values()):
                self.require_running('remote')
            self.state.apply_settings(value, lambda settings: save_json(self.directory / 'settings.json', settings))
        self.journal.write('event', f'Recovery settings persisted: {value}', component='settings')
        self.policy.reset_attempt()

    def _identity(self, name):
        return self.processes.identity(name)

    def guard_tunnel(self):
        """Only start a transport after fresh proof that compute is running."""
        if self.provider is not None and self.provider.connection is None:
            try:
                # Capabilities may still be undiscovered after a supervisor
                # restart. Discover them BEFORE deciding that a gh transport is
                # safe to start; an empty capability list is not proof of safety.
                self.prepare_provider()
            except ControlError:
                self.state.set_host_state('unknown')
                raise
        if not self.supports('host.wake'):
            return
        try:
            host_state = self.provider_call('status')['host_state']
        except ControlError:
            self.state.set_host_state('unknown')
            # gh connection commands can implicitly wake compute. A cached
            # running state is not authorization to connect during an outage.
            raise
        self.state.set_host_state(host_state)
        if host_state in ('stopped', 'stopping'):
            raise ControlError('host_stopped')
        if host_state != 'running':
            raise ControlError('host_unavailable')

    @component_step
    def start_component(self, name):
        self.require_running(name)
        if name == 'gateway' and self.provider is None:
            raise ControlError('setup_required')
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if name == 'tunnel':
            self.guard_tunnel()
        self.require_running(name)
        if 'command' not in spec:
            command = spec.get('start_command')
            if not command:
                raise ControlError('component_unmanaged')
            self._run(command, env=spec.get('env'))
            self.state.set_component(name, 'started')
            return
        self.processes.start(name)

    @component_step
    def restart_component(self, name):
        self.require_running(name)
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if name == 'tunnel':
            self.guard_tunnel()
        if 'command' not in spec:
            if not spec.get('restart_command'):
                raise ControlError('component_unmanaged')
            self._run(spec['restart_command'], env=spec.get('env'))
            self.state.set_component(name, 'started')
            return
        self.processes.stop(name)
        if name == 'tunnel':
            # The last relay probe was through the old transport. Neither the
            # relay nor the tunnel can remain verified after it is stopped.
            self.state.record_relay('unknown')
        self.start_component(name)

    @component_step
    def stop_component(self, name):
        spec = self.config['components'].get(name, {})
        if 'command' not in spec:
            if not spec.get('stop_command'):
                raise ControlError('shutdown_not_configured')
            self._run(spec['stop_command'], env=spec.get('env'))
            # Completion is not independent proof that the service stopped.
            self.state.set_component(name, 'unknown')
            if name == 'tunnel':
                self.state.record_relay('unknown')
            return
        self.processes.stop(name)
        if name == 'tunnel':
            self.state.record_relay('unknown')

    def probe(self):
        result = self.probes.relay()
        self.journal.write('event', f'Authenticated relay probe result: {result}', component='network')
        return result

    def internet_probe(self):
        result = self.probes.internet()
        self.journal.write('event', f'Internet probe result: {result}', component='network')
        return result

    def update_internet(self, relay_state):
        if relay_state == 'unreachable':
            now = self.clock()
            with self.state.lock:
                due = self.state.internet_state == 'unknown' or now >= self.state.internet_next
            if not due:
                self.journal.write('event', 'Internet probe skipped: using cached result (15s interval)', component='network')
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
        deadline = self.clock() + (HOST_STOP_TIMEOUT if wanted == 'stopped' else 120)
        self.state.set_host_state(result['host_state'])
        while self.state.host_value() != wanted:
            self.journal.write('event', f'Waiting for host={wanted}; observed={self.state.host_value()}; polling in 3s', component='provider')
            if self.cancel.wait(3):
                raise ControlError('operation_cancelled')
            if self.clock() >= deadline:
                raise ControlError('host_stop_timeout' if wanted == 'stopped' else 'host_unavailable')
            try:
                self.state.set_host_state(self.provider_call('status')['host_state'])
            except ControlError as error:
                self.state.set_host_state('unknown')
                if str(error) not in RETRYABLE:
                    raise
                # Only successful provider observations establish power state.
                # A transient API failure must not discard an accepted shutdown.
                self.journal.write('event', f'Host confirmation temporarily unavailable: {error}', component='provider')

    def stop_host(self, stop_tunnel=True):
        # Persist suppression before any tunnel/provider operation, including a
        # failed shutdown. Neither a retry nor a supervisor restart may wake it.
        self.suspend_recovery()
        local_error = None
        if stop_tunnel and 'command' in self.config['components'].get('tunnel', {}):
            try:
                self.stop_component('tunnel')
            except Exception as error:
                local_error = error
        self.state.set_host_state('unknown')
        # A shutdown attempt invalidates an earlier authenticated relay probe,
        # even before the provider confirms power-off.
        self.state.set_relay_state('unknown')
        self.state.update_recovery(phase='stopping_remote_host')
        try:
            result = self.provider_call('host.stop')
        except ControlError as error:
            if str(error) not in RETRYABLE:
                raise
            self.journal.write('event', f'Shutdown request outcome uncertain: {error}; confirming through read-only status', component='provider')
            result = {'host_state': 'unknown'}
        self.wait_for_host('stopped', result)
        self.state.set_relay_state('unreachable')
        self.state.set_component('relay', 'stopped')
        self.state.update_recovery(last_error='host_stopped')
        if local_error:
            raise local_error

    def remote(self, wake=False, restart=False):
        self.require_running('remote')
        blocked = self.policy.provider_blocked_value()
        if blocked:
            self.journal.write('error', f'Remote operation blocked by permanent failure: {blocked}')
            raise ControlError(blocked)
        self.prepare_provider()
        state = self.probe()
        if state not in ('connected', 'unreachable'):
            raise ControlError(state)
        expected = self.expected_identity()
        if wake and self.supports('host.wake'):
            self.state.update_recovery(phase='waking_remote_host')
            self.wait_for_host('running', self.provider_call('host.wake'))
        method = 'relay.restart' if restart else 'relay.ensure'
        if self.supports(method):
            self.state.update_recovery(phase='recovering_remote_relay')
            try:
                result = self.provider_call(method, {'expected_state_id': expected})
            except ControlError as error:
                if str(error) == 'host_stopped':
                    self.state.set_host_state('stopped')
                raise
            if result['state_id'] != expected:
                raise ControlError('identity_mismatch')
            self.state.set_component('relay', 'starting')
        else:
            host_state = self.provider_call('status')['host_state']
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
        # A cold Codespace forward can refuse connections immediately for several
        # seconds before it is usable. Give it a real readiness window, not just
        # five fast failures. Bound both elapsed time and the number of probes.
        deadline = self.clock() + RELAY_READINESS_TIMEOUT
        for attempt in range(RELAY_READINESS_ATTEMPTS):
            self.journal.write('event', f'Relay readiness check {attempt + 1}/{RELAY_READINESS_ATTEMPTS}', component='network')
            if self.cancel.wait(min(2, max(0, deadline - self.clock())) if attempt else 0):
                raise ControlError('operation_cancelled')
            state = self.observe_relay()
            if state == 'connected':
                return True
            if state != 'unreachable':
                raise ControlError(state)
            if self.clock() >= deadline:
                break
        return False

    def recover(self, wake=False):
        return self.coordinator.connection(wake=wake)

    def submit(self, value):
        # Requests never wait for the mutation lane while holding this lock.
        # A stop can persist suppression and cancel its current owner immediately.
        with self.control_lock:
            return self._submit(value)

    def _submit(self, value):
        if not isinstance(value, dict) or set(value) - {'component', 'action', 'confirmed', 'request_id'}:
            raise ControlError('invalid_action')
        if self.stop.is_set():
            raise ControlError('operation_cancelled')
        name, action = value.get('component'), value.get('action')
        if name == 'vscode' or action == 'open':
            # Opening the editor changes no service state, so it bypasses the operation lane.
            return self.open_editor(name, action)
        if name not in (*COMPONENTS, 'all', 'remote') or action not in ('start', 'restart', 'recover', 'wake', 'stop'):
            raise ControlError('invalid_action')
        if (action in ('restart', 'stop', 'wake') or name == 'all' and action == 'start') and value.get('confirmed') is not True:
            raise ControlError('confirmation_required')
        if action == 'wake' and (name != 'remote' or not self.supports('host.wake')):
            raise ControlError('invalid_action')
        if action == 'stop' and name not in ('gate', 'gateway', 'tunnel', 'opencode', 'desktop', 'remote', 'all'):
            raise ControlError('invalid_action')
        if action == 'stop' and name == 'remote' and not self.supports('host.stop'):
            raise ControlError('invalid_action')
        if name == 'remote' and action not in ('wake', 'stop'):
            raise ControlError('invalid_action')
        if name == 'relay' and not self.supports('relay.restart' if action == 'restart' else 'relay.ensure'):
            raise ControlError('unsupported_operation')
        intent = self.state.intent_copy()
        if intent['system'] == 'stopped' and (name, action) not in (('all', 'start'), ('all', 'stop'), ('remote', 'stop')):
            # Intentional stop outranks stale UI state and manual API callers.
            raise ControlError('system_stopped')
        request_id = value.get('request_id', '')
        if not isinstance(request_id, str) or request_id and not re.fullmatch('[a-f0-9]{32}', request_id):
            raise ControlError('invalid_action')
        previous = self.state.run_copy()
        if request_id and previous and previous.get('request_id') == request_id:
            if (previous['target'], previous['action']) != (name, action):
                raise ControlError('invalid_action')
            return previous['id']
        if self.pending_stop:
            operation, target, previous_request = self.pending_stop
            if request_id and request_id == previous_request and name == target and action == 'stop':
                return operation
            raise ControlError('operation_in_progress')
        stopping = action == 'stop' and name in ('all', 'remote')
        if stopping and name == 'all' and shutdown_blockers(self.state):
            raise ControlError('shutdown_not_configured')
        acquired = self.operation.acquire(blocking=False)
        if not acquired and not stopping:
            raise ControlError('operation_in_progress')
        operation = operation_id()
        try:
            if stopping:
                self.suspend_recovery(system=name == 'all', interrupt=True)
                self.pending_stop = (operation, name, request_id)
            if acquired:
                self._begin_control(name, action, operation, request_id)
            else:
                self.state.update_recovery(phase='stopping_system' if name == 'all' else 'stopping_remote_host',
                                           busy=True, next_retry_at=None)
        except Exception:
            if stopping:
                self.pending_stop = None
            if acquired:
                self.operation.release()
            raise
        with self.journal.context(trigger='manual', operation=operation, component=name):
            self.journal.write('event', f'Accepted control action: {action} {name}; confirmed={value.get("confirmed", False)}')

        def work():
            with self.journal.context(trigger='manual', operation=operation, component=name):
                if not acquired:
                    # The interrupted owner finishes its checkpoint and kills its
                    # command group before shutdown takes over the same lane.
                    self.operation.acquire()
                    try:
                        with self.control_lock:
                            self._begin_control(name, action, operation, request_id)
                    except Exception:
                        with self.control_lock:
                            self.pending_stop = None
                        self.state.finish_operation()
                        self.operation.release()
                        self.journal.write('error', 'Shutdown could not acquire a live operation context; recovery remains paused.')
                        return
                run_work()

        def run_work():
            failure = ''
            try:
                if action == 'restart' and name in ('dashboard', 'all'):
                    # Let the accepted response reach the browser before its
                    # dashboard connection is deliberately shut down.
                    self.stop.wait(0.5)
                self.coordinator.manual(name, action)
            except ControlError as error:
                failure = str(error)
                self.journal.write('error', f'Control action failed: {action} {name}: {error}')
                self.state.update_recovery(last_error=str(error))
                if str(error) in PERMANENT:
                    self.policy.set_provider_blocked(str(error))
            except Exception as error:
                failure = 'operation_failed'
                self.state.update_recovery(last_error='operation_failed')
                print(f'{stamp()} supervisor operation failed: {type(error).__name__}', file=sys.stderr, flush=True)
                self.journal.write('error', traceback.format_exc())
            else:
                self.journal.write('event', f'Control action completed: {action} {name}')
            finally:
                try:
                    self.coordinator.finish(failure)
                finally:
                    self.policy.defer()
                    self.state.finish_operation()
                    with self.control_lock:
                        if stopping:
                            self.pending_stop = None
                        self.operation.release()

        threading.Thread(target=work, daemon=True).start()
        return operation

    def _begin_control(self, name, action, operation, request_id):
        if self.stop.is_set():
            raise ControlError('operation_cancelled')
        # Clearing a cancelled attempt never resumes stopped intent. Only the
        # explicitly confirmed Start/wake operations may change that intent.
        self.interrupt.clear()
        self.coordinator.begin(name, action, identifier=operation, request_id=request_id)
        self.state.begin_operation(action + '_' + name)

    def open_editor(self, name, action):
        """Open the configured editor on request; the editor is not supervised after launch."""
        if name != 'vscode' or action != 'open' or not self.state.editor_open:
            raise ControlError('invalid_action')
        self.processes.open_editor(self.config['vscode'])
        with self.journal.context(trigger='manual', component='vscode'):
            self.journal.write('event', 'Editor open requested from the dashboard; the supervisor does not restart or observe it.')

    def reload_managed(self):
        """Apply operator edits to managed component commands without stopping anything."""
        path = getattr(self, 'config_file', None)
        if not path or not path.exists():
            return False
        changed = private_json(path)
        validate(changed)
        if (changed.get('profile') != self.config.get('profile') or
                changed.get('remote') != self.config.get('remote')):
            raise ControlError('configuration_error')
        return self.apply_managed(changed['components'])

    def apply_managed(self, components):
        """Register only newly configured lifecycle specs; existing children keep ownership."""
        changed = False
        for name in COMPONENTS:
            spec = components.get(name)
            previous = self.config['components'].get(name)
            if spec == previous:
                continue
            provider_tunnel = (name == 'tunnel' and self.provider is not None and
                               self.provider.connection is not None and self.provider.connection.get('tunnel'))
            if provider_tunnel and not spec:
                # Injected runtime transport is owned by the provider contract,
                # not written back to private configuration.
                continue
            if previous and (previous.get('command') or previous.get('start_command')) and not spec:
                self.journal.write('event', f'Managed component remains owned while omitted from configuration: {name}', component=name)
                continue
            if previous and (previous.get('command') or previous.get('start_command')):
                # Replacing arguments for a running child can silently create a
                # second owner. Require an explicit supervisor restart instead.
                raise ControlError('configuration_error')
            if spec:
                for forbidden in ('adopt_match',):
                    if forbidden in spec:
                        raise ControlError('configuration_error')
                if 'command' in spec and not Path(spec.get('pid_file', '')).is_absolute():
                    raise ControlError('invalid_configuration')
                self.config['components'][name] = dict(spec)
                self.state.register_component(name, spec)
                if 'command' in spec:
                    self.journal.follow(name, self.directory / (name + '.log'))
                changed = True
            elif previous:
                self.config['components'].pop(name, None)
                self.state.register_component(name, {}, managed=False)
                changed = True
        if changed:
            self.coordinator.adapters = registry(self)
            self.journal.write('event', 'Managed component actions reloaded without stopping live services')
        return changed

    def tick(self):
        with self.journal.context(trigger='monitor', operation=operation_id()):
            self.journal.write('event', 'Scheduled supervisor check')
            try:
                self.reload_managed()
            except (OSError, ValueError, ControlError):
                self.journal.write('error', 'Managed component configuration reload failed; live services were not changed.')
            self._tick()

    def _tick(self):
        if not self.operation.acquire(blocking=False):
            self.journal.write('event', 'Scheduled check skipped: a control operation is in progress')
            return
        try:
            if self.interrupt.is_set():
                # Shutdown owns the next mutation slot. Do not let a scheduled
                # check overtake it after the interrupted recovery releases it.
                return
            for name, spec in self.config['components'].items():
                if 'command' in spec:
                    identity = self._identity(name)
                    if (identity and self.state.component_value(name) != 'running') or (not identity and self.state.component_value(name) != 'stopped'):
                        self.journal.write('event', f'Process identity check: {"verified pid=" + str(identity["pid"]) if identity else "no verified running process"}', component=name)
                    self.state.set_component(name, 'running' if identity else 'stopped')
                elif name == 'opencode' and self.config.get('opencode_service_file'):
                    try:
                        registered = private_json(Path(self.config['opencode_service_file']))
                        self.state.set_component(name, 'running' if process(registered.get('pid', 0)) else 'stopped')
                    except (OSError, ValueError, ControlError) as error:
                        self.journal.write('error', f'OpenCode process registration check: {type(error).__name__}: {error}', component=name)
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
            # An intentionally stopped stack stays stopped across route changes
            # and supervisor restarts. Read-only observations still continue.
            intent = self.state.intent_copy()
            if intent['system'] == 'stopped':
                # Pausing recovery must not pause read-only power observations.
                # Never use the old host state as proof that a stopped system
                # actually stopped its VPS (or stayed running).
                if self.provider is not None and self.provider.connection is None:
                    try:
                        # Describe/connection only; no wake or transport command.
                        self.prepare_provider()
                    except ControlError as error:
                        self.journal.write('error', f'Provider discovery while stopped failed: {error}', component='provider')
                        self.policy.provider_failed(str(error), str(error) in PERMANENT)
                if self.provider is not None and self.policy.provider_due() and self.policy.host_status_due():
                    try:
                        self.state.set_host_state(self.provider_call('status')['host_state'])
                        self.policy.provider_ok(self.clock() + 15)
                    except ControlError as error:
                        self.state.set_host_state('unknown')
                        self.policy.provider_failed(str(error), str(error) in PERMANENT)
                self.state.update_recovery(phase='system_stopped', next_retry_at=None)
                return
            # Local service repair is independent of remote management failures.
            # Desktop exit is not automatically undone (the user may close it).
            if self.state.settings_copy()['auto_reconnect']:
                for name in ('gate', 'gateway', 'opencode'):
                    lifecycle = self.state.component_value(name)
                    # A running gate can still have a dead listener. Its livez
                    # observation, not process existence, decides repair.
                    gate_unready = (name == 'gate' and lifecycle == 'running' and
                                    self.state.observations.get('gate', {}).get('readiness') == 'not_ready')
                    if (name in self.config['components'] and self.state.wanted(name) and
                            (lifecycle == 'stopped' or gate_unready) and self.policy.component_due(name) and
                            (name != 'gateway' or self.provider is not None)):
                        try:
                            self.coordinator.local(name, 'recover')
                        except ControlError:
                            self.policy.component_result(name, False)
                        else:
                            self.policy.component_result(name, True)
            if self.provider is None:
                self.state.update_recovery(phase='setup_required', last_error='setup_required')
                return
            # Plugin failures must not prevent independent relay health checks or
            # local controls. Bound plugin retries separately from network retries.
            if self.policy.provider_due():
                try:
                    self.prepare_provider()
                    if self.policy.host_status_due():
                        host_state = self.provider_call('status')['host_state']
                        self.state.set_host_state(host_state)
                        self.policy.provider_ok(self.clock() + 15)
                    else:
                        self.policy.provider_ok()
                except ControlError as error:
                    self.journal.write('error', f'Provider discovery/status check failed: {error}', component='provider')
                    self.policy.provider_failed(str(error), str(error) in PERMANENT)
                    self.state.observe('remote_provider', Observation('unknown', 'blocked' if str(error) in PERMANENT else 'not_ready',
                                       'Remote management unavailable; relay health is checked independently.'))
            previous = self.state.relay_value()
            state = self.observe_relay()
            error, blocked, retry_at = self.policy.provider_status()
            if blocked:
                self.journal.write('event', f'Recovery deferred: provider_error={error} blocked={blocked} next_retry_at={retry_at}')
                self.state.update_recovery(last_error=blocked, next_retry_at=retry_at)
                return
            if error:
                # Remote-host API failures must not prevent an independent local
                # transport repair. The coordinator will still block permanent
                # failures and will never wake a host without explicit consent.
                self.journal.write('event', f'Transient provider observation failure: {error}; checking whether local transport recovery can proceed')
            if state == 'connected':
                self.state.update_recovery(phase='monitoring')
                return
            self.policy.note_failure()
            # Preserve the last recovery failure during the same outage. A
            # generic probe must not erase why SSH/service recovery failed.
            if state != 'unreachable' or previous != state or not self.state.recovery_value('last_error'):
                self.state.update_recovery(last_error=state)
            settings = self.state.settings_copy()
            if state != 'unreachable' or not settings['auto_reconnect'] or blocked or intent['remote'] == 'stopped':
                self.journal.write('event', f'Automatic recovery skipped: relay={state} auto_reconnect={settings["auto_reconnect"]} blocked={blocked}')
                self.state.update_recovery(next_retry_at=None)
                return
            if 'tunnel' in self.config['components'] and not self.state.wanted('tunnel'):
                self.journal.write('event', 'Automatic connection recovery paused: transport was intentionally stopped')
                self.state.update_recovery(phase='monitoring', next_retry_at=None)
                return
            if not self.policy.recovery_due():
                self.journal.write('event', f'Automatic recovery waiting for debounce/backoff; next_retry_at={self.state.recovery_value("next_retry_at")}')
                return
            self.state.begin_attempt('recovering_connection')
            try:
                with self.journal.context(trigger='automatic'):
                    self.journal.write('event', f'Automatic recovery attempt {self.state.recovery_value("attempts")} triggered')
                    self.recover(wake=settings['auto_wake'])
            except ControlError as error:
                self.journal.write('error', f'Automatic recovery failed: {error}')
                self.state.update_recovery(last_error=str(error))
                if str(error) in PERMANENT:
                    self.policy.set_provider_blocked(str(error))
            if self.state.relay_value() == 'connected':
                return
            retry_at = self.policy.schedule_retry()
            self.state.update_recovery(next_retry_at=retry_at)
        except ControlError as error:
            self.journal.write('error', f'Scheduled supervisor check failed: {error}')
            self.state.update_recovery(last_error=str(error))
            if str(error) in PERMANENT:
                self.policy.set_provider_blocked(str(error))
        except Exception as error:
            self.state.update_recovery(last_error='operation_failed')
            # The private controller log gets only the exception type; never
            # command output, credentials, request bodies, or full paths.
            print(f'{stamp()} supervisor tick failed: {type(error).__name__}', file=__import__('sys').stderr, flush=True)
            self.journal.write('error', traceback.format_exc())
        finally:
            self.state.finish_operation()
            self.operation.release()

    def monitor(self):
        self.network_thread = threading.Thread(target=self.network_monitor.run, daemon=True)
        self.observer_thread = threading.Thread(target=self.observe_loop, daemon=True)
        self.network_thread.start()
        self.observer_thread.start()
        while not self.stop.is_set():
            self.tick()
            self.history.tick()
            self.network_wakeup.wait(5)
            self.network_wakeup.clear()
