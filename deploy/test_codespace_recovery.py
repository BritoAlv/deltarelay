import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch

import recover_codespace as local
import recover_relay as remote


IDENTITY = 'a' * 64


class FixtureTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def private(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        path.chmod(0o600)
        return path

    def store(self, identity=IDENTITY):
        self.private('cache/mailbox/identity.json', json.dumps(identity))
        self.private('cache/.server.lock', '')
        self.private('relay.token', 'test-token')
        return self.root / 'cache'


class ProfileTest(FixtureTest):
    @patch.object(remote, 'ensure_relay')
    @patch('builtins.print')
    def test_remote_root_expands_the_remote_users_home(self, output, ensure):
        ensure.return_value = {'started': False, 'state_id': IDENTITY}
        with patch.dict(os.environ, {'HOME': str(self.root)}), patch.object(sys, 'argv', [
            'recover_relay.py', '--root', '~', '--expected-state-id', IDENTITY,
        ]):
            self.assertEqual(remote.main(), 0)
        ensure.assert_called_once_with(self.root, IDENTITY)

    @patch.object(local, 'recover')
    def test_local_default_remote_root_does_not_assume_a_username(self, recover):
        with patch.object(sys, 'argv', [
            'recover_codespace.py', '--codespace', 'example', '--profile', str(self.root),
        ]):
            self.assertEqual(local.main(), 0)
        recover.assert_called_once_with(self.root, 'example', '~/.local/share/deltarelay/codespace-test', 600)

    def test_missing_or_changed_identity_never_initializes_store(self):
        with self.assertRaises(remote.RecoveryError):
            remote.saved_store(self.root, IDENTITY)
        self.store('b' * 64)
        with self.assertRaises(remote.RecoveryError):
            remote.ensure_relay(self.root, IDENTITY)
        self.assertEqual(json.loads((self.root / 'cache/mailbox/identity.json').read_text()), 'b' * 64)

    def test_ambiguous_identity_refused(self):
        self.store()
        self.private('other/mailbox/identity.json', json.dumps(IDENTITY))
        with self.assertRaises(remote.RecoveryError):
            remote.saved_store(self.root, IDENTITY)

    def test_private_files_cannot_be_public_or_symlinks(self):
        path = self.private('token', 'secret')
        path.chmod(0o644)
        with self.assertRaises(remote.RecoveryError):
            remote.private_text(path)
        path.chmod(0o600)
        link = self.root / 'link'
        link.symlink_to(path)
        with self.assertRaises(remote.RecoveryError):
            remote.private_text(link)

    def test_pid_requires_exact_owned_arguments(self):
        path = self.private('process.pid', str(os.getpid()))
        args = os.fsdecode((Path('/proc') / str(os.getpid()) / 'cmdline').read_bytes()).split('\0')
        self.assertEqual(remote.owned_pid(path, [args[0]]), os.getpid())
        self.assertIsNone(remote.owned_pid(path, ['not-the-expected-command']))
        path.write_text('1')
        self.assertIsNone(remote.owned_pid(path, []))
        path.write_text('stale')
        self.assertIsNone(remote.owned_pid(path, []))

    @patch.object(remote.subprocess, 'Popen')
    @patch.object(remote, 'relay_info', return_value={'state_id': IDENTITY})
    def test_running_remote_relay_is_not_restarted(self, info, popen):
        self.store()
        result = remote.ensure_relay(self.root, IDENTITY)
        self.assertFalse(result['started'])
        popen.assert_not_called()

    @patch.object(remote.subprocess, 'Popen')
    @patch.object(remote, 'owned_pid', return_value=123)
    @patch.object(remote, 'relay_info', side_effect=[None, {'state_id': IDENTITY}])
    def test_live_remote_pid_still_starting_is_not_duplicated(self, info, pid, popen):
        self.store()
        result = remote.ensure_relay(self.root, IDENTITY)
        self.assertFalse(result['started'])
        popen.assert_not_called()

    @patch.object(remote.subprocess, 'Popen')
    @patch.object(remote, 'owned_pid', return_value=None)
    @patch.object(remote, 'relay_info', side_effect=[None, {'state_id': IDENTITY}])
    def test_remote_launch_uses_saved_store_and_token_file(self, info, pid, popen):
        data = self.store()
        binary = self.private('deltarelay-linux-amd64', '')
        binary.chmod(0o700)
        self.private('upstreams.json', '{}')
        child = popen.return_value
        child.pid = 123456
        child.poll.return_value = None
        result = remote.ensure_relay(self.root, IDENTITY)
        self.assertTrue(result['started'])
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index('--data') + 1], str(data))
        self.assertIn(str(self.root / 'relay.token'), args)
        self.assertNotIn('test-token', args)
        self.assertEqual((self.root / 'server.pid').read_text(), '123456\n')
        self.assertTrue(popen.call_args.kwargs['start_new_session'])

    @patch.object(local, 'owned_pid', return_value=123)
    @patch.object(local.subprocess, 'Popen')
    def test_existing_local_service_is_not_restarted(self, popen, pid):
        self.assertFalse(local.ensure_process(self.root, 'gateway.pid', [], [], 'gateway.log', 18788))
        popen.assert_not_called()

    @patch.object(local, 'owned_pid', return_value=None)
    @patch.object(local, 'port_open', return_value=True)
    @patch.object(local.subprocess, 'Popen')
    def test_occupied_port_is_not_replaced(self, popen, port, pid):
        with self.assertRaises(local.RecoveryError):
            local.ensure_process(self.root, 'gateway.pid', [], [], 'gateway.log', 18788)
        popen.assert_not_called()

    @patch.object(local, 'run')
    def test_invalid_local_identity_fails_before_network_or_startup(self, run):
        self.private('deltarelay-linux-amd64', '')
        self.private('tunnel-supervisor.sh', 'CODESPACE=test')
        self.private('upstreams.json', '{}')
        self.private('state/relay-state.json', '"invalid"')
        with self.assertRaises(local.RecoveryError):
            local.recover(self.root, 'test', '/remote', 60)
        run.assert_not_called()


class RetryTest(unittest.TestCase):
    @patch.object(local, 'run', return_value='{"state":"Available","idle_timeout_minutes":30}')
    def test_available_codespace_is_never_force_restarted_or_reconfigured(self, run):
        self.assertEqual(local.ensure_codespace('example', float('inf'))['state'], 'Available')
        self.assertEqual(run.call_count, 1)
        self.assertIn('GET', run.call_args.args[0])

    @patch.object(local.time, 'sleep')
    @patch.object(local, 'run', side_effect=[
        '{"state":"Shutdown"}', '', '{"state":"Starting"}',
        '{"state":"Available","idle_timeout_minutes":240}',
    ])
    def test_shutdown_starts_existing_codespace_then_waits(self, run, sleep):
        local.ensure_codespace('example', float('inf'))
        posts = [call.args[0] for call in run.call_args_list if 'POST' in call.args[0]]
        self.assertEqual(len(posts), 1)
        self.assertIn('/user/codespaces/example/start', posts[0])

    @patch.object(local, 'run', return_value='{"state":"Failed"}')
    def test_failed_codespace_is_not_deleted_or_recreated(self, run):
        with self.assertRaises(local.RecoveryError):
            local.ensure_codespace('example', float('inf'))
        self.assertEqual(run.call_count, 1)

    @patch.object(local.time, 'sleep')
    def test_transient_link_failure_retries_with_backoff(self, sleep):
        operation = Mock(side_effect=[local.LinkError('offline'), local.LinkError('offline'), True])
        self.assertTrue(local.retry('test', operation, float('inf')))
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4])

    def test_expired_deadline_does_not_attempt_operation(self):
        operation = Mock()
        with self.assertRaises(local.RecoveryError):
            local.retry('test', operation, 0)
        operation.assert_not_called()

    @patch.object(local.time, 'sleep')
    def test_identity_errors_are_not_retried(self, sleep):
        operation = Mock(side_effect=local.RecoveryError('identity mismatch'))
        with self.assertRaises(local.RecoveryError):
            local.retry('test', operation, float('inf'))
        self.assertEqual(operation.call_count, 1)
        sleep.assert_not_called()

    def test_connection_command_timeout_is_bounded(self):
        with self.assertRaises(local.LinkError):
            local.run([sys.executable, '-c', 'import time; time.sleep(60)'], 0.05)

    def test_remote_refusal_is_permanent(self):
        code = 'import json; print(json.dumps({"error":"saved state missing"})); raise SystemExit(73)'
        with self.assertRaisesRegex(local.RecoveryError, 'saved state missing'):
            local.run([sys.executable, '-c', code], 5)

    def test_remote_health_outage_is_retryable(self):
        code = 'import json; print(json.dumps({"error":"connection dropped"})); raise SystemExit(74)'
        with self.assertRaisesRegex(local.LinkError, 'connection dropped'):
            local.run([sys.executable, '-c', code], 5)

    def test_remote_payload_is_self_contained(self):
        result = subprocess.run([sys.executable, str(Path(remote.__file__)), '--help'], capture_output=True, text=True, check=True)
        self.assertIn('--expected-state-id', result.stdout)


class HealthTest(unittest.TestCase):
    @patch.object(remote.urllib.request, 'build_opener')
    def test_socket_timeout_is_retryable(self, opener):
        opener.return_value.open.side_effect = TimeoutError()
        with self.assertRaises(remote.LinkError):
            remote.relay_info(18787, 'test-token', IDENTITY)

    @patch.object(remote.urllib.request, 'build_opener')
    def test_connection_refused_indicates_missing_listener(self, opener):
        opener.return_value.open.side_effect = urllib.error.URLError(ConnectionRefusedError())
        self.assertIsNone(remote.relay_info(18787, 'test-token', IDENTITY))

    @patch.object(remote.urllib.request, 'build_opener')
    def test_authentication_failure_is_not_a_transient_link_error(self, opener):
        opener.return_value.open.side_effect = urllib.error.HTTPError('http://127.0.0.1', 401, 'Unauthorized', {}, None)
        with self.assertRaises(remote.RecoveryError) as error:
            remote.relay_info(18787, 'test-token', IDENTITY)
        self.assertNotIsInstance(error.exception, remote.LinkError)

    @patch.object(remote.urllib.request, 'build_opener')
    def test_identity_mismatch_is_not_retryable(self, opener):
        response = opener.return_value.open.return_value.__enter__.return_value
        response.read.return_value = b'{"version":2,"state_id":"changed","forwarding":true}'
        with self.assertRaisesRegex(remote.RecoveryError, 'identity mismatch') as error:
            remote.relay_info(18787, 'test-token', IDENTITY)
        self.assertNotIsInstance(error.exception, remote.LinkError)

    def test_redirect_does_not_forward_authentication(self):
        self.assertIsNone(remote.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.invalid'))


@unittest.skipUnless(os.environ.get('DELTARELAY_RECOVERY_TEST_BINARY'), 'set DELTARELAY_RECOVERY_TEST_BINARY for the real-binary restart test')
class RealRelayTest(FixtureTest):
    def test_restart_preserves_identity_and_uploaded_chunks(self):
        data = self.store()
        binary = self.root / 'deltarelay-linux-amd64'
        shutil.copyfile(os.environ['DELTARELAY_RECOVERY_TEST_BINARY'], binary)
        binary.chmod(0o700)
        self.private('upstreams.json', '[{"name":"unused","origin":"https://example.invalid","path_prefix":"/"}]')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        command = [str(binary), 'serve', '--listen', f'127.0.0.1:{port}', '--data', str(data),
                   '--token-file', str(self.root / 'relay.token'), '--upstreams', str(self.root / 'upstreams.json')]
        initial = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def stop(child):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()

        self.addCleanup(stop, initial)
        deadline = time.monotonic() + 10
        while remote.relay_info(port, 'test-token', IDENTITY) is None:
            if initial.poll() is not None or time.monotonic() > deadline:
                self.fail('Fixture relay did not start')
            time.sleep(0.05)
        body = self.private('probe.json', '{"synthetic":"' + 'cache recovery probe ' * 3000 + '"}')
        sync = [str(binary), 'sync', '--input', str(body), '--server', f'http://127.0.0.1:{port}',
                '--token-file', str(self.root / 'relay.token'), '--state-dir', str(self.root / 'client-state')]
        cold = json.loads(subprocess.run(sync, capture_output=True, text=True, check=True, timeout=30).stdout)
        self.assertGreater(cold['uploaded_chunks'], 0)
        identity_before = (data / 'mailbox/identity.json').read_bytes()
        stop(initial)
        real_popen = subprocess.Popen

        def track(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            self.addCleanup(stop, child)
            return child

        with patch.object(remote.subprocess, 'Popen', side_effect=track):
            self.assertTrue(remote.ensure_relay(self.root, IDENTITY, port)['started'])
        self.assertFalse(remote.ensure_relay(self.root, IDENTITY, port)['started'])
        warm = json.loads(subprocess.run(sync, capture_output=True, text=True, check=True, timeout=30).stdout)
        self.assertEqual(warm['uploaded_chunks'], 0)
        self.assertEqual(warm['hash'], cold['hash'])
        self.assertEqual((data / 'mailbox/identity.json').read_bytes(), identity_before)


if __name__ == '__main__':
    unittest.main()
