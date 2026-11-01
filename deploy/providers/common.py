"""Small stdio server for bundled providers. Not a required third-party dependency."""

import json
from pathlib import Path
import sys

from remote_provider import (ERROR_CODES, MAX_BYTES, RETRYABLE, VERSION, ProviderError,
                             private_json, run_command, strict_json, validate_params, validate_result)


def provider_command(*args, **kwargs):
    # Stay in the plugin's process group so its caller can cancel all children.
    return run_command(*args, new_session=False, **kwargs)


def main(factory):
    request_id = ''
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ProviderError('invalid_request')
        request = strict_json(data)
        if not isinstance(request, dict) or set(request) != {'protocol_version', 'id', 'method', 'config_file', 'params'}:
            raise ProviderError('invalid_request')
        if isinstance(request['id'], str) and 0 < len(request['id']) <= 128:
            request_id = request['id']
        if type(request['protocol_version']) is not int or request['protocol_version'] != VERSION:
            raise ProviderError('provider_version_mismatch')
        if not request_id or not isinstance(request['config_file'], str) or not Path(request['config_file']).is_absolute():
            raise ProviderError('invalid_request')
        method, params = request['method'], request['params']
        validate_params(method, params)
        provider = factory(private_json(Path(request['config_file'])))
        result = validate_result(method, provider.call(method, params))
        response = {'result': result}
    except ProviderError as error:
        code = str(error) if str(error) in ERROR_CODES else 'configuration_error'
        response = {'error': {'code': code, 'retryable': code in RETRYABLE}}
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        response = {'error': {'code': 'configuration_error', 'retryable': False}}
    response.update(protocol_version=VERSION, id=request_id)
    print(json.dumps(response))
