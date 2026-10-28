#!/usr/bin/env python3
"""Build offline and start/reuse the independent local controller and dashboard."""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

from start_dashboard import prepare_build
from supervisor import ControlError, environment, private_json, save_json, validate


def codespace_config(project, profile, port):
    """Adapt only the already-configured private profile; never provision credentials."""
    wrapper = profile / 'tunnel-supervisor.sh'
    match = re.search(r'^CODESPACE=([a-zA-Z0-9-]+)$', wrapper.read_text(), re.M)
    if not match:
        raise ControlError('missing_existing_codespace')
    name = match.group(1)
    binary = str(project / 'bin/deltarelay')
    state = profile / 'state'
    config = {
        'version': 1, 'profile': str(profile),
        'relay_url': 'http://127.0.0.1:18787', 'gateway_url': 'http://127.0.0.1:18788',
        'relay_token_file': str(profile / 'relay.token'), 'local_token_file': str(profile / 'local.token'),
        'relay_state_file': str(state / 'relay-state.json'),
        'opencode_service_file': str(profile / 'profile/state/opencode/service.json'),
        'codespace': {'name': name, 'remote_directory': '~/.local/share/deltarelay/codespace-test'},
        'components': {
            'dashboard': {'command': [binary, 'dashboard', '--listen', f'127.0.0.1:{port}',
                                      '--gateway', 'http://127.0.0.1:18788', '--local-token-file', str(profile / 'local.token'),
                                      '--assets', str(project / 'web/dist'), '--control-socket', str(profile / 'control/supervisor.sock'),
                                      '--opencode-service-file', str(profile / 'profile/state/opencode/service.json')],
                          'adopt_match': [binary, 'dashboard', '--listen', f'127.0.0.1:{port}',
                                          '--local-token-file', str(profile / 'local.token')],
                          'pid_file': str(profile / 'dashboard.pid'), 'port': port},
            'gateway': {'command': [binary, 'gateway', '--listen', '127.0.0.1:18788', '--server', 'http://127.0.0.1:18787',
                                   '--token-file', str(profile / 'relay.token'), '--local-token-file', str(profile / 'local.token'),
                                   '--upstreams', str(profile / 'upstreams.json'), '--state-dir', str(state),
                                   '--stats-file', str(profile / '.runtime/dashboard-stats.json')],
                        # Adopt the deployed gateway without replacing its binary or interrupting its work.
                        'adopt_match': [str(profile / 'deltarelay-linux-amd64'), 'gateway', '--listen', '127.0.0.1:18788'],
                        'pid_file': str(profile / 'gateway.pid'), 'port': 18788},
            'tunnel': {'command': ['gh', 'codespace', 'ports', 'forward', '18787:18787', '-c', name],
                       'adopt_match': [str(wrapper)], 'pid_file': str(profile / 'tunnel.pid'), 'port': 18787},
        },
    }
    opencode = profile / 'profile-opencode.sh'
    if opencode.is_file():
        config['components']['opencode'] = {'start_command': [str(opencode), 'service', 'start'],
                                            'restart_command': [str(opencode), 'service', 'restart']}
    desktop = profile / 'launch-desktop.sh'
    if desktop.is_file():
        config['components']['desktop'] = {'command': [str(desktop)],
                                           'match': ['/opt/OpenCode/ai.opencode', '--user-data-dir=' + str(profile / 'desktop-profile')],
                                           'pid_file': str(profile / 'desktop.pid')}
    validate(config)
    return config


def control_request(path, method, endpoint, body=None):
    connection = http.client.HTTPConnection('localhost', timeout=2)
    try:
        connection.sock = socket.socket(socket.AF_UNIX)
        connection.sock.settimeout(2)
        connection.sock.connect(str(path))
        data = json.dumps(body) if body is not None else None
        headers = {'Content-Type': 'application/json'} if data is not None else {}
        connection.request(method, endpoint, data, headers)
        response = connection.getresponse()
        value = json.loads(response.read(65537))
        return response.status, value
    except (OSError, ValueError, http.client.HTTPException):
        return None, None
    finally:
        connection.close()


def controller_status(path):
    status, value = control_request(path, 'GET', '/status')
    return value if status == 200 and isinstance(value, dict) and value.get('version') == 1 else None


def start(project, profile=None, config_file=None, port=8790, no_dashboard=False, no_desktop=False):
    if config_file:
        config_file = config_file.resolve(strict=True)
        config = private_json(config_file)
        validate(config)
        profile = Path(config['profile'])
    else:
        profile = profile.resolve(strict=True)
        config_file = profile / 'supervisor.local.json'
        if config_file.exists() or config_file.is_symlink():
            config = private_json(config_file)
            validate(config)
        else:
            config = codespace_config(project, profile, port)
            save_json(config_file, config)
    directory = profile / 'control'
    directory.mkdir(mode=0o700, exist_ok=True)
    status = controller_status(directory / 'supervisor.sock')
    if status:
        print('Supervisor already running. Reusing its settings and live services.')
        if not no_dashboard:
            # Make a repeated startup useful after an earlier --no-dashboard or
            # stopped dashboard, without stopping anything that is already live.
            for component in ('dashboard',) + (() if no_desktop else ('opencode', 'desktop')):
                control_request(directory / 'supervisor.sock', 'POST', '/action',
                                {'component': component, 'action': 'start'})
    else:
        # No network recovery precedes these offline builds or dashboard startup.
        prepare_build(project)
        command = [sys.executable, '-B', str(project / 'deploy/supervisor.py'), '--config', str(config_file)]
        if no_dashboard:
            command.append('--no-dashboard')
        if no_desktop:
            command.append('--no-desktop')
        fd = os.open(directory / 'supervisor.log', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'ab') as log:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     start_new_session=True, cwd=project, env=environment(allow_gh=True))
        deadline = time.monotonic() + 40
        while not controller_status(directory / 'supervisor.sock'):
            if child.poll() is not None or time.monotonic() >= deadline:
                raise ControlError('supervisor_start_failed')
            time.sleep(0.1)
        print('Supervisor started. Network recovery continues in the background.')
    dashboard = config['components'].get('dashboard', {})
    if dashboard.get('port'):
        print(f'Dashboard: http://127.0.0.1:{dashboard["port"]}')
    print('Automatic Codespace wake is controlled in the dashboard; manual Wake is always available.')
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--config', type=Path, help='private configuration for an existing SSH/HTTPS VPS or Codespace')
    parser.add_argument('--port', type=int, default=8790)
    parser.add_argument('--no-desktop', action='store_true')
    parser.add_argument('--no-dashboard', action='store_true')
    args = parser.parse_args()
    if not 0 < args.port < 65536 or not (args.profile or args.config):
        parser.error('provide --profile or --config and a valid port')
    os.umask(0o077)
    try:
        start(args.project.resolve(strict=True), args.profile, args.config, args.port, args.no_dashboard, args.no_desktop)
    except Exception:
        print('Startup failed. Check private profile/configuration, offline build tools, and control/supervisor.log. '
              'No existing services were stopped.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
