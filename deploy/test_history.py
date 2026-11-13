import json
import os
from pathlib import Path
import tempfile
import unittest

import supervision.history as history
from remote_provider import ProviderError


TOTAL_KEYS = history.TOTAL_KEYS


def totals(**values):
    result = {key: 0 for key in TOTAL_KEYS}
    result.update(values)
    return result


def snapshot(host, since='2026-10-28T00:00:00Z', sessions=None, requests=None, buckets=None):
    return {
        'version': 1,
        'since': since,
        'totals': totals(requests=len(requests or []), body_bytes=10 * len(requests or [])),
        'host_totals': {host: totals(requests=len(requests or []), body_bytes=10 * len(requests or []))},
        'sessions': sessions or [],
        'recent_requests': requests or [],
        'traffic': {
            'hourly': {'since': since, 'bucket_seconds': 3600, 'retention_seconds': 31 * 24 * 3600,
                       'buckets': buckets or []},
            'daily': {'since': since, 'bucket_seconds': 86400, 'retention_seconds': 91 * 24 * 3600,
                      'buckets': buckets or []},
        },
        'session_limit': 256,
        'request_limit': 1000,
        'evicted_sessions': 0,
        'dropped_requests': 0,
        'persistent': False,
        'persistence_error': False,
    }


def session(host, ident, updated='2026-10-28T01:00:00Z', requests=1):
    value = totals(requests=requests, body_bytes=10 * requests)
    return {'host': host, 'id': ident, 'started_at': '2026-10-28T00:00:00Z', 'updated_at': updated,
            'upstream': 'openai', 'last_status': 200, 'last_request_id': 'request-' + ident, **value}


def request(host, sequence, ident, session_id, started='2026-10-28T00:00:00Z'):
    return {'host': host, 'sequence': sequence, 'id': ident, 'session_id': session_id,
            'upstream': 'openai', 'kind': 'primary', 'started_at': started,
            'finished_at': started, 'state': 'completed', 'status': 200,
            'transfer': {'body_bytes': 10, 'uploaded_chunk_bytes': 5, 'request_body_bytes_sent': 4,
                         'reused_body_bytes': 6},
            'response_bytes': 7, 'duration_ms': 8}


def bucket(host, start='2026-10-28T00:00:00Z', requests=1):
    return {'host': host, 'start': start, 'requests': requests, 'failed': 0, 'cancelled': 0,
            'body_bytes': 10 * requests, 'uploaded_chunk_bytes': 0, 'encoded_upload_bytes': 0,
            'reused_body_bytes': 0, 'response_bytes': 0, 'duration_ms': 0}


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        self.local = self.project / '.runtime' / 'local'
        self.local.mkdir(parents=True, mode=0o700)
        os.chmod(self.local, 0o700)
        self.profiles = self.project / '.runtime' / 'codespaces'
        self.profiles.mkdir(parents=True, mode=0o700)
        os.chmod(self.profiles, 0o700)

    def write_private(self, path, value):
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(path.parent, 0o700)
        path.write_text(json.dumps(value))
        os.chmod(path, 0o600)

    def profile(self, name, value, captures=()):
        path = self.profiles / name
        path.mkdir(mode=0o700)
        self.write_private(path / 'stats.json', value)
        capture_root = path / 'captures'
        capture_root.mkdir(mode=0o700)
        for ident, sequence in captures:
            directory = capture_root / ident
            directory.mkdir(mode=0o700)
            trace = {'version': 1, 'id': ident, 'request_id': 'request-' + ident, 'sequence': sequence,
                     'started_at': '2026-10-28T00:00:00Z', 'state': 'completed'}
            self.write_private(directory / 'capture.json', trace)
        return path

    def config(self, stats=None, captures=None, host=None):
        command = ['/bin/deltarelay', 'gateway', '--stats-file', str(stats or '/old/stats.json'),
                   '--capture-dir', str(captures or '/old/captures')]
        if host:
            command.extend(('--history-host', host))
        return {'version': 1, 'profile': str(self.local), 'relay_url': 'http://127.0.0.1:18787',
                'gateway_url': 'http://127.0.0.1:18788', 'relay_token_file': str(self.local / 'relay.token'),
                'local_token_file': str(self.local / 'local.token'),
                'relay_state_file': str(self.local / 'state/relay-state.json'),
                'remote': {'command': ['/bin/true'], 'config_file': str(self.local / 'provider.json')},
                'components': {'gateway': {'command': command, 'pid_file': str(self.local / 'gateway.pid')}}}

    def test_rewrite_gateway_history_uses_shared_paths_and_host(self):
        config = self.config(host='old')
        updated, changed = history.rewrite_gateway_history(config, 'alpha')
        self.assertTrue(changed)
        stats, captures = history.shared_paths(config)
        command = updated['components']['gateway']['command']
        self.assertEqual(command[command.index('--stats-file') + 1], str(stats))
        self.assertEqual(command[command.index('--capture-dir') + 1], str(captures))
        self.assertEqual(command[command.index('--history-host') + 1], 'alpha')
        self.assertEqual(config['components']['gateway']['command'][3], '/old/stats.json')

    def test_merge_snapshot_combines_hosts_and_offsets_sequences(self):
        target = snapshot('alpha', sessions=[session('alpha', 'ses_same')],
                          requests=[request('alpha', 1, 'request-a', 'ses_same')])
        source = snapshot('beta', since='2026-10-29T00:00:00Z', sessions=[session('beta', 'ses_same')],
                          requests=[request('beta', 1, 'request-b', 'ses_same')],
                          buckets=[bucket('beta')])
        offset = history.merge_snapshot(target, source, 'beta')
        self.assertEqual(offset, 1)
        self.assertEqual(target['totals']['requests'], 2)
        self.assertEqual(target['host_totals']['alpha']['requests'], 1)
        self.assertEqual(target['host_totals']['beta']['requests'], 1)
        same = [item for item in target['sessions'] if item['id'] == 'ses_same']
        self.assertEqual(sorted(item['host'] for item in same), ['alpha', 'beta'])
        self.assertEqual([item['sequence'] for item in target['recent_requests']], [1, 2])

    def test_ensure_shared_history_moves_captures_and_is_idempotent(self):
        self.profile('alpha', snapshot('alpha', sessions=[session('alpha', 'ses_1')],
                                       requests=[request('alpha', 1, 'request-a', 'ses_1')]),
                     captures=[('a' * 32, 1)])
        self.profile('beta', snapshot('beta', since='2026-10-29T00:00:00Z',
                                      sessions=[session('beta', 'ses_2')],
                                      requests=[request('beta', 1, 'request-b', 'ses_2')]),
                     captures=[('b' * 32, 1)])
        config = self.config()
        report = []
        self.assertTrue(history.ensure_shared_history(self.project, config, 'beta', report=report.append))
        stats, captures = history.shared_paths(config)
        merged = json.loads(stats.read_text())
        self.assertEqual(merged['totals']['requests'], 2)
        self.assertEqual(set(merged['host_totals']), {'alpha', 'beta'})
        self.assertEqual(sorted(item['sequence'] for item in merged['recent_requests']), [1, 2])
        self.assertTrue((captures / ('a' * 32) / 'capture.json').is_file())
        self.assertTrue((captures / ('b' * 32) / 'capture.json').is_file())
        second = json.loads((captures / ('b' * 32) / 'capture.json').read_text())
        self.assertEqual(second['sequence'], 2)
        for name in ('alpha', 'beta'):
            self.assertTrue((self.profiles / name / 'stats.json').exists() is False)
            self.assertTrue(list((self.profiles / name).glob('stats.json.merged-*')))
        self.assertFalse(history.ensure_shared_history(self.project, config, 'beta', report=report.append))

    def test_configure_rewrites_private_config_and_imports_once(self):
        self.profile('alpha', snapshot('alpha', sessions=[session('alpha', 'ses_1')],
                                       requests=[request('alpha', 1, 'request-a', 'ses_1')]))
        config = self.config()
        self.write_private(self.local / 'relay.token', 'a' * 64)
        self.write_private(self.local / 'local.token', 'b' * 64)
        self.write_private(self.local / 'state', 'c' * 64)
        os.symlink('codespaces/alpha', self.project / '.runtime' / 'current')
        config_file = self.project / 'supervisor.json'
        self.write_private(config_file, config)
        updated = history.configure(self.project, config_file, config, report=lambda _: None)
        command = updated['components']['gateway']['command']
        self.assertEqual(command[command.index('--history-host') + 1], 'alpha')
        self.assertTrue((self.local / 'dashboard-stats.json').exists())
        saved = json.loads(config_file.read_text())
        self.assertEqual(saved['components']['gateway']['command'], command)
        self.assertEqual(history.configure(self.project, config_file, saved, report=lambda _: None)['components']['gateway']['command'], command)

    def test_merge_keeps_more_than_the_previous_limits(self):
        target = snapshot('alpha')
        sessions = [session('beta', f'ses_{index}') for index in range(300)]
        requests = [request('beta', index + 1, f'request-{index}', f'ses_{index}') for index in range(1200)]
        history.merge_snapshot(target, snapshot('beta', sessions=sessions, requests=requests), 'beta')
        self.assertEqual(len(target['sessions']), 300)
        self.assertEqual(len(target['recent_requests']), 1200)
        self.assertEqual(target['evicted_sessions'], 0)
        self.assertEqual(target['dropped_requests'], 0)

    def test_invalid_source_fails_without_replacing_target(self):
        self.profile('alpha', {'version': 1})
        config = self.config()
        with self.assertRaises(ProviderError):
            history.ensure_shared_history(self.project, config, 'alpha', report=lambda _: None)
        stats, _ = history.shared_paths(config)
        self.assertFalse(stats.exists())


if __name__ == '__main__':
    unittest.main()
