#!/usr/bin/env python3
"""Standalone, read-only provider example. No DeltaRelay imports or dependencies."""

import json
import os
from pathlib import Path
import stat
import sys


def object_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def main():
    request_id = ''
    try:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('request too large')
        request = json.loads(data, object_pairs_hook=object_pairs)
        if (not isinstance(request, dict) or set(request) != {'protocol_version', 'id', 'method', 'config_file', 'params'} or
                type(request['protocol_version']) is not int or request['protocol_version'] != 1 or
                not isinstance(request['id'], str) or not 0 < len(request['id']) <= 128 or
                not isinstance(request['config_file'], str) or not Path(request['config_file']).is_absolute() or
                request['params'] != {}):
            raise ValueError('invalid request')
        request_id = request['id']
        fd = os.open(request['config_file'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 262144:
                raise ValueError('unsafe configuration')
            config = json.load(file, object_pairs_hook=object_pairs)
        method = request['method']
        if method == 'describe':
            result = {'id': 'example', 'label': 'My remote host', 'capabilities': []}
        elif method == 'connection':
            result = {'relay_url': config['relay_url']}
        elif method == 'status':
            result = {'host_state': 'unknown'}
        else:
            print(json.dumps({'protocol_version': 1, 'id': request_id,
                              'error': {'code': 'unsupported_operation', 'retryable': False}}))
            return
        response = {'result': result}
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        response = {'error': {'code': 'configuration_error', 'retryable': False}}
    print(json.dumps({'protocol_version': 1, 'id': request_id, **response}))


if __name__ == '__main__':
    main()
