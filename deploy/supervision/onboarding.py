"""Explicit first-run setup, separate from the recovery-only provider contract."""

import copy
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import stat
import sys
import tarfile
import tempfile

from remote_provider import ProviderError, private_json, run_command
from providers.codespaces import CodespacesProvider
from providers.ssh import SSHProvider
from .state import save_json


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ProviderError('unsafe_private_file')


def create_file(path, data, mode=0o600):
    """Publish a complete private file without replacing any existing entry."""
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            os.chmod(temporary, mode)
            os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def token_file(path):
    if not path.exists() and not path.is_symlink():
        try:
            create_file(path, (secrets.token_hex(32) + '\n').encode())
        except FileExistsError:
            pass
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as file:
        info = os.fstat(file.fileno())
        value = file.read(4097).strip()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or
                not value or len(value) > 4096 or any(c.isspace() for c in value)):
            raise ProviderError('unsafe_private_file')
        return value


def create_config(project, path):
    """Create only local onboarding files; never contact or discover a remote."""
    if path.exists() or path.is_symlink():
        return
    private_directory(path.parent)
    profile = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'deltarelay'
    profile = profile.absolute()
    private_directory(profile)
    if (profile / 'relay-state.json').exists() or (profile / 'relay-state.json').is_symlink():
        raise ProviderError('identity_already_configured')
    local = path.parent / 'local.token'
    token_file(local)
    upstreams = path.parent / 'upstreams.json'
    if not upstreams.exists() and not upstreams.is_symlink():
        create_file(upstreams, (project / 'configs/upstreams.json').read_bytes())
    private_json(upstreams)
    binary = str(project / 'bin/deltarelay')
    config = {
        'version': 1, 'profile': str(profile),
        'relay_url': 'http://127.0.0.1:8787', 'gateway_url': 'http://127.0.0.1:8788',
        'relay_token_file': str(path.parent / 'relay.token'), 'local_token_file': str(local),
        'relay_state_file': str(profile / 'relay-state.json'),
        'setup': {'project': str(project), 'config_file': str(path)},
        'components': {
            'dashboard': {
                'command': [binary, 'dashboard', '--gateway', 'http://127.0.0.1:8788',
                            '--local-token-file', str(local), '--assets', str(project / 'web/dist'),
                            '--control-socket', str(profile / 'control/supervisor.sock')],
                'pid_file': str(profile / 'dashboard.pid'), 'port': 8790,
            },
            'gateway': {
                'command': [binary, 'gateway', '--server', 'http://127.0.0.1:8787',
                            '--token-file', str(path.parent / 'relay.token'), '--local-token-file', str(local),
                            '--upstreams', str(upstreams), '--state-dir', str(profile),
                            '--stats-file', str(profile / 'dashboard-stats.json')],
                'pid_file': str(profile / 'gateway.pid'), 'port': 8788,
            },
        },
    }
    create_file(path, json.dumps(config).encode())


def validate_request(value):
    fields = {'provider', 'target', 'remote_directory', 'ssh_port', 'remote_port', 'confirmed'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ProviderError('invalid_setup_request')
    if value['confirmed'] is not True:
        raise ProviderError('confirmation_required')
    provider, target, directory = value['provider'], value['target'], value['remote_directory']
    if provider not in ('ssh', 'codespaces') or not isinstance(target, str) or len(target) > 255:
        raise ProviderError('invalid_setup_request')
    pattern = r'[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*' if provider == 'ssh' else r'[A-Za-z0-9][A-Za-z0-9-]*'
    if not re.fullmatch(pattern, target):
        raise ProviderError('invalid_setup_request')
    if (not isinstance(directory, str) or not 1 <= len(directory) <= 512 or
            any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in directory) or
            not (directory.startswith('/') or directory.startswith('~/')) or
            '..' in PurePosixPath(directory).parts or directory in ('/', '~/')):
        raise ProviderError('invalid_setup_request')
    if type(value['remote_port']) is not int or not 1024 <= value['remote_port'] <= 65535 or \
            type(value['ssh_port']) is not int or not 1 <= value['ssh_port'] <= 65535:
        raise ProviderError('invalid_setup_request')
    return {key: value[key] for key in fields - {'confirmed'}}


class RemoteSetup:
    def __init__(self, config, directory, journal, cancel):
        self.config, self.directory, self.journal, self.cancel = config, directory, journal, cancel
        self.pending = directory / 'setup-pending.json'
        self.last_error = ''

    def status(self, busy=False):
        enabled = 'setup' in self.config and 'remote' not in self.config
        target = None
        if enabled and (self.pending.exists() or self.pending.is_symlink()):
            target = private_json(self.pending)['request']
        return {'version': 1, 'available': enabled, 'required': 'remote' not in self.config,
                'busy': enabled and busy, 'last_error': self.last_error, 'target': target}

    def request(self, value):
        if 'setup' not in self.config or 'remote' in self.config:
            raise ProviderError('setup_not_available')
        request = validate_request(value)
        if self.pending.exists() or self.pending.is_symlink():
            if private_json(self.pending)['request'] != request:
                raise ProviderError('setup_target_locked')
        elif Path(self.config['relay_state_file']).exists() or Path(self.config['relay_state_file']).is_symlink():
            raise ProviderError('identity_already_configured')
        return request

    def install(self, request):
        project = Path(self.config['setup']['project'])
        pending = private_json(self.pending) if self.pending.exists() else {'request': request, 'state_id': secrets.token_hex(32)}
        if pending['request'] != request:
            raise ProviderError('setup_target_locked')
        expected = pending['state_id']
        token = token_file(Path(self.config['relay_token_file']))
        # Register a newly generated secret before any subprocess can emit it.
        self.journal.redact.add(token)

        def run(command, **kwargs):
            return run_command(command, cancel=self.cancel, trace=self.journal.sink('setup'), **kwargs)

        provider_config = {'relay_url': self.config['relay_url'], 'remote_port': request['remote_port']}
        if request['provider'] == 'ssh':
            provider_config.update(host=request['target'], ssh_options=['-p', str(request['ssh_port'])])
            provider = SSHProvider(provider_config, run=run)
            prefix = [*provider.ssh, request['target']]
        else:
            provider_config.update(name=request['target'], remote_directory=request['remote_directory'])
            provider = CodespacesProvider(provider_config, run=run, stop=self.cancel)
            # Setup confirmation includes permission to resume this selected host.
            provider.call('host.wake')
            prefix = [provider.cli, 'codespace', 'ssh', '-c', request['target'], '--',
                      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2']
        self.journal.write('event', 'Checking remote Linux/Python and CPU architecture', component='setup')
        helper = (project / 'deploy/install_relay.py').read_text()
        command = ['python3', '-c', helper, '--root', request['remote_directory'],
                   '--expected-state-id', expected, '--port', str(request['remote_port'])]
        machine = json.loads(run([*prefix, shlex.join([*command, '--check'])], timeout=30))
        arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine.get('machine'))
        if machine.get('system') != 'Linux' or not arch:
            raise ProviderError('unsupported_remote_platform')
        go = shutil.which('go')
        if not go:
            raise ProviderError('setup_go_required')
        with tempfile.TemporaryDirectory(prefix='relay-setup-', dir=self.directory) as temporary:
            binary = Path(temporary) / 'deltarelay'
            self.journal.write('event', f'Building the Linux {arch} relay offline', component='setup')
            run([go, '-C', str(project), 'build', '-trimpath', '-o', str(binary), './cmd/deltarelay'],
                timeout=180, allow_gh=False,
                env={'GOOS': 'linux', 'GOARCH': arch, 'CGO_ENABLED': '0',
                     'GOPROXY': 'off', 'GOSUMDB': 'off', 'GOTOOLCHAIN': 'local'})
            files = {'deltarelay': binary.read_bytes(), 'relay.token': (token + '\n').encode(),
                     'upstreams.json': (Path(self.config['setup']['config_file']).parent / 'upstreams.json').read_bytes(),
                     'recover_relay.py': (project / 'deploy/recover_relay.py').read_bytes()}
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                for name, data in files.items():
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(data), 0o700 if name == 'deltarelay' else 0o600
                    tar.addfile(entry, io.BytesIO(data))
            # Lock the destination/identity only once a remote mutation may occur.
            # Authentication, preflight, and build failures can still be corrected
            # in the form without leaving an unusable destination reservation.
            if not self.pending.exists():
                create_file(self.pending, json.dumps(pending).encode())
            self.journal.write('event', 'Transferring private deployment over SSH and starting the loopback relay', component='setup')
            result = json.loads(run([*prefix, shlex.join(command)], input=archive.getvalue(), timeout=120))
        if (not isinstance(result, dict) or result.get('state_id') != expected or
                not isinstance(result.get('root'), str) or not result['root'].startswith('/')):
            raise ProviderError('invalid_setup_response')
        root = result['root']
        if request['provider'] == 'ssh':
            arguments = ['python3', root + '/recover_relay.py', '--root', root,
                         '--expected-state-id', expected, '--port', str(request['remote_port'])]
            provider_config.update(relay_state_file=root + '/cache/mailbox/identity.json',
                                   start_command=arguments, restart_command=[*arguments, '--restart'])
        else:
            provider_config['remote_directory'] = root
        provider_file = self.directory / 'setup-provider.json'
        if provider_file.exists() or provider_file.is_symlink():
            if private_json(provider_file) != provider_config:
                raise ProviderError('setup_configuration_changed')
        else:
            create_file(provider_file, json.dumps(provider_config).encode())
        pin = Path(self.config['relay_state_file'])
        if pin.exists() or pin.is_symlink():
            if private_json(pin) != expected:
                raise ProviderError('identity_mismatch')
        else:
            create_file(pin, json.dumps(expected).encode())
        updated = copy.deepcopy(self.config)
        updated['remote'] = {'command': [sys.executable, '-B', str(project / 'deploy/providers' / (request['provider'] + '.py'))],
                             'config_file': str(provider_file)}
        if request['provider'] == 'codespaces':
            updated['remote']['pass_env'] = [key for key in ('GH_TOKEN', 'GITHUB_TOKEN') if key in os.environ]
        config_file = Path(self.config['setup']['config_file'])
        if private_json(config_file) not in (self.config, updated):
            raise ProviderError('setup_configuration_changed')
        save_json(config_file, updated)
        self.journal.write('event', 'Remote installation verified; credentials, identity pin, and provider configuration saved', component='setup')
        return updated['remote']
