"""Configuration validation and compatibility adapters."""

from pathlib import Path
import re

from remote_provider import ProviderError as ControlError, origin, validate_spec
from providers.legacy import validate_legacy


COMPONENTS = ('dashboard', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop')
LABELS = dict(zip(COMPONENTS, ('Dashboard', 'Local gateway', 'VPS connection', 'Remote relay',
                               'OpenCode service', 'Isolated Desktop')))
DEFAULT_INTERNET_CHECK_URL = 'https://example.com/'
INTERNET_CHECK_INTERVAL = 15


def loopback_origin(value, https=False):
    return origin(value) and (https or value.startswith('http://'))


def internet_check_origin(value):
    return origin(value)


def validate(config):
    if not isinstance(config, dict) or config.get('version') != 1 or not isinstance(config.get('components'), dict):
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
    if 'remote' in config:
        validate_spec(config['remote'])
        if config.get('codespace') or any(name in config['components'] for name in ('tunnel', 'relay')):
            raise ControlError('ambiguous_remote_configuration')
    validate_legacy(config)


def codespace_config(project, profile, port):
    """Adapt only an already-configured private profile; never provision credentials."""
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
