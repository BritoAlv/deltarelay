import io
import json
import os
from pathlib import Path
import socket
import shlex
import subprocess
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch

import install_relay
from remote_provider import ProviderError, private_json
from supervision import onboarding
from supervision.control import Handler, Server, control_request
from supervision.supervisor import Supervisor


PROJECT = Path(__file__).resolve().parents[1]
REQUEST = {'provider': 'ssh', 'target': 'test-user@test-host',
           'remote_directory': '~/.local/share/new-relay', 'ssh_port': 22, 'remote_port': 18787,
           'confirmed': True}
IDENTITY = 'a' * 64


def archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
    output.seek(0)
    return output


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'config/supervisor.json'
        environment = patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state')})
        environment.start()
        self.addCleanup(environment.stop)
        onboarding.create_config(PROJECT, self.path)
        self.config = private_json(self.path)

    def supervisor(self):
        subject = Supervisor(self.config)
        self.addCleanup(subject.close)
        return subject

    def test_first_run_is_local_only_and_preserves_existing_configuration(self):
        self.assertNotIn('remote', self.config)
        self.assertFalse(Path(self.config['relay_state_file']).exists())
        self.assertFalse(Path(self.config['relay_token_file']).exists())
        token = Path(self.config['local_token_file']).read_bytes()
        self.assertEqual(Path(self.config['local_token_file']).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        original = self.path.read_bytes()
        onboarding.create_config(Path('/another/checkout'), self.path)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(Path(self.config['local_token_file']).read_bytes(), token)

    def test_onboarding_never_probes_or_recovers_before_confirmation(self):
        subject = self.supervisor()
        subject.state.set_dashboard_enabled(False)
        with patch.object(subject, 'observe_relay') as probe, patch.object(subject, 'recover') as recover:
            subject.tick()
        probe.assert_not_called()
        recover.assert_not_called()
        self.assertEqual(subject.snapshot()['recovery']['last_error'], 'setup_required')
        self.assertTrue(subject.setup_status()['available'])
        with self.assertRaisesRegex(ProviderError, '^setup_required$'):
            subject.start_component('gateway')
        self.assertFalse(Path(self.config['relay_state_file']).exists())

    def test_setup_rejects_unconfirmed_shell_inputs_and_invalid_ports(self):
        subject = self.supervisor()
        for update in ({'confirmed': False}, {'target': '-oProxyCommand=bad'}, {'target': 'host; bad'},
                       {'provider': 'custom'}, {'remote_directory': '../existing'},
                       {'remote_directory': '/'}, {'remote_directory': '~/../existing'},
                       {'remote_port': True}, {'remote_port': 80}, {'ssh_port': 65536}, {'command': 'bad'}):
            with self.subTest(update=update), self.assertRaises(ProviderError):
                subject.submit_setup({**REQUEST, **update})
        self.assertFalse(subject.setup.pending.exists())
        self.assertTrue(subject.operation.acquire(blocking=False))
        subject.operation.release()

    def fake_runner(self, calls, fail=None):
        def run(command, **kwargs):
            calls.append((command, kwargs))
            if '-C' in command:
                Path(command[command.index('-o') + 1]).write_bytes(b'fixture-linux-binary')
                return b''
            if shlex.split(command[-1])[-1] == '--check':
                if fail == 'preflight':
                    raise ProviderError('command_failed')
                return b'{"system":"Linux","machine":"aarch64"}'
            if fail == 'transfer':
                raise ProviderError('command_timeout')
            pending = private_json(self.subject.setup.pending)
            return json.dumps({'state_id': pending['state_id'], 'root': '/remote/private/relay'}).encode()
        return run

    def test_setup_transfers_secrets_only_on_stdin_and_saves_recovery_configuration(self):
        self.subject = self.supervisor()
        calls = []
        with patch.object(onboarding, 'run_command', side_effect=self.fake_runner(calls)), \
                patch.object(onboarding.shutil, 'which', return_value='/usr/bin/go'):
            remote = self.subject.setup.install(onboarding.validate_request(REQUEST))
        self.assertEqual(len(calls), 3)
        preflight, build, transfer = calls
        self.assertIn('StrictHostKeyChecking=yes', preflight[0])
        self.assertIn('BatchMode=yes', preflight[0])
        self.assertEqual(build[1]['env']['GOARCH'], 'arm64')
        self.assertEqual(build[1]['env']['GOPROXY'], 'off')
        token = Path(self.config['relay_token_file']).read_text().strip()
        self.assertNotIn(token, json.dumps([call[0] for call in calls]))
        self.assertTrue(token in self.subject.journal.redact.secrets)
        with tarfile.open(fileobj=io.BytesIO(transfer[1]['input'])) as payload:
            self.assertEqual(payload.extractfile('relay.token').read().decode().strip(), token)
            self.assertEqual(set(payload.getnames()), {'relay.token', 'deltarelay', 'upstreams.json', 'recover_relay.py'})
        configured = private_json(self.path)
        expected = private_json(self.subject.setup.pending)['state_id']
        self.assertEqual(private_json(Path(self.config['relay_state_file'])), expected)
        self.assertEqual(configured['remote'], remote)
        provider = private_json(Path(remote['config_file']))
        self.assertEqual(provider['relay_state_file'], '/remote/private/relay/cache/mailbox/identity.json')
        self.assertIn('--restart', provider['restart_command'])
        self.assertIn('ssh.py', remote['command'][-1])
        self.assertNotIn(token, json.dumps(self.subject.setup_status()))

    def test_ssh_setup_needs_no_github_cli_credentials_or_codespace_configuration(self):
        self.subject = self.supervisor()
        calls = []
        def which(binary):
            return {'ssh': '/usr/bin/ssh', 'go': '/usr/bin/go'}.get(binary)
        with patch.dict(os.environ, {'PATH': '/usr/bin'}, clear=True), \
                patch.object(onboarding.shutil, 'which', side_effect=which), \
                patch.object(onboarding, 'CodespacesProvider', side_effect=AssertionError('SSH must not use Codespaces')), \
                patch.object(onboarding, 'run_command', side_effect=self.fake_runner(calls)):
            remote = self.subject.setup.install(onboarding.validate_request(REQUEST))
        self.assertEqual([command[0] for command, _ in calls], ['/usr/bin/ssh', '/usr/bin/go', '/usr/bin/ssh'])
        self.assertNotIn('pass_env', remote)
        self.assertTrue(remote['command'][-1].endswith('/ssh.py'))
        provider = private_json(Path(remote['config_file']))
        self.assertEqual(provider['host'], REQUEST['target'])
        self.assertNotIn('name', provider)
        self.assertNotIn('github_cli', provider)
        self.assertEqual(private_json(self.path)['remote'], remote)

    def test_preflight_failures_allow_correction_but_uncertain_transfer_locks_destination(self):
        self.subject = self.supervisor()
        request = onboarding.validate_request(REQUEST)
        for fail, locked in [('preflight', False), ('transfer', True)]:
            with self.subTest(fail=fail), patch.object(onboarding.shutil, 'which', return_value='/usr/bin/go'), \
                    patch.object(onboarding, 'run_command', side_effect=self.fake_runner([], fail)), self.assertRaises(ProviderError):
                self.subject.setup.install(request)
            self.assertEqual(self.subject.setup.pending.exists(), locked)
        token = Path(self.config['relay_token_file']).read_bytes()
        pending = self.subject.setup.pending.read_bytes()
        with self.assertRaisesRegex(ProviderError, '^setup_target_locked$'):
            self.subject.setup.request({**REQUEST, 'target': 'another-host'})
        with patch.object(onboarding.shutil, 'which', return_value='/usr/bin/go'), \
                patch.object(onboarding, 'run_command', side_effect=self.fake_runner([])):
            self.subject.setup.install(request)
        self.assertEqual(self.subject.setup.pending.read_bytes(), pending)
        self.assertEqual(Path(self.config['relay_token_file']).read_bytes(), token)

    def test_codespace_setup_wake_is_explicit_and_saves_normal_provider_configuration(self):
        self.subject = self.supervisor()
        calls = []
        request = onboarding.validate_request({**REQUEST, 'provider': 'codespaces', 'target': 'existing-codespace'})
        with patch.object(onboarding, 'run_command', side_effect=self.fake_runner(calls)), \
                patch.object(onboarding.shutil, 'which', return_value='/usr/bin/go'), \
                patch.object(onboarding, 'CodespacesProvider') as factory, \
                patch.dict(os.environ, {'GH_TOKEN': 'private-fixture-gh-token'}):
            factory.return_value.cli = '/usr/bin/gh'
            remote = self.subject.setup.install(request)
        factory.return_value.call.assert_called_once_with('host.wake')
        self.assertEqual(calls[0][0][:5], ['/usr/bin/gh', 'codespace', 'ssh', '-c', 'existing-codespace'])
        self.assertIn('codespaces.py', remote['command'][-1])
        self.assertIn('GH_TOKEN', remote['pass_env'])
        self.assertNotIn('private-fixture-gh-token', json.dumps(remote))
        self.assertEqual(private_json(Path(remote['config_file']))['remote_directory'], '/remote/private/relay')

    def test_user_configuration_edits_during_setup_are_preserved(self):
        self.subject = self.supervisor()
        edited = {**self.config, 'internet_check_url': 'https://example.org/'}
        self.path.write_text(json.dumps(edited))
        with patch.object(onboarding.shutil, 'which', return_value='/usr/bin/go'), \
                patch.object(onboarding, 'run_command', side_effect=self.fake_runner([])), \
                self.assertRaisesRegex(ProviderError, '^setup_configuration_changed$'):
            self.subject.setup.install(onboarding.validate_request(REQUEST))
        self.assertEqual(private_json(self.path), edited)

    def test_existing_pins_and_unsafe_token_files_are_not_replaced(self):
        subject = self.supervisor()
        pin = Path(self.config['relay_state_file'])
        pin.write_text(json.dumps(IDENTITY))
        pin.chmod(0o600)
        with self.assertRaisesRegex(ProviderError, '^identity_already_configured$'):
            subject.submit_setup(REQUEST)
        self.assertEqual(private_json(pin), IDENTITY)
        token = Path(self.config['relay_token_file'])
        token.symlink_to(pin)
        with self.assertRaises(OSError):
            onboarding.token_file(token)
        self.assertTrue(token.is_symlink())

    def test_private_control_api_accepts_setup_as_background_work_and_serializes_operations(self):
        subject = self.supervisor()
        # Keep the Unix socket path short on machines with long TMPDIR paths.
        with tempfile.TemporaryDirectory(prefix='drsetup-') as temporary:
            path = Path(temporary) / 's'
            with Server(str(path), Handler) as server:
                server.supervisor = subject
                threading.Thread(target=server.serve_forever, daemon=True).start()
                self.addCleanup(server.shutdown)
                self.assertTrue(control_request(path, 'GET', '/setup')[1]['required'])
                started, finish = threading.Event(), threading.Event()

                def install(_):
                    started.set()
                    finish.wait(5)
                    raise ProviderError('command_failed')

                with patch.object(subject.setup, 'install', side_effect=install):
                    code, reply = control_request(path, 'POST', '/setup', REQUEST)
                    self.assertEqual((code, reply), (202, {'accepted': True}))
                    self.assertTrue(started.wait(2))
                    self.assertTrue(control_request(path, 'GET', '/setup')[1]['busy'])
                    self.assertEqual(control_request(path, 'POST', '/setup', REQUEST)[0], 409)
                    self.assertEqual(control_request(path, 'POST', '/action', {'component': 'all', 'action': 'recover'})[0], 409)
                    finish.set()
                    self.assertTrue(subject.operation.acquire(timeout=5))
                    subject.operation.release()
                self.assertEqual(subject.setup_status()['last_error'], 'command_failed')
                self.assertFalse(subject.setup_status()['busy'])


class RemoteInstallerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.root = self.parent / 'new-deployment'
        self.files = {'deltarelay': b'fixture-binary', 'relay.token': b'private-test-token\n',
                      'upstreams.json': b'[]', 'recover_relay.py': b'def ensure_relay(root, expected, port):\n return {"state_id": expected}\n'}

    def install(self, files=None):
        return install_relay.install(self.root, IDENTITY, 18787, archive(files or self.files))

    def test_new_install_and_resume_keep_credentials_identity_and_data(self):
        install_relay.inspect_root(self.root, IDENTITY, 18787)
        self.assertFalse(self.root.exists(), 'preflight must be read-only')
        self.assertEqual(self.install(), {'state_id': IDENTITY, 'root': str(self.root)})
        self.assertEqual((self.root / 'relay.token').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'deltarelay').stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        saved = self.root / 'cache/saved-response'
        saved.write_text('must survive')
        self.install()
        self.assertEqual(saved.read_text(), 'must survive')
        self.assertEqual(json.loads((self.root / 'cache/mailbox/identity.json').read_text()), IDENTITY)

    def test_existing_directory_or_different_setup_is_never_adopted(self):
        self.root.mkdir(mode=0o700)
        saved = self.root / 'relay.token'
        saved.write_text('existing-secret')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.install()
        self.assertEqual(saved.read_text(), 'existing-secret')
        self.assertFalse((self.root / '.setup.json').exists())

    def test_mismatched_files_and_identity_are_never_reset(self):
        self.install()
        with self.assertRaises(ValueError):
            install_relay.install(self.root, 'b' * 64, 18787, archive(self.files))
        with self.assertRaises(ValueError):
            self.install({**self.files, 'relay.token': b'replacement-token'})
        self.assertEqual((self.root / 'relay.token').read_bytes(), self.files['relay.token'])

    def test_archive_traversal_symlinks_and_extra_files_are_refused(self):
        with self.assertRaises(ValueError):
            self.install({**self.files, '../escaped': b'bad'})
        self.assertFalse((self.parent / 'escaped').exists())
        self.assertFalse((self.root / 'relay.token').exists())
        # A rejected archive can be resumed with the complete valid payload.
        self.install()
        other = self.parent / 'alias'
        other.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            install_relay.inspect_root(other, IDENTITY, 18787)


@unittest.skipUnless(os.environ.get('DELTARELAY_RECOVERY_TEST_BINARY'), 'set DELTARELAY_RECOVERY_TEST_BINARY for the real installer test')
class RealInstallerTest(RemoteInstallerTest):
    def test_real_relay_starts_and_resume_preserves_identity(self):
        self.files['deltarelay'] = Path(os.environ['DELTARELAY_RECOVERY_TEST_BINARY']).read_bytes()
        self.files['recover_relay.py'] = (PROJECT / 'deploy/recover_relay.py').read_bytes()
        self.files['upstreams.json'] = (PROJECT / 'configs/upstreams.json').read_bytes()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]

        popen = subprocess.Popen

        def track(*args, **kwargs):
            child = popen(*args, **kwargs)

            def stop_relay():
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()

            self.addCleanup(stop_relay)
            return child

        with patch.object(subprocess, 'Popen', side_effect=track):
            result = install_relay.install(self.root, IDENTITY, port, archive(self.files))
            pid = (self.root / 'server.pid').read_bytes()
            self.assertEqual(result['state_id'], IDENTITY)
            install_relay.install(self.root, IDENTITY, port, archive(self.files))
            self.assertEqual((self.root / 'server.pid').read_bytes(), pid)
