"""Private per-host profiles and the active-profile pointer.

Each remote host gets a private directory under ``.runtime/codespaces``.  The
active profile is selected by the ``.runtime/current`` symlink, so switching
hosts changes one pointer instead of rewriting the supervisor configuration.
"""

import os
from pathlib import Path
import re
import signal
import stat
import time

from remote_provider import ProviderError, private_json

from .process import matches, process


NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
SKIP_STOP = frozenset(('component_unmanaged', 'invalid_action', 'shutdown_not_configured',
                       'system_stopped', 'unsupported_operation'))


def runtime_root(project):
    return Path(project) / '.runtime'


def profiles_root(project):
    return runtime_root(project) / 'codespaces'


def current_link(project):
    return runtime_root(project) / 'current'


def valid_name(name):
    return isinstance(name, str) and NAME.fullmatch(name) is not None


def private_text(path, limit=4096):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as file:
        info = os.fstat(file.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                info.st_mode & 0o077 or info.st_size > limit):
            raise ProviderError('unsafe_private_file')
        value = file.read(limit + 1).strip()
        if not value:
            raise ProviderError('unsafe_private_file')
        return value


def private_directory(path):
    try:
        info = path.lstat()
    except OSError:
        raise ProviderError('profile_not_found') from None
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise ProviderError('unsafe_profile_directory')


def resolve_profile(project, name):
    """Validate one profile and return its private paths and identity."""
    if not valid_name(name):
        raise ProviderError('invalid_profile_name')
    path = profiles_root(project) / name
    private_directory(path)
    try:
        provider = private_json(path / 'provider.json')
    except ProviderError:
        raise
    except (OSError, ValueError):
        raise ProviderError('invalid_profile') from None
    if not isinstance(provider, dict) or not isinstance(provider.get('name'), str) or not provider['name']:
        raise ProviderError('invalid_profile')
    try:
        token = private_text(path / 'relay.token')
    except OSError:
        raise ProviderError('invalid_profile') from None
    if len(token) > 4096 or any(character.isspace() for character in token):
        raise ProviderError('invalid_profile')
    private_directory(path / 'state')
    try:
        identity = private_json(path / 'state/relay-state.json', 4096)
    except ProviderError:
        raise
    except (OSError, ValueError):
        raise ProviderError('invalid_profile') from None
    if not isinstance(identity, str) or not re.fullmatch(r'[0-9a-f]{64}', identity):
        raise ProviderError('invalid_profile')
    return {'name': name, 'path': path, 'provider': provider, 'state_id': identity}


def list_profiles(project):
    root = profiles_root(project)
    if not root.is_dir():
        return []
    result = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        if not valid_name(entry.name):
            continue
        try:
            resolve_profile(project, entry.name)
        except ProviderError:
            continue
        result.append(entry.name)
    return result


def active_profile(project):
    try:
        target = os.readlink(current_link(project))
    except OSError:
        return None
    parts = Path(target).parts
    if len(parts) == 2 and parts[0] == 'codespaces' and valid_name(parts[1]):
        return parts[1]
    return None


def point_current(project, name):
    """Atomically point ``.runtime/current`` at one validated profile."""
    resolve_profile(project, name)
    root = runtime_root(project)
    link = current_link(project)
    if (link.exists() or link.is_symlink()) and not link.is_symlink():
        raise ProviderError('unsafe_current_pointer')
    temporary = root / f'.current.{os.getpid()}.{time.time_ns()}'
    try:
        os.symlink(str(Path('codespaces') / name), temporary, target_is_directory=True)
        os.replace(temporary, link)
    finally:
        if temporary.is_symlink() or temporary.exists():
            temporary.unlink(missing_ok=True)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return link


def find_supervisor(config_path):
    target = str(Path(config_path).resolve())
    for entry in Path('/proc').glob('[0-9]*'):
        info = process(entry.name)
        if info and target in info['args'] and any(arg.endswith('supervisor.py') for arg in info['args']):
            return info
    return None


def _control(socket_path, method, endpoint, body=None):
    from .control import control_request
    return control_request(socket_path, method, endpoint, body)


def _action(socket_path, component, action, *, confirmed=False, timeout=30):
    body = {'component': component, 'action': action}
    if confirmed:
        body['confirmed'] = True
    deadline = time.monotonic() + timeout
    while True:
        status, value = _control(socket_path, 'POST', '/action', body)
        if status == 202:
            return
        if status == 409 and isinstance(value, dict) and value.get('error') == 'operation_in_progress':
            pass
        elif status is None:
            pass
        else:
            error = value.get('error') if isinstance(value, dict) else None
            raise ProviderError(error if isinstance(error, str) and error else 'control_failed')
        if time.monotonic() >= deadline:
            raise ProviderError('operation_in_progress' if status == 409 else 'supervisor_unavailable')
        time.sleep(0.5)


def _component_states(snapshot):
    if not isinstance(snapshot, dict):
        return {}
    return {item.get('id'): item.get('state') for item in snapshot.get('components', [])
            if isinstance(item, dict)}


def _wait_components_stopped(socket_path, names, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        status, snapshot = _control(socket_path, 'GET', '/status')
        if status != 200:
            return
        states = _component_states(snapshot)
        if all(states.get(name) in ('stopped', 'unknown', 'unmanaged') for name in names):
            return
        if time.monotonic() >= deadline:
            return
        time.sleep(0.25)


def _terminate(info, timeout=20):
    pid, birth = info['pid'], info['birth']
    current = process(pid)
    if not current or current['birth'] != birth:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = process(pid)
        if not current or current['birth'] != birth:
            return
        time.sleep(0.25)
    current = process(pid)
    if current and current['birth'] == birth:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _stop_pid_file(path, expected=None, timeout=8):
    try:
        pid = int(Path(path).read_text().strip())
    except (OSError, ValueError):
        return False
    info = process(pid)
    if not info or expected and not matches(info, list(expected)):
        return False
    birth = info['birth']
    current = process(pid)
    if not current or current['birth'] != birth:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = process(pid)
        if not current or current['birth'] != birth:
            return True
        time.sleep(0.25)
    current = process(pid)
    if current and current['birth'] == birth:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return True


def _stop_gateway(config, report):
    spec = config.get('components', {}).get('gateway', {})
    if not spec.get('pid_file'):
        return
    expected = spec.get('match') or spec.get('command')
    if _stop_pid_file(spec['pid_file'], expected):
        report('Stopped local gateway')


def _stop_tunnel(config, report):
    path = Path(config['profile']) / 'control/provider-tunnel.pid'
    if _stop_pid_file(path, ('codespace', 'ports', 'forward')):
        report('Stopped local remote connection')


def stop_local(config, config_path, report=print):
    """Stop the supervisor and its relay-local children, never the remote host."""
    socket_path = Path(config['profile']) / 'control/supervisor.sock'
    status, _ = _control(socket_path, 'GET', '/status')
    supervisor = find_supervisor(config_path)
    if status == 200:
        for name in ('tunnel', 'gateway'):
            try:
                _action(socket_path, name, 'stop', confirmed=True)
            except ProviderError as error:
                if str(error) not in SKIP_STOP:
                    raise
        _wait_components_stopped(socket_path, ('tunnel', 'gateway'))
    if supervisor:
        _terminate(supervisor)
        report('Stopped local supervisor')
    _stop_gateway(config, report)
    _stop_tunnel(config, report)


def _wait_connected(socket_path, timeout=300):
    deadline = time.monotonic() + timeout
    last = None
    while True:
        status, snapshot = _control(socket_path, 'GET', '/status')
        if status == 200 and isinstance(snapshot, dict):
            last = snapshot
            states = _component_states(snapshot)
            recovery = snapshot.get('recovery', {})
            if (not recovery.get('busy') and snapshot.get('relay_state') == 'connected' and
                    states.get('gateway') == 'running'):
                return snapshot
        if time.monotonic() >= deadline:
            error = last.get('recovery', {}).get('last_error') if isinstance(last, dict) else ''
            raise ProviderError(error if isinstance(error, str) and error else 'connection_not_ready')
        time.sleep(1)


def start_local(project, config_path, config, report=print):
    """Start the supervisor and make the active profile reachable."""
    from .launcher import start as launch
    launch(project, Path(config_path), no_dashboard=False, no_desktop=False, report=report)
    socket_path = Path(config['profile']) / 'control/supervisor.sock'
    _action(socket_path, 'all', 'start', confirmed=True)
    snapshot = _wait_connected(socket_path)
    try:
        # `all/start` starts the transport but does not flip its per-component
        # intent. Keep later automatic recovery enabled for this profile.
        _action(socket_path, 'tunnel', 'start')
    except ProviderError as error:
        if str(error) not in SKIP_STOP:
            raise
    return snapshot


def switch_codespace(project, name, config_path, *, restart=True, report=print):
    """Select one profile, optionally restarting local services on it."""
    info = resolve_profile(project, name)
    config_path = Path(config_path)
    try:
        config = private_json(config_path)
        from .config import validate
        validate(config)
    except ProviderError:
        raise
    except (OSError, ValueError):
        raise ProviderError('configuration_error') from None
    current = current_link(project)
    if (Path(config.get('remote', {}).get('config_file', '')) != current / 'provider.json' or
            Path(config.get('relay_token_file', '')) != current / 'relay.token' or
            Path(config.get('relay_state_file', '')) != current / 'state/relay-state.json'):
        raise ProviderError('profiles_not_configured')
    report(f'Selecting profile {name}')
    if restart:
        report('Profile switching stops local services only; the previous remote host is not stopped.')
        stop_local(config, config_path, report)
    point_current(project, name)
    report(f'Active profile is now {name}')
    if restart:
        report('Starting the local supervisor')
        start_local(project, config_path, config, report)
    return info
