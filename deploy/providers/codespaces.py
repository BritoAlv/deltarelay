#!/usr/bin/env python3
"""Manage an existing Codespace and relay deployment; never provision or reset it."""

import json
from pathlib import Path
import re
import shlex
import shutil
import sys
import threading
import time
import urllib.parse

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_provider import ProviderError, origin
from providers.common import main, provider_command


STATES = {'Available': 'running', 'Shutdown': 'stopped', 'ShuttingDown': 'stopping',
          'Starting': 'starting', 'Queued': 'starting', 'Provisioning': 'starting', 'Awaiting': 'starting'}


class CodespacesProvider:
    def __init__(self, config, run=provider_command, stop=None):
        if (not isinstance(config, dict) or not isinstance(config.get('name'), str) or
                not re.fullmatch(r'[a-zA-Z0-9-]+', config['name']) or
                not isinstance(config.get('remote_directory'), str) or not config['remote_directory'] or
                '\0' in config['remote_directory'] or not origin(config.get('relay_url'))):
            raise ProviderError('invalid_configuration')
        github_cli = config.get('github_cli', shutil.which('gh') or '/usr/bin/gh')
        if not isinstance(github_cli, str) or '\0' in github_cli or not Path(github_cli).is_absolute():
            raise ProviderError('invalid_configuration')
        remote_port = config.get('remote_port', 18787)
        if type(remote_port) is not int or not 0 < remote_port < 65536:
            raise ProviderError('invalid_configuration')
        self.config, self.run, self.stop = config, run, stop or threading.Event()
        self.cli, self.remote_port = github_cli, remote_port
        self.endpoint = '/user/codespaces/' + config['name']

    def status(self):
        try:
            state = json.loads(self.run([self.cli, 'api', '--method', 'GET', self.endpoint, '--jq', '{state: .state}'])).get('state')
        except (ValueError, AttributeError):
            raise ProviderError('host_unavailable') from None
        if not isinstance(state, str) or state not in STATES:
            raise ProviderError('host_unavailable')
        return STATES[state]

    def wait(self, wanted, timeout=120):
        deadline = time.monotonic() + timeout
        while True:
            if self.stop.wait(3):
                raise ProviderError('operation_cancelled')
            if time.monotonic() >= deadline:
                raise ProviderError('host_stop_timeout' if wanted == 'stopped' else 'host_unavailable')
            state = self.status()
            if state == wanted:
                return {'host_state': state}

    def call(self, method, params=None):
        params = params or {}
        if method == 'describe':
            return {'id': 'codespaces', 'label': 'GitHub Codespaces',
                    'capabilities': ['relay.ensure', 'relay.restart', 'host.wake', 'host.stop']}
        if method == 'connection':
            url = urllib.parse.urlsplit(self.config['relay_url'])
            if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port is None:
                raise ProviderError('invalid_configuration')
            return {'relay_url': self.config['relay_url'], 'tunnel': {
                'command': [self.cli, 'codespace', 'ports', 'forward', f'{self.remote_port}:{url.port}', '-c', self.config['name']],
                'port': url.port}}
        if method == 'status':
            return {'host_state': self.status()}
        if method in ('host.wake', 'host.stop'):
            state = self.status()
            wanted = 'running' if method == 'host.wake' else 'stopped'
            if state == wanted:
                return {'host_state': state}
            if method == 'host.wake' and state == 'stopped':
                self.run([self.cli, 'api', '--method', 'POST', self.endpoint + '/start', '--silent'])
            elif method == 'host.stop' and state != 'stopping':
                self.run([self.cli, 'api', '--method', 'POST', self.endpoint + '/stop', '--silent'])
            return self.wait(wanted)
        if method in ('relay.ensure', 'relay.restart'):
            state = self.status()
            if state == 'stopped':
                raise ProviderError('host_stopped')
            if state != 'running':
                self.wait('running')
            expected = params['expected_state_id']
            arguments = ['python3', '-', '--root', self.config['remote_directory'], '--expected-state-id', expected,
                         '--port', str(self.remote_port)]
            if method == 'relay.restart':
                arguments.append('--restart')
            helper = Path(__file__).resolve().parents[1] / 'recover_relay.py'
            try:
                result = self.run([self.cli, 'codespace', 'ssh', '-c', self.config['name'], '--', '-o', 'BatchMode=yes',
                                   '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                                   shlex.join(arguments)], timeout=60, input=helper.read_bytes())
            except ProviderError as error:
                raise ProviderError({'command_timeout': 'relay_ssh_timeout', 'command_failed': 'relay_recovery_failed'}.get(str(error), str(error))) from None
            try:
                if json.loads(result).get('state_id') != expected:
                    raise ProviderError('identity_mismatch')
            except (ValueError, AttributeError):
                raise ProviderError('invalid_provider_response') from None
            return {'state_id': expected}
        raise ProviderError('unsupported_operation')


if __name__ == '__main__':
    main(CodespacesProvider)
