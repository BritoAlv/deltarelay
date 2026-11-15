import json
from datetime import datetime
from pathlib import Path
import tempfile
import unittest

from supervision.state_history import (
    OFF_GAP_SECONDS, StateHistory, classify, parse_query, stamp,
)


def observation(**changes):
    value = {'intent': 'running', 'busy': False, 'relay_state': 'unknown',
             'host_state': 'unknown', 'internet_state': 'unknown'}
    value.update(changes)
    return value


class StateHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.now = 1_700_000_000
        self.history = None

    def subject(self):
        self.history = StateHistory(self.root / 'state-history.jsonl', clock=lambda: self.now)
        self.addCleanup(self.history.close)
        return self.history

    def test_classifier_uses_explicit_state_precedence(self):
        self.assertEqual(classify(observation(intent='stopped', busy=True, relay_state='connected')), 'stopped')
        self.assertEqual(classify(observation(busy=True, relay_state='connected')), 'recovering')
        self.assertEqual(classify(observation(relay_state='connected', host_state='stopped')), 'connected')
        self.assertEqual(classify(observation(relay_state='unreachable', host_state='stopped')), 'host_stopped')
        self.assertEqual(classify(observation(relay_state='unreachable', host_state='stopping')), 'host_stopped')
        self.assertEqual(classify(observation(relay_state='unreachable', host_state='starting')), 'recovering')
        self.assertEqual(classify(observation(relay_state='unreachable', internet_state='unreachable')), 'no_internet')
        self.assertEqual(classify(observation(relay_state='unreachable', internet_state='connected')), 'unreachable')
        self.assertEqual(classify(observation(relay_state='authentication_failed')), 'unreachable')
        self.assertEqual(classify(observation()), 'unknown')

    def test_query_clips_transitions_into_bounded_buckets(self):
        history = self.subject()
        history.start('unknown')
        self.now = 1_700_000_010
        history.observe(observation(relay_state='connected', host_state='running', internet_state='connected'))
        self.now = 1_700_000_050
        history.observe(observation(busy=True, relay_state='unreachable', host_state='running', internet_state='connected'))
        self.now = 1_700_000_060
        history.observe(observation(relay_state='connected', host_state='running', internet_state='connected'))
        self.now = 1_700_000_100
        result = history.query(1_700_000_000, 1_700_000_100, 50)
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['bucket_seconds'], 50)
        self.assertEqual(len(result['buckets']), 2)
        self.assertEqual(result['buckets'][0]['seconds']['unknown'], 10)
        self.assertEqual(result['buckets'][0]['seconds']['connected'], 40)
        self.assertEqual(result['buckets'][1]['seconds']['recovering'], 10)
        self.assertEqual(result['buckets'][1]['seconds']['connected'], 40)
        self.assertEqual(result['totals']['connected'], 80)
        self.assertEqual(result['totals']['recovering'], 10)
        self.assertEqual(result['totals']['unknown'], 10)
        self.assertEqual(result['current'], {'state': 'connected', 'since': '2023-11-14T22:14:20Z'})

    def test_restart_records_a_gap_as_off_and_not_as_the_previous_state(self):
        history = self.subject()
        history.start('connected')
        self.now += 60
        history.observe(observation(relay_state='connected'))
        history.close()
        self.now += 600
        restarted = StateHistory(self.root / 'state-history.jsonl', clock=lambda: self.now)
        self.addCleanup(restarted.close)
        restarted.start('connected')
        result = restarted.query(self.now - 660, self.now, 60)
        self.assertEqual(result['totals']['off'], 600)
        self.assertEqual(result['current']['state'], 'connected')

    def test_quick_restart_does_not_create_an_off_blip(self):
        history = self.subject()
        history.start('connected')
        history.close()
        self.now += OFF_GAP_SECONDS - 1
        restarted = StateHistory(self.root / 'state-history.jsonl', clock=lambda: self.now)
        self.addCleanup(restarted.close)
        restarted.start('connected')
        result = restarted.query(self.now - 30, self.now, 30)
        self.assertEqual(result['totals']['off'], 0)
        self.assertEqual(result['totals']['connected'], 29)

    def test_history_file_is_private_and_corruption_does_not_block_startup(self):
        history = self.subject()
        history.start('connected')
        path = self.root / 'state-history.jsonl'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        path.write_text(path.read_text() + 'not json\n')
        path.chmod(0o600)
        restarted = StateHistory(path, clock=lambda: self.now)
        self.addCleanup(restarted.close)
        restarted.start('connected')
        self.assertTrue(restarted.storage_error)
        self.assertEqual(restarted.current, 'connected')

    def test_storage_failure_keeps_observations_in_memory(self):
        history = self.subject()
        history.start('connected')
        path = self.root / 'state-history.jsonl'
        path.unlink()
        path.symlink_to(self.root / 'elsewhere')
        self.now += 10
        history.observe(observation(busy=True))
        self.assertTrue(history.storage_error)
        result = history.query(self.now - 10, self.now, 10)
        self.assertEqual(result['persistent'], False)
        self.assertEqual(result['current']['state'], 'recovering')

    def test_query_validation_is_strict_and_bounded(self):
        valid = parse_query('start=100&end=200&bucket=10')
        self.assertEqual(valid, (100, 200, 10))
        for query in ('', 'start=100&end=200', 'start=100&end=200&bucket=0',
                      'start=200&end=100&bucket=10', 'start=-1&end=200&bucket=10',
                      'start=100&end=200&bucket=10&extra=1', 'start=100&end=200&bucket=10&bucket=10',
                      'start=100&end=999999999999&bucket=10'):
            with self.subTest(query=query), self.assertRaises(ValueError):
                parse_query(query)
        with self.assertRaises(ValueError):
            parse_query('start=0&end=3661&bucket=1')

    def test_shared_contract_matches_the_produced_response(self):
        def epoch(value):
            return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
        fixture = json.loads((Path(__file__).resolve().parents[1] / 'testdata/contracts/state-history-v1.json').read_text())
        self.now = epoch('2026-11-01T10:00:00Z')
        history = self.subject()
        history.start('connected')
        self.now = epoch('2026-11-01T11:00:00Z')
        history.observe(observation(busy=True))
        self.now = epoch('2026-11-01T11:10:00Z')
        history.observe(observation(relay_state='connected', host_state='running', internet_state='connected'))
        self.now = epoch('2026-11-01T12:00:00Z')
        history.tracking_since = epoch('2026-11-01T00:00:00Z')
        self.assertEqual(history.query(epoch('2026-11-01T10:00:00Z'), self.now, 3600), fixture)

    def test_old_transitions_survive_restarts(self):
        history = self.subject()
        started = self.now
        history.start('connected')
        self.now += 91 * 86400
        history.observe(observation(busy=True))
        history.close()
        restarted = StateHistory(self.root / 'state-history.jsonl', clock=lambda: self.now)
        self.addCleanup(restarted.close)
        restarted.start('recovering')
        result = restarted.query(started, self.now, 86400)
        self.assertEqual(result['tracking_since'], stamp(started))
        self.assertEqual(result['totals']['connected'], 91 * 86400)
        self.assertEqual(result['current']['state'], 'recovering')

    def test_legacy_backup_is_still_read(self):
        path = self.root / 'state-history.jsonl'
        backup = Path(str(path) + '.1')
        backup.write_text('[1699999000,"connected"]\n[1699999060]\n')
        backup.chmod(0o600)
        history = StateHistory(path, clock=lambda: self.now)
        self.addCleanup(history.close)
        history.start('connected')
        result = history.query(1_699_999_000, self.now, 60)
        self.assertEqual(result['totals']['connected'], 60)
        self.assertEqual(result['totals']['off'], self.now - 1_699_999_060)

    def test_large_file_is_loaded_without_size_or_record_limits(self):
        path = self.root / 'state-history.jsonl'
        path.write_bytes(b'[1699999000,"connected"]\n' + b'[1699999999]\n' * 650_000)
        path.chmod(0o600)
        self.assertGreater(path.stat().st_size, 8 << 20)
        history = StateHistory(path, clock=lambda: self.now)
        self.addCleanup(history.close)
        history.start('connected')
        self.assertFalse(history.storage_error)
        result = history.query(1_699_999_000, self.now, 60)
        self.assertEqual(result['tracking_since'], stamp(1_699_999_000))
        self.assertEqual(result['totals']['connected'], 1000)

    def test_large_file_is_appended_without_rotation(self):
        history = self.subject()
        history.start('connected')
        path = self.root / 'state-history.jsonl'
        with open(path, 'ab') as file:
            file.truncate(9 << 20)
        self.now += 10
        history.observe(observation(busy=True))
        self.assertFalse((self.root / 'state-history.jsonl.1').exists())
        self.assertGreater(path.stat().st_size, 9 << 20)


if __name__ == '__main__':
    unittest.main()
