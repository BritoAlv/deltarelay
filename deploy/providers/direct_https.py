#!/usr/bin/env python3
"""Connect to an existing HTTPS relay without machine/service administration."""

from pathlib import Path
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_provider import ProviderError, origin
from providers.common import main


class HTTPSProvider:
    def __init__(self, config):
        if not isinstance(config, dict) or not origin(config.get('relay_url'), https_only=True):
            raise ProviderError('invalid_configuration')
        self.config = config

    def call(self, method, params=None):
        if method == 'describe':
            return {'id': 'direct_https', 'label': 'HTTPS remote relay', 'capabilities': []}
        if method == 'connection':
            return {'relay_url': self.config['relay_url']}
        if method == 'status':
            return {'host_state': 'unknown'}
        raise ProviderError('unsupported_operation')


if __name__ == '__main__':
    main(HTTPSProvider)
