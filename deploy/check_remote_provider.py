#!/usr/bin/env python3
"""Check a trusted provider's read-only contract without starting tunnels or services."""

import argparse
import json
from pathlib import Path
import sys
import threading

from remote_provider import ExecutableProvider, ProviderError, private_json


def check(config):
    provider = ExecutableProvider(config['remote'], config['relay_url'], threading.Event())
    connection = provider.prepare()
    status = provider.call('status')
    if provider.call('describe') != provider.metadata or provider.call('connection') != connection:
        raise ProviderError('invalid_provider_response')
    return {**provider.metadata, **status, 'protocol_version': 1, 'tunnel': bool(connection.get('tunnel'))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path, help='private supervisor JSON containing remote and relay_url')
    args = parser.parse_args()
    try:
        print(json.dumps(check(private_json(args.config))))
        return 0
    except ProviderError as error:
        print('Provider check failed: ' + str(error), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        print('Provider check failed: configuration_error', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
