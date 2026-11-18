"""Configuration validation for the executable-provider supervisor."""

import copy
import ipaddress
from pathlib import Path
import urllib.parse

from remote_provider import ProviderError as ControlError, origin, validate_spec


COMPONENTS = ('dashboard', 'gate', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop', 'openchamber')
LABELS = dict(zip(COMPONENTS, ('Dashboard', 'Frontend health gate', 'Local gateway', 'Remote host connection',
                               'Remote relay', 'OpenCode service', 'Isolated Desktop', 'OpenChamber')))
FRONTENDS = ('openchamber', 'desktop')
# OpenChamber is manual-only: it is started from the dashboard's component
# controls and never by normal startup or Start system.
AUTO_FRONTENDS = ('desktop',)
DEFAULT_INTERNET_CHECK_URL = 'https://example.com/'
DEFAULT_GATE_URL = 'http://127.0.0.1:18789'
INTERNET_CHECK_INTERVAL = 15


def launchable(spec):
    return isinstance(spec, dict) and bool(spec.get('command') or spec.get('start_command'))


def preferred_frontend(config):
    """Return the launchable frontend the supervisor starts by default.

    Only Desktop is auto-started. OpenChamber is intentionally manual: the
    dashboard's Start action launches it without changing this default.
    """
    components = config.get('components', {})
    for name in AUTO_FRONTENDS:
        if launchable(components.get(name)):
            return name
    return None


def loopback_origin(value, https=False):
    return origin(value) and (https or value.startswith('http://'))


def gate_origin(value):
    """Return the literal loopback host and explicit port of a gate origin."""
    try:
        if not isinstance(value, str) or any(ord(c) <= 32 or 127 <= ord(c) <= 159 for c in value):
            return None
        parsed = urllib.parse.urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname or '')
        if (parsed.scheme != 'http' or not address.is_loopback or parsed.username or parsed.password or
                parsed.path or parsed.query or parsed.fragment or parsed.port is None or
                not 0 < parsed.port < 65536):
            return None
        return str(address), parsed.port
    except (TypeError, ValueError, AttributeError):
        return None


def local_cli(config):
    """Find an existing absolute DeltaRelay command; never guess or use PATH."""
    for name in ('dashboard', 'gateway'):
        spec = config.get('components', {}).get(name, {})
        command = spec.get('command') if isinstance(spec, dict) else None
        if isinstance(command, list) and command and isinstance(command[0], str):
            path = Path(command[0])
            if path.is_absolute() and path.name == 'deltarelay':
                return command[0]
    return None


def default_gate_decision(config):
    """Classify default gate activation without mutating the configuration."""
    if 'gate' in config.get('components', {}):
        return 'explicit'
    if config.get('gate_default') is False:
        return 'disabled'
    service_file = config.get('opencode_service_file')
    if not isinstance(service_file, str) or not Path(service_file).is_absolute():
        return 'no_registration'
    if not local_cli(config):
        return 'no_binary'
    if gate_origin(config.get('gate_url', DEFAULT_GATE_URL)) is None:
        return 'invalid_origin'
    return 'enabled'


def enable_default_gate(config):
    """Return a config with an in-memory default gate component when safe.

    Explicit ``components.gate`` always wins, ``gate_default: false`` opts out,
    and synthesis never guesses an executable, service-manager command, or shell.
    """
    if default_gate_decision(config) != 'enabled':
        return config
    gate_url = config.get('gate_url', DEFAULT_GATE_URL)
    host, port = gate_origin(gate_url)
    listen = f'[{host}]:{port}' if ':' in host else f'{host}:{port}'
    command = [local_cli(config), 'gate', '--listen', listen,
               '--service-file', config['opencode_service_file'],
               '--gateway', config['gateway_url'],
               '--local-token-file', config['local_token_file']]
    if config.get('opencode_directory'):
        command.extend(('--workspace-directory', config['opencode_directory']))
    command.extend(('--health-cache', '2s'))
    result = copy.deepcopy(config)
    result['gate_url'] = gate_url
    result['components']['gate'] = {
        'command': command,
        'pid_file': str(Path(config['profile']) / 'gate.pid'),
        'port': port,
    }
    return result


def validate_vscode(value):
    """Validate the one-shot command behind the dashboard's Open action."""
    if not isinstance(value, dict) or 'open_command' not in value or set(value) - {'open_command', 'env'}:
        raise ControlError('invalid_configuration')
    command = value['open_command']
    if (not isinstance(command, list) or not command or
            any(not isinstance(arg, str) or not arg or '\0' in arg for arg in command) or
            not Path(command[0]).is_absolute()):
        raise ControlError('invalid_command')
    env = value.get('env', {})
    if not isinstance(env, dict) or any(not isinstance(key, str) or not key or '=' in key or '\0' in key or
                                        not isinstance(item, str) or '\0' in item for key, item in env.items()):
        raise ControlError('invalid_configuration')


def internet_check_origin(value):
    return origin(value)


def validate(config):
    if not isinstance(config, dict) or config.get('version') != 1 or not isinstance(config.get('components'), dict):
        raise ControlError('invalid_configuration')
    for key in ('profile', 'relay_token_file', 'relay_state_file', 'local_token_file'):
        if not isinstance(config.get(key), str) or not Path(config[key]).is_absolute():
            raise ControlError('absolute_private_paths_required')
    if 'opencode_directory' in config and (not isinstance(config['opencode_directory'], str) or
                                           not Path(config['opencode_directory']).is_absolute()):
        raise ControlError('absolute_private_paths_required')
    if 'gate_default' in config and type(config['gate_default']) is not bool:
        raise ControlError('invalid_configuration')
    if 'gate_url' in config and gate_origin(config['gate_url']) is None:
        raise ControlError('unsafe_endpoint')
    if 'gate' in config['components'] and 'gate_url' not in config:
        raise ControlError('invalid_configuration')
    if 'vscode' in config:
        validate_vscode(config['vscode'])
    if not loopback_origin(config.get('relay_url', ''), https=True) or not loopback_origin(config.get('gateway_url', '')):
        raise ControlError('unsafe_endpoint')
    if not isinstance(config.get('internet_check_url', DEFAULT_INTERNET_CHECK_URL), str) or \
            not internet_check_origin(config.get('internet_check_url', DEFAULT_INTERNET_CHECK_URL)):
        raise ControlError('unsafe_internet_check')
    for name, spec in config['components'].items():
        if name not in COMPONENTS or not isinstance(spec, dict) or 'adopt_match' in spec:
            raise ControlError('invalid_component')
        for key in ('command', 'start_command', 'restart_command', 'stop_command', 'status_command', 'match'):
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
