"""Configuration validation for the executable-provider supervisor."""

from pathlib import Path

from remote_provider import ProviderError as ControlError, origin, validate_spec


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
        if name not in COMPONENTS or not isinstance(spec, dict) or 'adopt_match' in spec:
            raise ControlError('invalid_component')
        for key in ('command', 'start_command', 'restart_command', 'status_command', 'match'):
            if key in spec and (not isinstance(spec[key], list) or not spec[key] or
                                any(not isinstance(arg, str) or not arg or '\0' in arg for arg in spec[key])):
                raise ControlError('invalid_command')
        if 'command' in spec and not Path(spec.get('pid_file', '')).is_absolute():
            raise ControlError('absolute_pid_file_required')
        if 'port' in spec and (type(spec['port']) is not int or not 0 < spec['port'] < 65536):
            raise ControlError('invalid_port')
    setup = config.get('setup')
    if setup is not None and (not isinstance(setup, dict) or set(setup) != {'project', 'config_file'} or
                              any(not isinstance(v, str) or '\0' in v or not Path(v).is_absolute() for v in setup.values())):
        raise ControlError('invalid_configuration')
    if 'remote' not in config and setup is None:
        raise ControlError('remote_provider_required')
    if 'remote' in config:
        validate_spec(config['remote'])
    if 'codespace' in config or any(name in config['components'] for name in ('tunnel', 'relay')):
        raise ControlError('ambiguous_remote_configuration')
