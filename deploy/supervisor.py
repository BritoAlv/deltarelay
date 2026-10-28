#!/usr/bin/env python3
"""Private, single-user service supervisor. No inference, shell API, or public listener."""

import argparse
import fcntl
import http.server
import json
import os
from pathlib import Path
import re
import shlex
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
import urllib.parse
import urllib.request

from recover_relay import NoRedirect, private_text


COMPONENTS = ('dashboard', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop')
LABELS = dict(zip(COMPONENTS, ('Dashboard', 'Local gateway', 'VPS connection', 'Remote relay', 'OpenCode service', 'Isolated Desktop')))
DEFAULT_INTERNET_CHECK_URL = 'https://api.github.com/'
INTERNET_CHECK_INTERVAL = 15


class ControlError(Exception):
    """Only fixed, nonsecret error codes may cross the control API."""


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def private_json(path, limit=262144):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise ControlError('unsafe_private_file')
        return json.load(file)


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
    u = urllib.parse.urlsplit(value)
    if u.username or u.password or u.query or u.fragment or u.path not in ('', '/') or not u.netloc:
        return False
    if https and u.scheme == 'https':
        return True
    return u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1', '::1')


def internet_check_origin(value):
    u = urllib.parse.urlsplit(value)
    if u.username or u.password or u.query or u.fragment or u.path not in ('', '/') or not u.netloc:
        return False
    return u.scheme == 'https' or loopback_origin(value)


def environment(overrides=None, allow_gh=False):
    # Do not inherit this agent's server selectors or provider credentials.
    # `gh` commands may need an explicitly exported GitHub token; managed
    # services never inherit it. Tokens are never placed in argv or logs.
    keep_gh = {'GH_TOKEN', 'GITHUB_TOKEN'} if allow_gh else set()
    result = {k: v for k, v in os.environ.items()
              if k in keep_gh or (not k.startswith('OPENCODE_') and
                                  not any(word in k for word in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY')))}
    result.update(overrides or {})
    return result


def run_command(command, timeout=30, env=None, input=None):
    # All argv comes from a private, owner-controlled config, never the browser.
    child = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True, env=environment(env, allow_gh=True))
    try:
        output, _ = child.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
        raise ControlError('command_timeout') from None
    if child.returncode:
        raise ControlError('command_failed')
    if len(output) > 262144:
        raise ControlError('invalid_command_response')
    return output


def validate(config):
    if config.get('version') != 1 or not isinstance(config.get('components'), dict):
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
    codespace = config.get('codespace')
    if codespace and (not re.fullmatch(r'[a-zA-Z0-9-]+', codespace.get('name', '')) or
                      not isinstance(codespace.get('remote_directory'), str)):
        raise ControlError('invalid_codespace')


class Supervisor:
    def __init__(self, config):
        validate(config)
        self.config = config
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
        if config.get('codespace'):
            self.states['relay'] = 'unknown'
        self.recovery = {'busy': False, 'phase': 'starting', 'attempts': 0, 'last_error': '',
                         'last_connected_at': None, 'next_retry_at': None}
        self.relay_state = 'unknown'
        self.codespace_state = 'unknown' if config.get('codespace') else 'not_configured'
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
                builtin = name == 'relay' and bool(self.config.get('codespace'))
                components.append({'id': name, 'label': LABELS[name], 'state': self.states[name],
                                   'can_start': bool(spec.get('command') or spec.get('start_command') or builtin),
                                   'can_restart': bool(spec.get('command') or spec.get('restart_command') or builtin)})
            return {'version': 1, 'managed': True, 'collected_at': stamp(), 'settings': dict(self.settings),
                    'recovery': dict(self.recovery), 'relay_state': self.relay_state,
                    'internet_state': self.internet_state, 'internet_checked_at': self.internet_checked_at,
                    'codespace_state': self.codespace_state, 'components': components}

    def update_settings(self, value):
        if not isinstance(value, dict) or set(value) != set(self.settings) or any(type(v) is not bool for v in value.values()):
            raise ControlError('invalid_settings')
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
        spec = self.config['components'].get(name)
        if not spec:
            raise ControlError('component_unmanaged')
        if 'command' not in spec:
            command = spec.get('start_command')
            if not command:
                raise ControlError('component_unmanaged')
            run_command(command, env=spec.get('env'))
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
            child = subprocess.Popen(spec['command'], stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                     start_new_session=True, cwd=spec.get('directory', self.root), env=environment(spec.get('env')))
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
            run_command(spec['restart_command'], env=spec.get('env'))
            self.states[name] = 'started'
            return
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
        self.start_component(name)

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
        except (OSError, ValueError):
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

    def remote(self, wake=False, restart=False):
        codespace = self.config.get('codespace')
        if not codespace:
            if 'relay' in self.config['components']:
                if restart:
                    self.restart_component('relay')
                else:
                    self.start_component('relay')
            return
        name = codespace['name']

        def state_of():
            output = run_command(['gh', 'api', '--method', 'GET', '/user/codespaces/' + name,
                                  '--jq', '{state: .state}'])
            value = json.loads(output).get('state')
            if not isinstance(value, str):
                raise ControlError('codespace_unavailable')
            self.codespace_state = value
            return value

        state = state_of()
        if state == 'Shutdown' and not wake:
            raise ControlError('codespace_stopped')
        if state == 'Shutdown':
            self.recovery['phase'] = 'waking_codespace'
            run_command(['gh', 'api', '--method', 'POST', '/user/codespaces/' + name + '/start', '--silent'])
        deadline = time.monotonic() + 120
        while state != 'Available':
            if state not in ('Shutdown', 'Starting', 'Queued', 'Provisioning', 'ShuttingDown', 'Awaiting'):
                raise ControlError('codespace_unavailable')
            if self.stop.wait(3) or time.monotonic() >= deadline:
                raise ControlError('codespace_unavailable')
            state = state_of()
        self.recovery['phase'] = 'recovering_remote_relay'
        expected = private_json(Path(self.config['relay_state_file']), 4096)
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ControlError('identity_unavailable')
        arguments = ['python3', '-', '--root', codespace['remote_directory'], '--expected-state-id', expected]
        if restart:
            arguments.append('--restart')
        helper = Path(__file__).with_name('recover_relay.py').read_bytes()
        result = run_command(['gh', 'codespace', 'ssh', '-c', name, '--', '-o', 'BatchMode=yes',
                              '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                              shlex.join(arguments)], timeout=60, input=helper)
        if json.loads(result).get('state_id') != expected:
            raise ControlError('identity_mismatch')
        self.states['relay'] = 'running'

    def recover(self, wake=False):
        self.recovery['phase'] = 'recovering_connection'
        state = self.probe()
        # Never repair authentication, TLS, integrity, or identity errors by
        # changing state, restarting a service, or weakening verification.
        if state not in ('connected', 'unreachable'):
            raise ControlError(state)
        if state == 'unreachable':
            # Rebuild the local link first. A VPN failure is not evidence that
            # the remote daemon needs a restart.
            if 'tunnel' in self.config['components']:
                self.restart_component('tunnel')
                if not self.stop.wait(2) and self.probe() == 'connected':
                    return
            self.remote(wake=wake)
        if 'gateway' in self.config['components']:
            self.start_component('gateway')

    def submit(self, value):
        if not isinstance(value, dict) or set(value) - {'component', 'action', 'confirmed'}:
            raise ControlError('invalid_action')
        name, action = value.get('component'), value.get('action')
        if name not in (*COMPONENTS, 'all', 'codespace') or action not in ('start', 'restart', 'recover', 'wake'):
            raise ControlError('invalid_action')
        if action == 'restart' and value.get('confirmed') is not True:
            raise ControlError('confirmation_required')
        if action == 'wake' and (name != 'codespace' or not self.config.get('codespace')):
            raise ControlError('invalid_action')
        if name == 'codespace' and action != 'wake' or action == 'recover' and name != 'all':
            raise ControlError('invalid_action')
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
                if action == 'wake':
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
                elif name == 'relay' and self.config.get('codespace'):
                    self.remote(wake=self.settings['auto_wake'], restart=action == 'restart')
                elif action == 'restart':
                    self.restart_component(name)
                else:
                    self.start_component(name)
            except ControlError as error:
                self.recovery['last_error'] = str(error)
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
                        run_command(spec['status_command'], timeout=3, env=spec.get('env'))
                        self.states[name] = 'running'
                    except ControlError:
                        self.states[name] = 'unknown'
            if self.dashboard_enabled and 'dashboard' in self.config['components'] and self.states['dashboard'] == 'stopped':
                self.start_component('dashboard')
            state = self.probe()
            self.relay_state = state
            self.update_internet(state)
            if state == 'connected':
                self.states['relay'] = 'running'
                self.recovery.update(last_connected_at=stamp(), last_error='', phase='monitoring', next_retry_at=None)
                self.failures, self.delay, self.next_attempt = 0, 2, 0
                if self.settings['auto_reconnect'] and 'gateway' in self.config['components'] and self.states['gateway'] == 'stopped':
                    self.start_component('gateway')
                return
            self.states['relay'] = 'unknown'
            self.failures += 1
            self.recovery['last_error'] = state
            if state != 'unreachable' or not self.settings['auto_reconnect']:
                self.recovery['next_retry_at'] = None
                return
            now = time.monotonic()
            if self.failures < 3 or now < self.next_attempt:
                return
            self.recovery.update(busy=True, phase='recovering_connection', attempts=self.recovery['attempts'] + 1)
            try:
                self.recover(wake=self.settings['auto_wake'])
            except ControlError as error:
                self.recovery['last_error'] = str(error)
            self.next_attempt = time.monotonic() + self.delay
            self.recovery['next_retry_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + self.delay))
            self.delay = min(30, self.delay * 2)
        except Exception as error:
            self.recovery['last_error'] = 'operation_failed'
            # The private controller log gets only the exception type; never
            # command output, credentials, request bodies, or full paths.
            print(f'{stamp()} supervisor tick failed: {type(error).__name__}', file=sys.stderr, flush=True)
        finally:
            self.recovery['busy'] = False
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
    path.unlink(missing_ok=True)
    # Adopted services remain running when the controller itself stops.


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Supervisor failed; check the private configuration, permissions, and exclusive control lock.', file=sys.stderr)
        sys.exit(1)
