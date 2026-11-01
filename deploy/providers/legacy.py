"""Read-only configuration adapters for pre-plugin private profiles."""

from remote_provider import ExecutableProvider, ProviderError, validate_params, validate_result
from providers.codespaces import CodespacesProvider


def normalize_component(config, name):
    # Old dashboard/API clients may still address the Codespace explicitly.
    return 'remote' if name == 'codespace' and config.get('codespace') else name


def validate_legacy(config):
    if config.get('codespace'):
        try:
            CodespacesProvider(dict(config['codespace'], relay_url=config['relay_url']))
        except (ProviderError, TypeError, ValueError):
            raise ProviderError('invalid_codespace') from None


class LegacyProvider:
    def __init__(self, config, run, stop, start, restart):
        self.config, self.start, self.restart = config, start, restart
        self.delegate = CodespacesProvider(dict(config['codespace'], relay_url=config['relay_url']), run, stop) if config.get('codespace') else None
        self.connection = {'relay_url': config['relay_url']}
        if self.delegate:
            self.metadata = self.delegate.call('describe')
        else:
            spec = config['components'].get('relay', {})
            capabilities = []
            if spec.get('command') or spec.get('start_command'):
                capabilities.append('relay.ensure')
            if spec.get('command') or spec.get('restart_command'):
                capabilities.append('relay.restart')
            self.metadata = {'id': 'configured', 'label': 'Remote host', 'capabilities': capabilities}

    def prepare(self):
        return self.connection

    def call(self, method, params=None):
        params = {} if params is None else params
        validate_params(method, params)
        if self.delegate:
            return validate_result(method, self.delegate.call(method, params))
        if method == 'describe':
            return self.metadata
        if method == 'connection':
            return self.connection
        if method == 'status':
            return {'host_state': 'unknown'}
        if method not in self.metadata['capabilities']:
            raise ProviderError('unsupported_operation')
        (self.restart if method == 'relay.restart' else self.start)('relay')
        return {'state_id': params['expected_state_id']}


def load_provider(config, run, stop, start, restart):
    if 'remote' in config:
        return ExecutableProvider(config['remote'], config['relay_url'], stop)
    return LegacyProvider(config, run, stop, start, restart)
