"""One continuous local history with explicit remote-host attribution.

Each observation is written to a single shared statistics file and capture
directory. The gateway labels the active remote host, so switching profiles no
longer resets the dashboard while the UI can still filter by host. Existing
per-host files from the earlier layout are imported once and left as backups.
"""

import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

from remote_provider import ProviderError, private_json

from .state import save_json


STATS_NAME = 'dashboard-stats.json'
CAPTURES_NAME = 'captures'


def shared_paths(config):
    profile = Path(config['profile'])
    return profile / STATS_NAME, profile / CAPTURES_NAME


def _flag(command, name):
    prefix = name + '='
    for index, value in enumerate(command):
        if value == name and index + 1 < len(command):
            return index, command[index + 1], name
        if value.startswith(prefix):
            return index, value[len(prefix):], prefix
    return None, None, None


def _set_flag(command, name, value):
    index, _, style = _flag(command, name)
    if index is None:
        command.extend((name, value))
    elif style == name:
        command[index + 1] = value
    else:
        command[index] = style + value


def rewrite_gateway_history(config, host):
    """Return a deep copy whose gateway writes shared host-labelled history."""
    result = copy.deepcopy(config)
    gateway = result.get('components', {}).get('gateway')
    if not isinstance(gateway, dict) or not isinstance(gateway.get('command'), list):
        return result, False
    command = gateway['command']
    stats, captures = shared_paths(config)
    before = list(command)
    _set_flag(command, '--stats-file', str(stats))
    _set_flag(command, '--capture-dir', str(captures))
    _set_flag(command, '--history-host', host)
    return result, before != command


def _open_private_json(path, limit=None):
    return private_json(path, limit)


def _write_private_json(path, value, limit=None):
    if path.exists() or path.is_symlink():
        private_json(path, limit)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _empty_snapshot():
    return {
        'version': 1,
        'since': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'totals': {},
        'host_totals': {},
        'sessions': [],
        'recent_requests': [],
        'traffic': {
            'hourly': {'since': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'bucket_seconds': 3600, 'retention_seconds': 0, 'buckets': []},
            'daily': {'since': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'bucket_seconds': 86400, 'retention_seconds': 0, 'buckets': []},
        },
        'session_limit': 0,
        'request_limit': 0,
        'evicted_sessions': 0,
        'dropped_requests': 0,
        'persistent': True,
        'persistence_error': False,
    }


TOTAL_KEYS = ('requests', 'active', 'failed', 'cancelled', 'body_bytes', 'uploaded_chunk_bytes',
              'encoded_upload_bytes', 'reused_body_bytes', 'response_bytes', 'duration_ms')


def _totals(value):
    if not isinstance(value, dict):
        return {key: 0 for key in TOTAL_KEYS}
    result = {}
    for key in TOTAL_KEYS:
        item = value.get(key, 0)
        if type(item) is not int or item < 0:
            raise ProviderError('invalid_profile_history')
        result[key] = item
    return result


def _add_totals(target, value):
    value = _totals(value)
    for key in TOTAL_KEYS:
        target[key] = target.get(key, 0) + value[key]


def _parse_time(value):
    if not isinstance(value, str) or not value:
        raise ProviderError('invalid_profile_history')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ProviderError('invalid_profile_history') from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _time_text(value):
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def _session_key(session):
    return f"{session.get('host') or ''}\x00{session.get('id') or ''}"


def _max_sequence(snapshot):
    return max((request.get('sequence', 0) for request in snapshot.get('recent_requests', [])
                if type(request.get('sequence')) is int and request['sequence'] > 0), default=0)


def _merge_session(target, session):
    session = copy.deepcopy(session)
    session.update(_totals(session))
    key = _session_key(session)
    for index, current in enumerate(target['sessions']):
        if _session_key(current) != key:
            continue
        left, right = _parse_time(current['started_at']), _parse_time(session['started_at'])
        if left > right:
            current['started_at'] = session['started_at']
        left, right = _parse_time(current['updated_at']), _parse_time(session['updated_at'])
        if left < right:
            current['updated_at'] = session['updated_at']
            current['upstream'] = session.get('upstream', '')
            current['last_status'] = session.get('last_status', 0)
            current['last_error'] = session.get('last_error', '')
            current['last_request_id'] = session.get('last_request_id', '')
        clients = set(current.get('clients') or ()) | set(session.get('clients') or ())
        if clients:
            current['clients'] = sorted(clients)
        _add_totals(current, session)
        target['sessions'][index] = current
        return
    target['sessions'].append(session)


def _merge_bucket(target, bucket):
    bucket = copy.deepcopy(bucket)
    key = (_parse_time(bucket['start']), bucket.get('host') or '')
    for current in target:
        if (_parse_time(current['start']), current.get('host') or '') == key:
            for name in ('requests', 'failed', 'cancelled', 'body_bytes', 'uploaded_chunk_bytes',
                         'encoded_upload_bytes', 'reused_body_bytes', 'response_bytes', 'duration_ms'):
                current[name] = current.get(name, 0) + bucket.get(name, 0)
            return
    target.append(bucket)


def _merge_traffic(target, source, source_host):
    for name in ('hourly', 'daily'):
        target_series = target['traffic'][name]
        source_series = source['traffic'][name]
        try:
            if _parse_time(source_series['since']) < _parse_time(target_series['since']):
                target_series['since'] = source_series['since']
        except (KeyError, TypeError, ProviderError):
            pass
        for bucket in source_series.get('buckets', []):
            bucket = copy.deepcopy(bucket)
            bucket['host'] = bucket.get('host') or source_host
            _merge_bucket(target_series['buckets'], bucket)
        target_series['buckets'].sort(key=lambda item: (_parse_time(item['start']), item.get('host') or ''))


def merge_snapshot(target, source, source_host):
    """Merge one statistics snapshot into target and return its sequence offset."""
    if source.get('version') != 1 or not isinstance(source.get('sessions'), list) or not isinstance(source.get('recent_requests'), list):
        raise ProviderError('invalid_profile_history')
    source_host = source_host or source.get('host') or 'local'
    offset = _max_sequence(target)

    source_totals = _totals(source.get('totals'))
    _add_totals(target['totals'], source_totals)
    host_totals = source.get('host_totals') or {source_host: source_totals}
    if not isinstance(host_totals, dict):
        raise ProviderError('invalid_profile_history')
    for host, value in host_totals.items():
        if not isinstance(host, str) or not host:
            raise ProviderError('invalid_profile_history')
        current = target['host_totals'].setdefault(host, {key: 0 for key in TOTAL_KEYS})
        _add_totals(current, value)

    since = _parse_time(source['since'])
    if since < _parse_time(target['since']):
        target['since'] = _time_text(since)

    for session in source['sessions']:
        session = copy.deepcopy(session)
        session['host'] = session.get('host') or source_host
        _merge_session(target, session)

    for request in source['recent_requests']:
        request = copy.deepcopy(request)
        request['host'] = request.get('host') or source_host
        sequence = request.get('sequence')
        if type(sequence) is not int or sequence <= 0:
            raise ProviderError('invalid_profile_history')
        request['sequence'] = sequence + offset
        target['recent_requests'].append(request)

    _merge_traffic(target, source, source_host)
    target['evicted_sessions'] += source.get('evicted_sessions', 0)
    target['dropped_requests'] += source.get('dropped_requests', 0)
    target['recent_requests'].sort(key=lambda request: request.get('sequence', 0))
    return offset


def _update_capture_sequence(path, offset):
    if offset == 0:
        return
    value = _open_private_json(path)
    if not isinstance(value, dict):
        raise ProviderError('invalid_profile_history')
    sequence = value.get('sequence')
    if type(sequence) is not int or sequence <= 0:
        raise ProviderError('invalid_profile_history')
    value['sequence'] = sequence + offset
    _write_private_json(path, value)


def _merge_captures(source, target, offset):
    if not source.is_dir() or source.is_symlink():
        return 0
    target.mkdir(mode=0o700, exist_ok=True)
    os.chmod(target, 0o700)
    moved = 0
    for entry in sorted(source.iterdir(), key=lambda item: item.name):
        if entry.name == '.lock' or not entry.is_dir() or entry.is_symlink():
            continue
        destination = target / entry.name
        if destination.exists() or destination.is_symlink():
            continue
        try:
            os.rename(entry, destination)
        except OSError:
            shutil.copytree(entry, destination, symlinks=False)
            shutil.rmtree(entry)
        capture_file = destination / 'capture.json'
        if capture_file.is_file():
            _update_capture_sequence(capture_file, offset)
        moved += 1
    return moved


def _source_files(project, config, target):
    from .profiles import profiles_root, runtime_root
    sources = []
    root = profiles_root(project)
    if root.is_dir():
        for profile in sorted(root.iterdir(), key=lambda item: item.name):
            if not profile.is_dir() or profile.is_symlink():
                continue
            stats = profile / 'stats.json'
            if stats.is_file() and stats.resolve() != target.resolve():
                sources.append((profile.name, stats, profile / 'captures'))
    # Pre-profile layouts kept one shared file under the local runtime.
    for legacy in (Path(config['profile']) / '.runtime' / 'dashboard-stats.json',
                   runtime_root(project) / 'dashboard-stats.json',
                   runtime_root(project) / 'dashboard-stats.pre-profile.json'):
        if legacy.is_file() and legacy.resolve() != target.resolve():
            sources.append(('local', legacy, runtime_root(project) / 'dashboard-captures'))
    return sources


def _backup(path):
    if not path.exists() and not path.is_symlink():
        return
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    backup = path.with_name(path.name + f'.pre-shared-{stamp}')
    if not backup.exists():
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)


def ensure_shared_history(project, config, host, report=print):
    """Rewrite config to shared paths and import existing per-host history once.

    Call only while the local gateway is stopped. Source files are renamed after
    a successful import, so a later start cannot merge the same observations
    twice. The shared snapshot is written atomically.
    """
    stats, captures = shared_paths(config)
    stats.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(stats.parent, 0o700)
    target = _empty_snapshot()
    if stats.exists() or stats.is_symlink():
        target = _open_private_json(stats)
        if not isinstance(target, dict):
            raise ProviderError('invalid_profile_history')
        target.setdefault('host_totals', {})
        target.setdefault('sessions', [])
        target.setdefault('recent_requests', [])
        target.setdefault('traffic', _empty_snapshot()['traffic'])
        target.setdefault('totals', {key: 0 for key in TOTAL_KEYS})
    sources = _source_files(project, config, stats)
    if not sources:
        return False
    _backup(stats)
    for source_host, stats_file, capture_dir in sources:
        source = _open_private_json(stats_file)
        if not isinstance(source, dict):
            raise ProviderError('invalid_profile_history')
        offset = merge_snapshot(target, source, source_host)
        imported = _merge_captures(capture_dir, captures, offset)
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        archived = stats_file.with_name(stats_file.name + f'.merged-{stamp}')
        if not archived.exists():
            os.replace(stats_file, archived)
        report(f'Imported {source_host} history and {imported} capture(s)')
    target['session_limit'] = 0
    target['request_limit'] = 0
    target['traffic']['hourly']['retention_seconds'] = 0
    target['traffic']['daily']['retention_seconds'] = 0
    target['persistent'] = True
    target['persistence_error'] = False
    _write_private_json(stats, target)
    return True


def active_host(project, config):
    from .profiles import active_profile
    name = active_profile(project)
    return name if name else 'local'


def configure(project, config_file, config, report=print):
    """Apply shared history to a private supervisor config and import old data."""
    from .config import validate
    if not isinstance(config.get('components', {}).get('gateway'), dict):
        return config
    host = active_host(project, config)
    updated, changed = rewrite_gateway_history(config, host)
    if changed:
        _backup(Path(config_file))
        validate(updated)
        save_json(Path(config_file), updated)
        os.chmod(Path(config_file), 0o600)
        report(f'Gateway history now records host {host} in a shared local history')
    ensure_shared_history(project, updated, host, report=report)
    return updated
