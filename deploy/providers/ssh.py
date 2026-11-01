#!/usr/bin/env python3
"""Reach an existing SSH host and optionally manage its existing relay service."""

import json
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import sys
import urllib.parse

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_provider import ProviderError, argv, origin
from providers.common import main, provider_command


class SSHProvider:
    def __init__(self, config, run=provider_command):
        if (not isinstance(config, dict) or not isinstance(config.get('host'), str) or
                not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*', config['host']) or
                not origin(config.get('relay_url'))):
            raise ProviderError('invalid_configuration')
        binary = config.get('ssh', shutil.which('ssh') or '/usr/bin/ssh')
        options = config.get('ssh_options', [])
        remote_port = config.get('remote_port', 8787)
        if (not isinstance(binary, str) or '\0' in binary or not Path(binary).is_absolute() or
                not isinstance(options, list) or options and not argv(options) or
                type(remote_port) is not int or not 0 < remote_port < 65536):
            raise ProviderError('invalid_configuration')
        self.commands = {}
        for method, key in (('relay.ensure', 'start_command'), ('relay.restart', 'restart_command')):
            if key in config:
                if not argv(config[key]):
                    raise ProviderError('invalid_configuration')
                self.commands[method] = config[key]
        if self.commands and (not isinstance(config.get('relay_state_file'), str) or
                              '\0' in config['relay_state_file'] or not PurePosixPath(config['relay_state_file']).is_absolute()):
            raise ProviderError('invalid_configuration')
        # These precede user options: OpenSSH uses the first value for an option.
        self.ssh = [binary, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', *options]
        self.config, self.run, self.remote_port = config, run, remote_port

    def call(self, method, params=None):
        if method == 'describe':
            return {'id': 'ssh', 'label': 'SSH remote host', 'capabilities': list(self.commands)}
        if method == 'connection':
            url = urllib.parse.urlsplit(self.config['relay_url'])
            if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port is None:
                raise ProviderError('invalid_configuration')
            return {'relay_url': self.config['relay_url'], 'tunnel': {
                'command': [*self.ssh, '-NT', '-o', 'ExitOnForwardFailure=yes', '-L',
                            f'127.0.0.1:{url.port}:127.0.0.1:{self.remote_port}', self.config['host']], 'port': url.port}}
        if method == 'status':
            # SSH connectivity is not proof of power state. Core probes relay health.
            return {'host_state': 'unknown'}
        if method in self.commands:
            expected = params['expected_state_id']
            path = shlex.quote(self.config['relay_state_file'])
            # The on-disk identity is a JSON string, optionally followed by a newline.
            # A missing, changed, or symlinked store must never start a new relay.
            condition = f'test -f {path} && test ! -L {path} && test "$(head -c 4097 -- {path})" = {shlex.quote(json.dumps(expected))}'
            guard = f'if {condition}; then printf match; else printf mismatch; fi'
            if self.run([*self.ssh, self.config['host'], guard], timeout=30) != b'match':
                raise ProviderError('identity_mismatch')
            self.run([*self.ssh, self.config['host'], condition + ' && exec ' + shlex.join(self.commands[method])], timeout=60)
            # Only the core's authenticated health probe establishes readiness.
            return {'state_id': expected}
        raise ProviderError('unsupported_operation')


if __name__ == '__main__':
    main(SSHProvider)
