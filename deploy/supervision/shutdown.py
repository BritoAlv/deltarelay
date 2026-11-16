"""Scriptable shutdown through the same single mutation lane as the dashboard."""

from pathlib import Path
import secrets
import time

from remote_provider import ProviderError, private_json

from .config import validate
from .control import control_request


def shutdown(config_file, *, remote_only=False, timeout=420, report=print):
    try:
        config = private_json(Path(config_file))
        validate(config)
    except (OSError, ValueError, ProviderError) as error:
        # No supervisor request was sent if private configuration is unusable.
        raise ProviderError('configuration_error') from error
    socket = Path(config['profile']) / 'control/supervisor.sock'
    status, snapshot = control_request(socket, 'GET', '/status')
    if status != 200 or not isinstance(snapshot, dict):
        # Starting a supervisor as a "fallback" could itself start recovery.
        raise ProviderError('supervisor_unavailable')
    remote = snapshot.get('remote') or {}
    if remote_only and 'host.stop' not in (remote.get('capabilities') or []):
        raise ProviderError('unsupported_operation')
    identifier = secrets.token_hex(16)
    target = 'remote' if remote_only else 'all'
    request = {'component': target, 'action': 'stop', 'confirmed': True, 'request_id': identifier}
    report('Requesting shutdown; automatic recovery and wake will remain off')
    status, result = control_request(socket, 'POST', '/action', request)
    if status not in (202, None):
        error = result.get('error') if isinstance(result, dict) else None
        raise ProviderError(error or 'operation_failed')
    if status is None:
        # The accepted response may have been lost. Retrying the SAME request ID
        # is deduplicated by the supervisor; it never sends a second independent
        # stop if the first was accepted.
        time.sleep(0.25)
        status, result = control_request(socket, 'POST', '/action', request)
        if status not in (202, None):
            error = result.get('error') if isinstance(result, dict) else None
            raise ProviderError(error or 'operation_failed')
    deadline = time.monotonic() + timeout
    while True:
        status, snapshot = control_request(socket, 'GET', '/status')
        if status == 200 and isinstance(snapshot, dict):
            topology = snapshot.get('topology') or {}
            run = topology.get('run') or {}
            remote = snapshot.get('remote') or {}
            capabilities = remote.get('capabilities') or []
            confirmed = remote.get('host_state') == 'stopped'
            if (run.get('request_id'), run.get('target'), run.get('action')) == (identifier, target, 'stop'):
                if run.get('status') in ('failed', 'interrupted'):
                    # A local stop error must not hide a provider-confirmed
                    # compute shutdown; the supervisor journal retains the local
                    # failure for Controls.
                    if 'host.stop' in capabilities and confirmed:
                        return snapshot
                    raise ProviderError(run.get('error') or 'operation_failed')
                if run.get('status') == 'completed':
                    if 'host.stop' in capabilities and not confirmed:
                        raise ProviderError('host_stop_timeout')
                    return snapshot
            # A later read-only observation may replace the run record, but a
            # successfully confirmed stop is still authoritative.
            settings = snapshot.get('settings') or {}
            system_stopped = (topology.get('intent') or {}).get('system') == 'stopped'
            if (not (snapshot.get('recovery') or {}).get('busy')
                    and settings == {'auto_reconnect': False, 'auto_wake': False}
                    and (confirmed or 'host.stop' not in capabilities)
                    and (system_stopped or remote_only)):
                return snapshot
        if time.monotonic() >= deadline:
            raise ProviderError('host_stop_timeout')
        time.sleep(0.25)
