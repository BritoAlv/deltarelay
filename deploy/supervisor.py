#!/usr/bin/env python3
"""Private, single-user service supervisor. No inference, shell API, or public listener."""

import argparse
import copy
import fcntl
import http.server
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import stat
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

from recover_relay import NoRedirect, private_text
from remote_provider import (PERMANENT, ProviderError as ControlError, environment,
                             origin, plugin_environment, private_json, run_command, validate_spec)
from providers.legacy import load_provider, normalize_component, validate_legacy


COMPONENTS = ('dashboard', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop')
LABELS = dict(zip(COMPONENTS, ('Dashboard', 'Local gateway', 'VPS connection', 'Remote relay', 'OpenCode service', 'Isolated Desktop')))
DEFAULT_INTERNET_CHECK_URL = 'https://example.com/'
INTERNET_CHECK_INTERVAL = 15


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


def process(pid):
    try:
        root = Path('/proc') / str(int(pid))
        if int(pid) <= 1 or root.stat().st_uid != os.getuid():
            return None
        fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        args = os.fsdecode((root / 'cmdline').read_bytes()).split('\0')
        return {'pid': int(pid), 'birth': fields[19], 'args': args}
    except (OSError, ValueError, IndexError):
        return None


def matches(info, expected):
    # Electron can rewrite argv's NUL separators into spaces. Require complete
    # argument boundaries, not a broad substring or a system-wide pkill pattern.
    command = ' ' + ' '.join(info['args']).strip() + ' '
    return bool(expected) and all(part in info['args'] or ' ' + part + ' ' in command for part in expected)


def loopback_origin(value, https=False):
    return origin(value) and (https or value.startswith('http://'))


def internet_check_origin(value):
    return origin(value)


def validate(config):
    if not isinstance(config, dict) or config.get('version') != 1 or not isinstance(config.get('components'), dict):
        raise ControlError('invalid_configuration')
    for key in ('profile', 'relay_token_file', 'relay_state_file', 'local_token_file'):
        if not isinstance(config.get(key), str) or not Path(config[key]).is_absolute():
            raise ControlError('absolute_private_paths_required')
    if not loopback_origin(config.get('relay_url', ''), https=True) or not loopback_origin(config.get('gateway_url', '')):
        raise ControlError('unsafe_endpoint')
    if not isinstance(config.get('internet_check_url', DEFAULT_INTERNET_CHECK_URL), str) or \
            not internet_check_origin(config.get('internet_check_url', DEFAULT_INTERNET_CHECK_URL)):
        raise ControlError('unsafe_internet_check')
    for name, spec in config['components'].items():
        if name not in COMPONENTS or not isinstance(spec, dict):
            raise ControlError('invalid_component')
        for key in ('command', 'start_command', 'restart_command', 'status_command', 'match', 'adopt_match'):
            if key in spec and (not isinstance(spec[key], list) or not spec[key] or
                                any(not isinstance(arg, str) or not arg or '\0' in arg for arg in spec[key])):
                raise ControlError('invalid_command')
        if 'command' in spec and not Path(spec.get('pid_file', '')).is_absolute():
            raise ControlError('absolute_pid_file_required')
        if 'port' in spec and (type(spec['port']) is not int or not 0 < spec['port'] < 65536):
            raise ControlError('invalid_port')
    if 'remote' in config:
        validate_spec(config['remote'])
        if config.get('codespace') or any(name in config['components'] for name in ('tunnel', 'relay')):
            raise ControlError('ambiguous_remote_configuration')
    validate_legacy(config)


class Supervisor:
    def __init__(self, config):
        validate(config)
        self.config = copy.deepcopy(config)
        self.root = Path(config['profile'])
        self.directory = self.root / 'control'
        self.directory.mkdir(mode=0o700, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ControlError('unsafe_control_directory')
        self.settings = {'auto_reconnect': True, 'auto_wake': False}
        settings = self.directory / 'settings.json'
        if settings.exists() or settings.is_symlink():
            loaded = private_json(settings)
            if set(loaded) != set(self.settings) or any(type(v) is not bool for v in loaded.values()):
                raise ControlError('invalid_settings')
            self.settings = loaded
        self.lock = threading.RLock()
        self.operation = threading.Lock()
        self.stop = threading.Event()
        self.children = {}
        self.identities = {}
        self.states = {name: 'unknown' if name in config['components'] else 'unmanaged' for name in COMPONENTS}
        self.recovery = {'busy': False, 'phase': 'starting', 'attempts': 0, 'last_error': '',
                         'last_connected_at': None, 'next_retry_at': None}
        self.relay_state = 'unknown'
        self.host_state = 'unknown'
        self.provider_blocked = ''
        self.provider_next = 0.0
        self.provider_delay = 2
        self.provider_error = ''
        self.host_status_next = 0.0
        self.provider = load_provider(self.config, lambda *args, **kwargs: run_command(*args, cancel=self.stop, **kwargs),
                                      self.stop, self.start_component, self.restart_component)
        if 'relay.ensure' in self.provider.metadata['capabilities']:
            self.states['relay'] = 'unknown'
        self.internet_state = 'unknown'
        self.internet_checked_at = None
        self.internet_next = 0.0
        self.failures = 0
        self.delay = 2
        self.next_attempt = 0
        self.dashboard_enabled = True
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def snapshot(self):
        with self.lock:
            components = []
            for name in COMPONENTS:
                spec = self.config['components'].get(name, {})
                components.append({'id': name, 'label': LABELS[name], 'state': self.states[name],
                                   'can_start': bool(spec.get('command') or spec.get('start_command') or name == 'relay' and self.supports('relay.ensure')),
                                   'can_restart': bool(spec.get('command') or spec.get('restart_command') or name == 'relay' and self.supports('relay.restart'))})
            return {'version': 2, 'managed': True, 'collected_at': stamp(), 'settings': dict(self.settings),
                    'recovery': dict(self.recovery), 'relay_state': self.relay_state,
                    'internet_state': self.internet_state, 'internet_checked_at': self.internet_checked_at,
                    'remote': {**self.provider.metadata, 'host_state': self.host_state}, 'components': components}

    def supports(self, method):
        return method in self.provider.metadata['capabilities']

    def prepare_provider(self):
        connection = self.provider.prepare()
        tunnel = connection.get('tunnel')
        if tunnel and 'tunnel' not in self.config['components']:
            env = dict(self.provider.spec.get('env', {}))
            env.update({key: os.environ[key] for key in self.provider.spec.get('pass_env', []) if key in os.environ})
            self.config['components']['tunnel'] = {**tunnel, 'pid_file': str(self.directory / 'provider-tunnel.pid'),
                                                  'env': env}
            self.states['tunnel'] = 'unknown'

    def expected_identity(self):
        try:
            expected = private_json(Path(self.config['relay_state_file']), 4096)
        except (OSError, ValueError, ControlError):
            raise ControlError('identity_unavailable') from None
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ControlError('identity_unavailable')
        return expected

    def update_settings(self, value):
        if not isinstance(value, dict) or set(value) != set(self.settings) or any(type(v) is not bool for v in value.values()):
            raise ControlError('invalid_settings')
        if value['auto_wake'] and 'remote' in self.config and not self.supports('host.wake'):
            raise ControlError('unsupported_operation')
        with self.lock:
            save_json(self.directory / 'settings.json', value)
            self.settings = dict(value)
            self.next_attempt = 0

    def _identity(self, name):
        spec = self.config['components'][name]
        child = self.children.get(name)
        if child is not None:
            child.poll()  # Reap exited children; never rely on kill(pid, 0).
        info = None
        try:
            info = process(int(Path(spec['pid_file']).read_text().strip()))
        except (OSError, ValueError):
            pass
        expected = spec.get('match', spec['command'])
        if info and (matches(info, expected) or matches(info, spec.get('adopt_match', []))):
            # Status/adoption may follow a service manager's own restart. The
            # destructive path rechecks PID birth immediately before signaling.
            self.identities[name] = (info['pid'], info['birth'])
            return info
        # Desktop may hand off to an already-running Electron instance.
        if name == 'desktop' and spec.get('match'):
            for directory in Path('/proc').glob('[0-9]*'):
                candidate = process(directory.name)
                if candidate and matches(candidate, expected) and not any(arg.startswith('--type=') for arg in candidate['args']):
                    self.identities[name] = (candidate['pid'], candidate['birth'])
                    return candidate
        self.identities.pop(name, None)
        return None

    def start_component(self, name):
        if self.stop.is_set():
            raise ControlError('operation_cancelled')
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if name == 'tunnel' and self.supports('host.wake'):
            self.host_state = self.provider.call('status')['host_state']
            if self.host_state in ('stopped', 'stopping'):
                raise ControlError('host_stopped')
        if 'command' not in spec:
            command = spec.get('start_command')
            if not command:
                raise ControlError('component_unmanaged')
            run_command(command, env=spec.get('env'), cancel=self.stop)
            self.states[name] = 'started'
            return
        if self._identity(name):
            self.states[name] = 'running'
            return
        port = spec.get('port')
        if port:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.3):
                    raise ControlError('unrecognized_port_owner')
            except OSError:
                pass
        if name == 'desktop' and not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
            raise ControlError('graphical_session_required')
        log = self.directory / (name + '.log')
        fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'ab') as output:
            if os.fstat(output.fileno()).st_mode & 0o077:
                raise ControlError('unsafe_log_file')
            env = plugin_environment(self.config['remote']) if name == 'tunnel' and 'remote' in self.config else environment(spec.get('env'))
            child = subprocess.Popen(spec['command'], stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                     start_new_session=True, cwd=spec.get('directory', self.root), env=env)
        self.children[name] = child
        info = process(child.pid)
        if info:
            self.identities[name] = (child.pid, info['birth'])
        pid_file = Path(spec['pid_file'])
        with tempfile.NamedTemporaryFile(mode='w', dir=pid_file.parent, delete=False) as file:
            temporary = Path(file.name)
            try:
                file.write(str(child.pid) + '\n')
                os.replace(temporary, pid_file)
            finally:
                temporary.unlink(missing_ok=True)
        self.states[name] = 'starting'

    def restart_component(self, name):
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if 'command' not in spec:
            if not spec.get('restart_command'):
                raise ControlError('component_unmanaged')
            run_command(spec['restart_command'], env=spec.get('env'), cancel=self.stop)
            self.states[name] = 'started'
            return
        self.stop_component(name)
        self.start_component(name)

    def stop_component(self, name):
        spec = self.config['components'].get(name, {})
        if 'command' not in spec:
            raise ControlError('component_unmanaged')
        info = self._identity(name)
        if info:
            pid, birth = info['pid'], info['birth']
            # A new PID incarnation must never receive this operation's signal.
            current = process(pid)
            if not current or current['birth'] != birth:
                raise ControlError('process_identity_changed')
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGTERM)
                else:
                    os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                current = process(pid)
                if not current or current['birth'] != birth:
                    break
                self.stop.wait(0.1)
            else:
                # A confirmed hung incarnation may be force-stopped after the
                # graceful window. Recheck birth so a recycled PID is untouched.
                current = process(pid)
                if current and current['birth'] == birth:
                    try:
                        if os.getpgid(pid) == pid:
                            os.killpg(pid, signal.SIGKILL)
                        else:
                            os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    force_deadline = time.monotonic() + 3
                    while time.monotonic() < force_deadline:
                        current = process(pid)
                        if not current or current['birth'] != birth:
                            break
                        self.stop.wait(0.1)
                    else:
                        raise ControlError('process_stop_timeout')
                elif current:
                    raise ControlError('process_identity_changed')
        child = self.children.get(name)
        if child is not None:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        self.identities.pop(name, None)
        self.states[name] = 'stopped'

    def probe(self):
        try:
            token = private_text(Path(self.config['relay_token_file']))
            expected = private_json(Path(self.config['relay_state_file']), 4096)
            if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
                return 'identity_unavailable'
            request = urllib.request.Request(self.config['relay_url'].rstrip('/') + '/v2/info',
                                             headers={'Authorization': 'Bearer ' + token})
            with self.opener.open(request, timeout=2) as response:
                info = json.loads(response.read(65537))
            if not isinstance(info, dict) or info.get('version') != 2:
                return 'protocol_mismatch'
            if info.get('state_id') != expected:
                return 'identity_mismatch'
            return 'connected' if info.get('forwarding') else 'forwarding_disabled'
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            return 'authentication_failed' if code in (401, 403) else 'unreachable' if code in (408, 429, 502, 503, 504) else 'protocol_mismatch'
        except urllib.error.URLError as error:
            if isinstance(error.reason, ssl.SSLCertVerificationError):
                return 'tls_verification_failed'
            return 'unreachable'
        except TimeoutError:
            return 'unreachable'
        except (OSError, ValueError, ControlError):
            return 'configuration_error'

    def internet_probe(self):
        """Check generic internet reachability without touching relay credentials.

        This runs only while the relay probe is unreachable, so a healthy local
        tunnel does not generate extra external traffic.
        """
        url = self.config.get('internet_check_url', DEFAULT_INTERNET_CHECK_URL)
        request = urllib.request.Request(url, method='HEAD')
        try:
            with self.opener.open(request, timeout=2) as response:
                response.read(1)
            return 'connected'
        except urllib.error.HTTPError as error:
            # Any HTTP response proves that an internet path exists.
            error.close()
            return 'connected'
        except urllib.error.URLError as error:
            # A certificate/interception failure is not "no internet"; it is a
            # separate TLS problem. DNS, routing, and connection failures are.
            return 'connected' if isinstance(error.reason, ssl.SSLCertVerificationError) else 'unreachable'
        except ssl.SSLError:
            return 'connected'
        except (TimeoutError, OSError):
            return 'unreachable'

    def update_internet(self, relay_state):
        if relay_state == 'unreachable':
            now = time.monotonic()
            if self.internet_state == 'unknown' or now >= self.internet_next:
                self.internet_state = self.internet_probe()
                self.internet_checked_at = stamp()
                self.internet_next = now + INTERNET_CHECK_INTERVAL
            return
        if relay_state == 'configuration_error':
            return
        # Authentication, TLS, identity, protocol, forwarding, and connected
        # results all required a live network path to the relay.
        self.internet_state = 'connected'
        self.internet_checked_at = stamp()
        self.internet_next = 0.0

    def wait_for_host(self, wanted, result):
        deadline = time.monotonic() + 120
        self.host_state = result['host_state']
        while self.host_state != wanted:
            if self.stop.wait(3):
                raise ControlError('operation_cancelled')
            if time.monotonic() >= deadline:
                raise ControlError('host_stop_timeout' if wanted == 'stopped' else 'host_unavailable')
            self.host_state = self.provider.call('status')['host_state']

    def stop_host(self):
        # Persist suppression before any tunnel/provider operation, including a
        # failed shutdown. Neither a retry nor a supervisor restart may wake it.
        self.update_settings({'auto_reconnect': False, 'auto_wake': False})
        if 'command' in self.config['components'].get('tunnel', {}):
            self.stop_component('tunnel')
        self.wait_for_host('stopped', self.provider.call('host.stop'))
        self.relay_state = 'unreachable'
        self.states['relay'] = 'stopped'
        self.recovery['last_error'] = 'host_stopped'

    def remote(self, wake=False, restart=False):
        if self.provider_blocked:
            raise ControlError(self.provider_blocked)
        self.prepare_provider()
        state = self.probe()
        if state not in ('connected', 'unreachable'):
            raise ControlError(state)
        expected = self.expected_identity()
        if wake and self.supports('host.wake'):
            self.recovery['phase'] = 'waking_remote_host'
            self.wait_for_host('running', self.provider.call('host.wake'))
        method = 'relay.restart' if restart else 'relay.ensure'
        if self.supports(method):
            self.recovery['phase'] = 'recovering_remote_relay'
            try:
                result = self.provider.call(method, {'expected_state_id': expected})
            except ControlError as error:
                if str(error) == 'host_stopped':
                    self.host_state = 'stopped'
                raise
            if result['state_id'] != expected:
                raise ControlError('identity_mismatch')
            self.states['relay'] = 'starting'
        else:
            self.host_state = self.provider.call('status')['host_state']
            if self.host_state == 'stopped':
                raise ControlError('host_stopped')

    def observe_relay(self):
        state = self.probe()
        self.relay_state = state
        self.update_internet(state)
        if state in PERMANENT:
            self.provider_blocked = state
        stopped = state == 'unreachable' and self.host_state == 'stopped'
        self.states['relay'] = 'running' if state == 'connected' else 'stopped' if stopped else 'unknown'
        if state == 'connected':
            self.recovery.update(last_connected_at=stamp(), last_error='', next_retry_at=None)
            self.failures, self.delay, self.next_attempt = 0, 2, 0
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
        if self.provider_blocked:
            raise ControlError(self.provider_blocked)
        self.prepare_provider()
        self.recovery['phase'] = 'recovering_connection'
        state = self.observe_relay()
        # Never repair authentication, TLS, integrity, or identity errors by
        # changing state, restarting a service, or weakening verification.
        if state not in ('connected', 'unreachable'):
            raise ControlError(state)
        if state == 'unreachable':
            # A vendor tunnel command must not accidentally resume stopped
            # compute before the supervisor has applied the wake policy.
            self.host_state = self.provider.call('status')['host_state']
            if self.host_state in ('stopped', 'stopping'):
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
        self.recovery['phase'] = 'monitoring'

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
        with self.lock:
            self.recovery.update(busy=True, phase=action + '_' + name, last_error='', next_retry_at=None)

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
                                self.states[component] = str(error)
                                local_error = error
                    self.recover(wake=self.settings['auto_wake'])
                    if local_error:
                        raise local_error
                elif name == 'all':
                    self.remote(wake=self.settings['auto_wake'], restart=True)
                    for component in ('tunnel', 'gateway', 'opencode', 'desktop', 'dashboard'):
                        spec = self.config['components'].get(component, {})
                        if spec.get('command') or spec.get('restart_command'):
                            self.restart_component(component)
                    if not self.wait_for_relay():
                        raise ControlError('unreachable')
                elif name == 'relay':
                    self.remote(wake=self.settings['auto_wake'], restart=action == 'restart')
                    if 'tunnel' in self.config['components']:
                        self.restart_component('tunnel')
                    if not self.wait_for_relay():
                        raise ControlError('unreachable')
                elif action == 'restart':
                    self.restart_component(name)
                else:
                    self.start_component(name)
            except ControlError as error:
                self.recovery['last_error'] = str(error)
                if str(error) in PERMANENT:
                    self.provider_blocked = str(error)
            except Exception as error:
                self.recovery['last_error'] = 'operation_failed'
                print(f'{stamp()} supervisor operation failed: {type(error).__name__}', file=sys.stderr, flush=True)
            finally:
                self.recovery.update(busy=False, phase='monitoring')
                self.next_attempt = time.monotonic() + self.delay
                self.operation.release()

        threading.Thread(target=work, daemon=True).start()

    def tick(self):
        if not self.operation.acquire(blocking=False):
            return
        try:
            for name, spec in self.config['components'].items():
                if 'command' in spec:
                    self.states[name] = 'running' if self._identity(name) else 'stopped'
                elif name == 'opencode' and self.config.get('opencode_service_file'):
                    try:
                        registered = private_json(Path(self.config['opencode_service_file']))
                        self.states[name] = 'running' if process(registered.get('pid', 0)) else 'stopped'
                    except (OSError, ValueError, ControlError):
                        self.states[name] = 'unknown'
                elif spec.get('status_command'):
                    try:
                        run_command(spec['status_command'], timeout=3, env=spec.get('env'), cancel=self.stop)
                        self.states[name] = 'running'
                    except ControlError:
                        self.states[name] = 'unknown'
            if self.dashboard_enabled and 'dashboard' in self.config['components'] and self.states['dashboard'] == 'stopped':
                self.start_component('dashboard')
            # Plugin failures must not prevent independent relay health checks or
            # local controls. Bound plugin retries separately from network retries.
            now = time.monotonic()
            if not self.provider_blocked and now >= self.provider_next:
                try:
                    self.prepare_provider()
                    if now >= self.host_status_next:
                        self.host_state = self.provider.call('status')['host_state']
                        self.host_status_next = time.monotonic() + 15
                    self.provider_error = ''
                    self.provider_delay = 2
                except ControlError as error:
                    self.provider_error = str(error)
                    if str(error) in PERMANENT:
                        self.provider_blocked = str(error)
                    self.provider_next = time.monotonic() + self.provider_delay
                    self.provider_delay = min(30, self.provider_delay * 2)
            previous = self.relay_state
            state = self.observe_relay()
            if self.provider_error or self.provider_blocked:
                self.recovery['last_error'] = self.provider_blocked or self.provider_error
                self.recovery['next_retry_at'] = None if self.provider_blocked else time.strftime(
                    '%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + max(0, self.provider_next - time.monotonic())))
                return
            if state == 'connected':
                self.recovery['phase'] = 'monitoring'
                if self.settings['auto_reconnect'] and 'gateway' in self.config['components'] and self.states['gateway'] == 'stopped':
                    self.start_component('gateway')
                return
            self.failures += 1
            # Preserve the last recovery failure during the same outage. A
            # generic probe must not erase why SSH/service recovery failed.
            if state != 'unreachable' or previous != state or not self.recovery['last_error']:
                self.recovery['last_error'] = state
            if state != 'unreachable' or not self.settings['auto_reconnect'] or self.provider_blocked:
                self.recovery['next_retry_at'] = None
                return
            now = time.monotonic()
            if self.failures < 3 or now < self.next_attempt:
                return
            self.recovery.update(busy=True, phase='recovering_connection', attempts=self.recovery['attempts'] + 1, next_retry_at=None)
            try:
                self.recover(wake=self.settings['auto_wake'])
            except ControlError as error:
                self.recovery['last_error'] = str(error)
                if str(error) in PERMANENT:
                    self.provider_blocked = str(error)
            if self.relay_state == 'connected':
                return
            self.next_attempt = time.monotonic() + self.delay
            self.recovery['next_retry_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + self.delay))
            self.delay = min(30, self.delay * 2)
        except ControlError as error:
            self.recovery['last_error'] = str(error)
            if str(error) in PERMANENT:
                self.provider_blocked = str(error)
        except Exception as error:
            self.recovery['last_error'] = 'operation_failed'
            # The private controller log gets only the exception type; never
            # command output, credentials, request bodies, or full paths.
            print(f'{stamp()} supervisor tick failed: {type(error).__name__}', file=sys.stderr, flush=True)
        finally:
            self.recovery.update(busy=False, phase='monitoring')
            self.operation.release()

    def monitor(self):
        while not self.stop.is_set():
            self.tick()
            self.stop.wait(5)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log bodies, credentials, commands, or private paths.

    def reply(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/status':
            self.reply(200, self.server.supervisor.snapshot())
        else:
            self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096 or self.headers.get('Content-Type') != 'application/json':
                raise ControlError('invalid_request')
            value = json.loads(self.rfile.read(length))
            if self.path == '/settings':
                self.server.supervisor.update_settings(value)
            elif self.path == '/action':
                self.server.supervisor.submit(value)
            else:
                self.reply(404, {'error': 'not_found'})
                return
            self.reply(202, {'accepted': True})
        except ControlError as error:
            self.reply(409, {'error': str(error)})
        except (OSError, ValueError):
            self.reply(400, {'error': 'invalid_request'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--no-dashboard', action='store_true')
    parser.add_argument('--no-desktop', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    supervisor = Supervisor(private_json(args.config))
    lock = os.open(supervisor.directory / 'supervisor.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    path = supervisor.directory / 'supervisor.sock'
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ControlError('unsafe_socket')
        path.unlink()  # The exclusive lock proves no existing controller owns it.
    with Server(str(path), Handler) as server:
        os.chmod(path, 0o600)
        server.supervisor = supervisor
        server.timeout = 0.5
        signal.signal(signal.SIGTERM, lambda *_: supervisor.stop.set())
        signal.signal(signal.SIGINT, lambda *_: supervisor.stop.set())
        supervisor.dashboard_enabled = not args.no_dashboard
        # The independent dashboard comes first, even with no remote network.
        for name in ('dashboard', 'gateway', 'opencode', 'desktop'):
            if name not in supervisor.config['components'] or name == 'dashboard' and args.no_dashboard or name in ('desktop', 'opencode') and args.no_desktop:
                continue
            try:
                supervisor.start_component(name)
                if name == 'dashboard':
                    current = supervisor._identity(name)
                    if current and '--control-socket' not in current['args']:
                        # Upgrade only the positively identified legacy read-only
                        # dashboard. Never replace the gateway or Desktop here.
                        supervisor.restart_component(name)
            except Exception:
                supervisor.states[name] = 'start_failed'
        worker = threading.Thread(target=supervisor.monitor, daemon=True)
        worker.start()
        while not supervisor.stop.is_set():
            server.handle_request()
        # Do not let Python tear down daemon threads while a provider process
        # group is still being cancelled. Managed long-lived services stay up.
        worker.join(timeout=15)
        if supervisor.operation.acquire(timeout=15):
            supervisor.operation.release()
    path.unlink(missing_ok=True)
    # Adopted services remain running when the controller itself stops.


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Supervisor failed; check the private configuration, permissions, and exclusive control lock.', file=sys.stderr)
        sys.exit(1)
