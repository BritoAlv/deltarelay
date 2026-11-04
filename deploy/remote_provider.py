"""Versioned, language-independent remote-host provider contract and process runner."""

import json
import os
from pathlib import Path
import re
import secrets
import selectors
import shlex
import signal
import stat
import subprocess
import time
import urllib.parse

from activity import MAX_LINE, STREAMS, TRACE_FD, OutputLines, inherited_trace


VERSION = 1
MAX_BYTES = 65536
REQUIRED = ('describe', 'connection', 'status')
CAPABILITIES = ('relay.ensure', 'relay.restart', 'host.wake', 'host.stop')
HOST_STATES = ('running', 'stopped', 'starting', 'stopping', 'unknown')
RETRYABLE = frozenset(('unreachable', 'command_timeout', 'command_failed', 'provider_timeout',
                       'provider_failed', 'host_unavailable', 'host_stop_timeout',
                       'relay_ssh_timeout', 'relay_recovery_failed'))
PERMANENT = frozenset(('authentication_failed', 'tls_verification_failed', 'protocol_mismatch',
                       'identity_mismatch', 'identity_unavailable', 'configuration_error',
                       'forwarding_disabled', 'invalid_provider_response', 'provider_version_mismatch',
                       'invalid_configuration', 'unsafe_private_file', 'invalid_request', 'unsupported_operation'))
ERROR_CODES = RETRYABLE | PERMANENT | frozenset(('unsupported_operation', 'host_stopped',
                                              'operation_cancelled', 'invalid_configuration',
                                              'unsafe_private_file', 'invalid_request'))


class ProviderError(Exception):
    """Only fixed, nonsecret error codes may cross the control API."""


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result

    def invalid(_):
        raise ValueError('nonfinite JSON number')

    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def private_json(path, limit=262144):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise ProviderError('unsafe_private_file')
        return strict_json(file.read(limit + 1))


def origin(value, https_only=False):
    try:
        if not isinstance(value, str) or any(ord(c) <= 32 or 127 <= ord(c) <= 159 for c in value):
            return False
        u = urllib.parse.urlsplit(value)
        if not u.hostname or '@' in u.netloc or u.query or u.fragment or u.path not in ('', '/') or u.netloc.endswith(':'):
            return False
        if u.port is not None and not 0 < u.port < 65536:
            return False
        return u.scheme == 'https' or (not https_only and u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1', '::1'))
    except (ValueError, TypeError, AttributeError):
        return False


def argv(value, absolute=False):
    return (isinstance(value, list) and 0 < len(value) <= 128 and
            all(isinstance(arg, str) and 0 < len(arg) <= 8192 and '\0' not in arg for arg in value) and
            (not absolute or Path(value[0]).is_absolute()))


def environment(overrides=None, allow_gh=False):
    keep = {'GH_TOKEN', 'GITHUB_TOKEN'} if allow_gh else set()
    result = {k: v for k, v in os.environ.items()
              if k in keep or (not k.startswith('OPENCODE_') and
                               not any(word in k.upper() for word in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY')))}
    result.update(overrides or {})
    return result


def plugin_environment(spec):
    # Credentials for arbitrary cloud vendors are opt-in, not inherited by name.
    names = {'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
             'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SYSTEMROOT'}
    result = {key: value for key, value in environment().items() if key in names or key.startswith(('LC_', 'XDG_'))}
    result.update(spec.get('env', {}))
    result.update({key: os.environ[key] for key in spec.get('pass_env', []) if key in os.environ})
    return result


def _terminate(child, group=True):
    # Kill the process group even if its leader exited leaving a child holding stdout.
    for sig, timeout in ((signal.SIGTERM, 0.2), (signal.SIGKILL, 2)):
        try:
            (os.killpg if group else os.kill)(child.pid, sig)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            continue
        if sig == signal.SIGKILL:
            break


def run_command(command, timeout=30, env=None, input=None, cancel=None, limit=262144, allow_gh=True,
                cleanup_group=False, new_session=True, exact_env=False, trace=None, trace_children=False):
    """Bound memory while reading stdout, and enforce a deadline on the entire group."""
    if cancel is not None and cancel.is_set():
        raise ProviderError('operation_cancelled')
    trace = trace or inherited_trace()
    execution = secrets.token_hex(4)

    def emit(stream, text, execution=execution):
        if trace is not None:
            try:
                trace(stream, text, execution)
            except Exception:
                pass  # Logging must not change service/provider semantics.

    started = time.monotonic()
    emit('command', f'$ {shlex.join(command)}\ncwd={os.getcwd()} timeout={timeout}s stdin_bytes={len(input or b"")} (stdin content not logged)')
    child_env = dict(env if exact_env else environment(env, allow_gh=allow_gh))
    child_env.pop(TRACE_FD, None)
    diagnostic_read = diagnostic_write = None
    if trace_children and trace is not None:
        diagnostic_read, diagnostic_write = os.pipe()
        child_env[TRACE_FD] = str(diagnostic_write)
    try:
        child = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=new_session, env=child_env,
                                 pass_fds=() if diagnostic_write is None else (diagnostic_write,))
    except OSError as error:
        if diagnostic_read is not None:
            os.close(diagnostic_read)
        emit('error', f'Could not execute: {type(error).__name__}: {error}')
        raise ProviderError('command_failed') from None
    finally:
        if diagnostic_write is not None:
            os.close(diagnostic_write)
    emit('event', f'pid={child.pid} started')
    output = bytearray()
    deadline = time.monotonic() + timeout
    pending = memoryview(input or b'')
    selector = selectors.DefaultSelector()
    completed = False
    outcome = 'command_failed'
    lines = {name: OutputLines(lambda text, name=name: emit(name, text)) for name in ('stdout', 'stderr')}
    diagnostic_buffer = bytearray()
    diagnostic_invalid = False

    def diagnostics(data):
        nonlocal diagnostic_buffer, diagnostic_invalid
        diagnostic_buffer.extend(data)
        while b'\n' in diagnostic_buffer:
            line, _, rest = diagnostic_buffer.partition(b'\n')
            diagnostic_buffer = bytearray(rest)
            try:
                value = strict_json(line)
                if (not isinstance(value, dict) or set(value) != {'stream', 'text', 'execution'} or
                        not isinstance(value['stream'], str) or value['stream'] not in STREAMS or
                        not isinstance(value['text'], str) or len(value['text']) > MAX_LINE or
                        not isinstance(value['execution'], str) or not re.fullmatch(r'[a-f0-9]{8}', value['execution'])):
                    raise ValueError('invalid diagnostic record')
                emit(value['stream'], value['text'], value['execution'])
            except (ValueError, TypeError, UnicodeError, RecursionError):
                if not diagnostic_invalid:
                    emit('error', 'Invalid provider diagnostic record omitted; stdout protocol is unchanged')
                    diagnostic_invalid = True
        if len(diagnostic_buffer) > 131072:
            diagnostic_buffer.clear()
            emit('error', 'Oversized provider diagnostic record omitted')

    try:
        for pipe, name in ((child.stdout, 'stdout'), (child.stderr, 'stderr')):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        if diagnostic_read is not None:
            os.set_blocking(diagnostic_read, False)
            selector.register(diagnostic_read, selectors.EVENT_READ, 'diagnostics')
        if child.stdin is not None:
            if pending:
                os.set_blocking(child.stdin.fileno(), False)
                selector.register(child.stdin, selectors.EVENT_WRITE, 'stdin')
            else:
                child.stdin.close()
        while selector.get_map() or child.poll() is None:
            if cancel is not None and cancel.is_set():
                raise ProviderError('operation_cancelled')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('command_timeout')
            for key, _ in selector.select(min(0.1, remaining)):
                if key.events == selectors.EVENT_WRITE:
                    try:
                        pending = pending[os.write(key.fd, pending[:65536]):]
                    except BrokenPipeError:
                        pending = pending[len(pending):]
                    if not pending:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                else:
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        if key.data in lines:
                            lines[key.data].feed(b'', final=True)
                        elif key.data == 'diagnostics' and diagnostic_buffer:
                            emit('error', 'Provider diagnostic channel closed with an incomplete record')
                    elif key.data == 'diagnostics':
                        diagnostics(data)
                    else:
                        lines[key.data].feed(data)
                        if key.data == 'stdout':
                            output.extend(data)
                            if len(output) > limit:
                                raise ProviderError('invalid_command_response')
        if child.wait() != 0:
            raise ProviderError('command_failed')
        completed = True
        outcome = 'completed'
        return bytes(output)
    except ProviderError as error:
        outcome = str(error)
        raise
    finally:
        selector.close()
        if not completed or cleanup_group:
            _terminate(child, group=new_session)
        # Preserve diagnostics written during signal handling/termination too.
        # Bounded draining must not wait for an escaped descendant holding a pipe.
        if not completed:
            pipes = [(child.stdout.fileno(), lines['stdout'].feed), (child.stderr.fileno(), lines['stderr'].feed)]
            if diagnostic_read is not None:
                pipes.append((diagnostic_read, diagnostics))
            for fd, consume in pipes:
                remaining = 262144
                while remaining:
                    try:
                        data = os.read(fd, min(65536, remaining))
                    except (BlockingIOError, OSError):
                        break
                    if not data:
                        break
                    consume(data)
                    remaining -= len(data)
                if not remaining:
                    emit('error', 'Termination output exceeded 256 KiB drain bound; remaining output omitted')
        for name in lines:
            lines[name].feed(b'', final=True)
        if diagnostic_read is not None:
            os.close(diagnostic_read)
        child.stdout.close()
        child.stderr.close()
        if child.stdin is not None and not child.stdin.closed:
            child.stdin.close()
        status = (f'exit_code={child.returncode}' if child.returncode is None or child.returncode >= 0
                  else f'signal={-child.returncode}')
        emit('exit', f'pid={child.pid} {status} elapsed={time.monotonic() - started:.3f}s outcome={outcome}')


def validate_spec(spec):
    if not isinstance(spec, dict) or set(spec) - {'command', 'config_file', 'env', 'pass_env', 'timeout_seconds'}:
        raise ProviderError('invalid_configuration')
    if not argv(spec.get('command'), absolute=True):
        raise ProviderError('invalid_configuration')
    path = spec.get('config_file')
    if not isinstance(path, str) or '\0' in path or not Path(path).is_absolute():
        raise ProviderError('invalid_configuration')
    overrides = spec.get('env', {})
    if not isinstance(overrides, dict) or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) or
                                            not isinstance(v, str) or '\0' in v for k, v in overrides.items()):
        raise ProviderError('invalid_configuration')
    names = spec.get('pass_env', [])
    if not isinstance(names, list) or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) for k in names):
        raise ProviderError('invalid_configuration')
    timeout = spec.get('timeout_seconds', 120)
    if type(timeout) is not int or not 1 <= timeout <= 300:
        raise ProviderError('invalid_configuration')


def validate_params(method, params):
    if method not in (*REQUIRED, *CAPABILITIES) or not isinstance(params, dict):
        raise ProviderError('invalid_request')
    expected = {'expected_state_id'} if method in ('relay.ensure', 'relay.restart') else set()
    if set(params) != expected or expected and (not isinstance(params['expected_state_id'], str) or
                                               not re.fullmatch(r'[0-9a-f]{64}', params['expected_state_id'])):
        raise ProviderError('invalid_request')


def validate_result(method, value):
    if not isinstance(value, dict):
        raise ProviderError('invalid_provider_response')
    if method == 'describe':
        if (set(value) != {'id', 'label', 'capabilities'} or
                not isinstance(value['id'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', value['id']) or
                not isinstance(value['label'], str) or not 0 < len(value['label']) <= 80 or
                any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value['label']) or
                not isinstance(value['capabilities'], list) or
                any(not isinstance(c, str) or c not in CAPABILITIES for c in value['capabilities']) or
                len(set(value['capabilities'])) != len(value['capabilities'])):
            raise ProviderError('invalid_provider_response')
    elif method == 'connection':
        if set(value) - {'relay_url', 'tunnel'} or not origin(value.get('relay_url')):
            raise ProviderError('invalid_provider_response')
        tunnel = value.get('tunnel')
        if tunnel is not None:
            url = urllib.parse.urlsplit(value['relay_url'])
            if (not isinstance(tunnel, dict) or set(tunnel) != {'command', 'port'} or
                    not argv(tunnel['command'], absolute=True) or type(tunnel['port']) is not int or
                    not 0 < tunnel['port'] < 65536 or tunnel['port'] != (url.port or (443 if url.scheme == 'https' else 80)) or
                    url.hostname not in ('127.0.0.1', 'localhost', '::1')):
                raise ProviderError('invalid_provider_response')
    elif method in ('status', 'host.wake', 'host.stop'):
        if set(value) != {'host_state'} or value['host_state'] not in HOST_STATES:
            raise ProviderError('invalid_provider_response')
    elif set(value) != {'state_id'} or not isinstance(value['state_id'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['state_id']):
        raise ProviderError('invalid_provider_response')
    return value


class ExecutableProvider:
    def __init__(self, spec, relay_url, cancel, trace=None):
        validate_spec(spec)
        self.spec, self.relay_url, self.cancel = spec, relay_url, cancel
        self.metadata = {'id': 'custom', 'label': 'Remote host', 'capabilities': []}
        self.connection = None
        self.trace = trace

    def call(self, method, params=None):
        params = {} if params is None else params
        validate_params(method, params)
        if method not in REQUIRED and method not in self.metadata['capabilities']:
            raise ProviderError('unsupported_operation')
        try:
            private_json(Path(self.spec['config_file']))
        except (OSError, ValueError, RecursionError):
            raise ProviderError('configuration_error') from None
        request = {'protocol_version': VERSION, 'id': secrets.token_hex(16), 'method': method,
                   'config_file': self.spec['config_file'], 'params': params}
        env = plugin_environment(self.spec)
        if self.trace:
            self.trace('event', f'Provider call: {method} request={request["id"]}')
        try:
            output = run_command(self.spec['command'], timeout=min(5, self.spec.get('timeout_seconds', 120)) if method in REQUIRED else self.spec.get('timeout_seconds', 120),
                                 env=env, input=json.dumps(request).encode(), cancel=self.cancel, limit=MAX_BYTES,
                                 allow_gh=False, cleanup_group=True, exact_env=True,
                                 trace=self.trace, trace_children=True)
        except ProviderError as error:
            raise ProviderError({'command_timeout': 'provider_timeout', 'command_failed': 'provider_failed',
                                 'invalid_command_response': 'invalid_provider_response'}.get(str(error), str(error))) from None
        try:
            response = strict_json(output)
            if not isinstance(response, dict) or response.get('protocol_version') != VERSION:
                raise ProviderError('provider_version_mismatch')
            if type(response['protocol_version']) is not int or response.get('id') != request['id'] or set(response) not in (
                    {'protocol_version', 'id', 'result'}, {'protocol_version', 'id', 'error'}):
                raise ProviderError('invalid_provider_response')
            if 'error' in response:
                error = response['error']
                if (not isinstance(error, dict) or set(error) != {'code', 'retryable'} or
                        not isinstance(error['code'], str) or error['code'] not in ERROR_CODES or
                        type(error['retryable']) is not bool or error['retryable'] != (error['code'] in RETRYABLE)):
                    raise ProviderError('invalid_provider_response')
                raise ProviderError(error['code'])
            return validate_result(method, response['result'])
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise ProviderError('invalid_provider_response') from None

    def prepare(self):
        if self.connection is None:
            metadata = self.call('describe')
            connection = self.call('connection')
            if connection['relay_url'].rstrip('/') != self.relay_url.rstrip('/'):
                raise ProviderError('configuration_error')
            self.metadata, self.connection = metadata, connection
        return self.connection
