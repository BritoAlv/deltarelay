"""Offline build and launcher composition for the supervision runtime."""

import os
from pathlib import Path
import subprocess
import sys
import time

from remote_provider import ProviderError as ControlError, environment, private_json
from .build import prepare_build

from .config import validate
from .control import control_request, controller_status


def start(project, config_file, no_dashboard=False, no_desktop=False):
    config_file = config_file.resolve(strict=True)
    config = private_json(config_file)
    validate(config)
    profile = Path(config['profile'])
    directory = profile / 'control'
    directory.mkdir(mode=0o700, exist_ok=True)
    status = controller_status(directory / 'supervisor.sock')
    if status:
        print('Supervisor already running. Reusing its settings and live services.')
        if not no_dashboard:
            # Make a repeated startup useful after an earlier --no-dashboard or a
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
        if 'remote' not in config:
            print(f'Set up your remote host: http://127.0.0.1:{dashboard["port"]}/controls')
    print('Remote-host controls depend on provider capabilities. Automatic wake is off by default.')
    return config
