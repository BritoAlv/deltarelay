"""Synthetic executable provider for offline supervisor tests."""

import json
from pathlib import Path
import sys

from remote_provider import CAPABILITIES


def configure_provider(config):
    root = Path(config['profile'])
    script = root / 'fixture-provider.py'
    script.write_text('''import json, sys
request = json.load(sys.stdin)
config = json.load(open(request['config_file']))
method = request['method']
if method == 'describe':
    result = {'id': 'fixture', 'label': 'Test host', 'capabilities': config['capabilities']}
elif method == 'connection':
    result = config['connection']
elif method in ('status', 'host.wake', 'host.stop'):
    result = {'host_state': 'stopped' if method == 'host.stop' else 'running'}
else:
    result = {'state_id': request['params']['expected_state_id']}
print(json.dumps({'protocol_version': 1, 'id': request['id'], 'result': result}))
''')
    path = root / 'fixture-provider.json'
    path.write_text(json.dumps({'capabilities': list(CAPABILITIES), 'connection': {'relay_url': config['relay_url']}}))
    path.chmod(0o600)
    config['remote'] = {'command': [sys.executable, '-B', str(script)], 'config_file': str(path)}
    return path
