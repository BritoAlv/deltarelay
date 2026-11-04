import json
import unittest
from unittest.mock import Mock, patch

from providers.codespaces import CodespacesProvider
from remote_provider import ProviderError


class CodespacesProviderTest(unittest.TestCase):
    def setUp(self):
        self.config = {'name': 'existing-host', 'remote_directory': '~/existing-relay',
                       'relay_url': 'http://127.0.0.1:18787', 'github_cli': '/private/tools/gh'}
        self.run = Mock()
        self.stop = Mock()
        self.stop.wait.return_value = False
        self.provider = CodespacesProvider(self.config, self.run, self.stop)

    def test_private_cli_is_used_for_wake_status_tunnel_and_relay_recovery(self):
        self.run.side_effect = [b'{"state":"Shutdown"}', b'', b'{"state":"Available"}']
        self.assertEqual(self.provider.call('host.wake'), {'host_state': 'running'})
        self.assertTrue(all(call.args[0][0] == '/private/tools/gh' for call in self.run.call_args_list))
        self.assertIn('/user/codespaces/existing-host/start', self.run.call_args_list[1].args[0])
        tunnel = self.provider.call('connection')['tunnel']
        self.assertEqual(tunnel['command'][0], '/private/tools/gh')
        self.run.side_effect = [b'{"state":"Available"}', json.dumps({'state_id': 'a' * 64}).encode()]
        self.assertEqual(self.provider.call('relay.ensure', {'expected_state_id': 'a' * 64}), {'state_id': 'a' * 64})
        self.assertEqual(self.run.call_args.args[0][0], '/private/tools/gh')
        self.assertIn(b'/info', self.run.call_args.kwargs['input'])

    def test_cli_override_must_be_an_absolute_path(self):
        for value in ('gh', '../gh', '', None, [], '/private/gh\0bad'):
            with self.subTest(value=value), self.assertRaisesRegex(ProviderError, '^invalid_configuration$'):
                CodespacesProvider({**self.config, 'github_cli': value})

    def test_stopped_host_cannot_be_implicitly_woken_by_relay_recovery(self):
        self.run.return_value = b'{"state":"Shutdown"}'
        for method in ('relay.ensure', 'relay.restart'):
            with self.assertRaisesRegex(ProviderError, '^host_stopped$'):
                self.provider.call(method, {'expected_state_id': 'a' * 64})
        self.assertTrue(all('GET' in call.args[0] for call in self.run.call_args_list))

    def test_stop_is_idempotent_and_waits_for_confirmed_shutdown(self):
        for state in ('Shutdown', 'ShuttingDown', 'Available'):
            with self.subTest(state=state):
                self.run.reset_mock()
                self.run.side_effect = ([json.dumps({'state': state}).encode()] +
                                        ([] if state == 'Shutdown' else [b'{"state":"Shutdown"}'] if state == 'ShuttingDown'
                                         else [b'', b'{"state":"ShuttingDown"}', b'{"state":"Shutdown"}']))
                self.assertEqual(self.provider.call('host.stop'), {'host_state': 'stopped'})
                posts = [call for call in self.run.call_args_list if 'POST' in call.args[0]]
                self.assertEqual(len(posts), int(state == 'Available'))

    def test_stop_wait_is_bounded_and_cancellable(self):
        for cancelled, error in ((False, 'host_stop_timeout'), (True, 'operation_cancelled')):
            with self.subTest(cancelled=cancelled):
                self.stop.wait.return_value = cancelled
                self.run.return_value = b'{"state":"ShuttingDown"}'
                with patch('providers.codespaces.time.monotonic', side_effect=[0, 121]):
                    with self.assertRaisesRegex(ProviderError, '^' + error + '$'):
                        self.provider.call('host.stop')

    def test_ssh_failures_and_changed_identity_fail_closed(self):
        for error, wanted in (('command_failed', 'relay_recovery_failed'), ('command_timeout', 'relay_ssh_timeout')):
            self.run.side_effect = [b'{"state":"Available"}', ProviderError(error)]
            with self.assertRaisesRegex(ProviderError, '^' + wanted + '$'):
                self.provider.call('relay.ensure', {'expected_state_id': 'a' * 64})
        self.run.side_effect = [b'{"state":"Available"}', json.dumps({'state_id': 'b' * 64}).encode()]
        with self.assertRaisesRegex(ProviderError, '^identity_mismatch$'):
            self.provider.call('relay.restart', {'expected_state_id': 'a' * 64})
