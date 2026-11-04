import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import check_remote_provider
import remote_provider as contract
import supervisor as control
from providers.ssh import SSHProvider


# Deliberately independent of the runner: the same contract works in any language.
PLUGIN = '''import json, os, signal, subprocess, sys, time
request = json.load(sys.stdin)
config = json.load(open(request['config_file']))
method = request['method']
with open(config['log'], 'a') as file: file.write(method + '\\n')
mode = config.get('mode')
if mode == 'hang':
    child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'])
    with open(config['child_pid'], 'w') as file: file.write(str(child.pid))
    time.sleep(120)
if mode == 'flood':
    while True: sys.stdout.write('x' * 65536); sys.stdout.flush()
if config.get('env_file'):
    with open(config['env_file'], 'w') as file: json.dump(dict(os.environ), file)
response = {'protocol_version': 1, 'id': request['id']}
if config.get('error_method') == method:
    response['error'] = {'code': config['error_code'], 'retryable': config.get('retryable', False)}
else:
    state_file = config['state_file']
    state = open(state_file).read()
    if method == 'describe': result = {'id': 'test_host', 'label': 'Custom VPS', 'capabilities': config.get('capabilities', [])}
    elif method == 'connection': result = config.get('connection', {'relay_url': config['relay_url']})
    elif method == 'status': result = {'host_state': state}
    elif method in ('host.wake', 'host.stop'):
        if method == 'host.stop' and config.get('settings_file'):
            assert json.load(open(config['settings_file'])) == {'auto_reconnect': False, 'auto_wake': False}
        state = 'running' if method == 'host.wake' else 'stopped'
        with open(state_file, 'w') as file: file.write(state)
        result = {'host_state': 'stopping' if config.get('async_stop') and method == 'host.stop' else state}
    else: result = {'state_id': config.get('result_identity', request['params']['expected_state_id'])}
    response['result'] = config.get('result', result)
if mode == 'wrong_id': response['id'] = 'other'
if mode == 'version': response['protocol_version'] = 99
if mode == 'bool_version': response['protocol_version'] = True
if mode == 'extra': response['diagnostic'] = 'private-secret'
if mode == 'both': response['error'] = {'code': 'unreachable', 'retryable': True}
body = json.dumps(response)
if mode == 'duplicate': body = body[:-1] + ', "id": ' + json.dumps(request['id']) + '}'
if mode == 'trailing': body += '{}'
if mode == 'banner': body = 'private-secret\\n' + body
print(body)
'''


class ProviderTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plugin = self.root / 'plugin.py'
        self.plugin.write_text(PLUGIN)
        self.log = self.root / 'operations'
        self.state = self.private('host.state', 'running')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.url = f'http://127.0.0.1:{listener.getsockname()[1]}'
        self.config = {'relay_url': self.url, 'state_file': str(self.state), 'log': str(self.log),
                       'capabilities': list(contract.CAPABILITIES)}
        self.path = self.private('provider.json', json.dumps(self.config))
        self.spec = {'command': [sys.executable, '-B', str(self.plugin)], 'config_file': str(self.path)}
        self.cancel = threading.Event()

    def private(self, name, value):
        path = self.root / name
        path.write_text(value)
        path.chmod(0o600)
        return path

    def write_config(self, **changes):
        self.config.update(changes)
        self.path.write_text(json.dumps(self.config))

    def client(self):
        return contract.ExecutableProvider(self.spec, self.url, self.cancel)

    def subject(self):
        config = {'version': 1, 'profile': str(self.root), 'relay_url': self.url, 'gateway_url': 'http://127.0.0.1:8788',
                  'relay_token_file': str(self.private('relay.token', 'private-relay-secret')),
                  'local_token_file': str(self.private('local.token', 'private-local-secret')),
                  'relay_state_file': str(self.private('identity.json', json.dumps('a' * 64))),
                  'remote': self.spec, 'components': {}}
        result = control.Supervisor(config)
        self.addCleanup(result.close)
        return result

    def methods(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_external_provider_and_read_only_conformance_check(self):
        result = check_remote_provider.check({'remote': self.spec, 'relay_url': self.url})
        self.assertEqual(result['id'], 'test_host')
        self.assertEqual(result['host_state'], 'running')
        self.assertEqual(set(self.methods()), {'describe', 'connection', 'status'})
        self.assertFalse(result['tunnel'])

    def test_invalid_envelopes_are_rejected_without_exposing_diagnostics(self):
        for mode in ('wrong_id', 'version', 'bool_version', 'extra', 'both', 'duplicate', 'trailing', 'banner', 'flood'):
            with self.subTest(mode=mode):
                self.write_config(mode=mode)
                with self.assertRaises(contract.ProviderError) as error:
                    self.client().prepare()
                self.assertIn(str(error.exception), ('invalid_provider_response', 'provider_version_mismatch'))
                self.assertNotIn('private-secret', str(error.exception))

    def test_result_schemas_and_connection_policy_are_strict(self):
        for result in ({'id': 'bad id', 'label': 'Host', 'capabilities': []},
                       {'id': 'host', 'label': 'Host\nsecret', 'capabilities': []},
                       {'id': 'host', 'label': 'Host', 'capabilities': ['host.wake', 'host.wake']},
                       {'id': 'host', 'label': 'Host', 'capabilities': ['shell']}):
            self.write_config(result=result)
            with self.assertRaisesRegex(contract.ProviderError, 'invalid_provider_response'):
                self.client().prepare()
        self.config.pop('result')
        for connection in ({'relay_url': 'http://public.example.com'}, {'relay_url': 'https://user:password@example.com'},
                           {'relay_url': 'https://example.com/?token=secret'}, {'relay_url': 'https://example.com/path'},
                           {'relay_url': self.url, 'tunnel': {'command': ['ssh'], 'port': 8787}},
                           {'relay_url': self.url, 'tunnel': {'command': ['/usr/bin/ssh'], 'port': 1}}):
            self.write_config(connection=connection)
            with self.assertRaisesRegex(contract.ProviderError, 'invalid_provider_response'):
                self.client().prepare()
        self.write_config(connection={'relay_url': 'https://other.example.com'})
        with self.assertRaisesRegex(contract.ProviderError, 'configuration_error'):
            self.client().prepare()

    def test_capabilities_and_parameters_gate_calls_before_execution(self):
        self.write_config(capabilities=[])
        client = self.client()
        client.prepare()
        before = self.methods()
        for method, params in (('host.stop', {}), ('relay.ensure', {'expected_state_id': 'a' * 64}),
                               ('shell', {}), ('status', {'command': ['evil']})):
            with self.assertRaises(contract.ProviderError):
                client.call(method, params)
        self.assertEqual(self.methods(), before)
        subject = self.subject()
        subject.prepare_provider()
        with self.assertRaisesRegex(contract.ProviderError, 'unsupported_operation'):
            subject.update_settings({'auto_reconnect': True, 'auto_wake': True})
        with self.assertRaisesRegex(contract.ProviderError, 'invalid_action'):
            subject.submit({'component': 'remote', 'action': 'stop', 'confirmed': True})

    def test_error_codes_are_fixed_and_retry_classification_cannot_be_overridden(self):
        for code, retryable, wanted in (('unreachable', True, 'unreachable'),
                                       ('authentication_failed', False, 'authentication_failed'),
                                       ('identity_mismatch', True, 'invalid_provider_response'),
                                       ('private-secret', False, 'invalid_provider_response')):
            self.write_config(error_method='describe', error_code=code, retryable=retryable)
            with self.assertRaisesRegex(contract.ProviderError, '^' + wanted + '$'):
                self.client().prepare()

    def test_private_configuration_is_checked_before_launch(self):
        self.path.chmod(0o644)
        with self.assertRaisesRegex(contract.ProviderError, 'unsafe_private_file'):
            self.client().prepare()
        self.path.chmod(0o600)
        alias = self.root / 'alias'
        alias.symlink_to(self.path)
        self.spec['config_file'] = str(alias)
        with self.assertRaisesRegex(contract.ProviderError, 'configuration_error'):
            self.client().prepare()
        fifo = self.root / 'fifo'
        os.mkfifo(fifo, 0o600)
        self.spec['config_file'] = str(fifo)
        with self.assertRaisesRegex(contract.ProviderError, 'unsafe_private_file'):
            self.client().prepare()
        self.assertFalse(self.log.exists())

    def test_ambient_credentials_are_not_inherited_and_opt_in_is_explicit(self):
        self.write_config(env_file=str(self.root / 'env'))
        values = {'GH_TOKEN': 'gh-secret', 'AWS_ACCESS_KEY_ID': 'aws-id', 'AWS_SECRET_ACCESS_KEY': 'aws-secret',
                  'OPENAI_API_KEY': 'provider-secret', 'OPENCODE_SERVER_PASSWORD': 'service-secret', 'CUSTOM_ALLOWED': 'explicit'}
        with patch.dict(os.environ, values):
            self.client().prepare()
            env = json.loads((self.root / 'env').read_text())
            self.assertTrue(all(key not in env for key in values))
            self.spec['pass_env'] = ['CUSTOM_ALLOWED', 'GH_TOKEN']
            self.client().prepare()
            env = json.loads((self.root / 'env').read_text())
            self.assertEqual(env['CUSTOM_ALLOWED'], 'explicit')
            self.assertEqual(env['GH_TOKEN'], 'gh-secret')
            self.assertNotIn('AWS_ACCESS_KEY_ID', env)

    def test_timeout_and_cancellation_reap_plugin_process_groups(self):
        for cancelled, wanted in ((False, 'provider_timeout'), (True, 'operation_cancelled')):
            with self.subTest(cancelled=cancelled):
                pid_file = self.root / 'child.pid'
                self.write_config(mode='hang', child_pid=str(pid_file))
                self.spec['timeout_seconds'] = 1
                self.cancel.clear()
                timer = threading.Timer(0.3, self.cancel.set) if cancelled else None
                if timer: timer.start()
                try:
                    with self.assertRaisesRegex(contract.ProviderError, wanted):
                        self.client().prepare()
                finally:
                    if timer: timer.join()
                pid = int(pid_file.read_text())
                deadline = time.monotonic() + 2
                while control.process(pid) is not None and time.monotonic() < deadline:
                    threading.Event().wait(0.01)
                self.assertIsNone(control.process(pid), 'plugin left a running descendant')

    def test_constructor_does_not_launch_plugin_and_snapshot_contains_only_safe_metadata(self):
        subject = self.subject()
        self.assertFalse(self.log.exists(), 'local controls must start before plugin execution')
        original = json.dumps(subject.config, sort_keys=True)
        subject.prepare_provider()
        snapshot = subject.snapshot()
        self.assertEqual(snapshot['version'], 2)
        self.assertEqual(snapshot['remote']['id'], 'test_host')
        self.assertNotIn('codespace_state', snapshot)
        self.assertNotIn('private-relay-secret', json.dumps(snapshot))
        self.assertNotIn(str(self.path), json.dumps(snapshot))
        self.assertEqual(json.dumps(subject.config, sort_keys=True), original)

    def test_plugin_success_never_substitutes_for_authenticated_relay_health(self):
        subject = self.subject()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), patch.object(subject.stop, 'wait', return_value=False):
            with self.assertRaisesRegex(contract.ProviderError, '^unreachable$'):
                subject.recover()
        self.assertIn('relay.ensure', self.methods())
        self.assertIsNone(subject.recovery['last_connected_at'])

    def test_missing_pin_and_permanent_health_failures_never_dispatch_mutations(self):
        subject = self.subject()
        for state in ('authentication_failed', 'tls_verification_failed', 'identity_mismatch', 'protocol_mismatch'):
            with patch.object(subject, 'probe', return_value=state):
                with self.assertRaisesRegex(contract.ProviderError, state):
                    subject.remote(wake=True, restart=True)
        Path(subject.config['relay_state_file']).unlink()
        with patch.object(subject, 'probe', return_value='unreachable'):
            with self.assertRaisesRegex(contract.ProviderError, 'identity_unavailable'):
                subject.remote(wake=True)
        self.assertFalse(set(self.methods()) & set(contract.CAPABILITIES))

    def test_manual_power_requires_capability_and_confirmation_and_stop_persists_pause(self):
        subject = self.subject()
        subject.prepare_provider()
        for action in ('wake', 'stop'):
            with self.assertRaisesRegex(contract.ProviderError, 'confirmation_required'):
                subject.submit({'component': 'remote', 'action': action})
        self.write_config(settings_file=str(subject.directory / 'settings.json'), async_stop=True)
        with patch.object(subject.stop, 'wait', return_value=False):
            subject.submit({'component': 'remote', 'action': 'stop', 'confirmed': True})
            self.assertTrue(subject.operation.acquire(timeout=5))
            subject.operation.release()
        self.assertEqual(subject.host_state, 'stopped')
        self.assertEqual(self.subject().settings, {'auto_reconnect': False, 'auto_wake': False})
        self.assertEqual(json.loads(Path(subject.config['relay_state_file']).read_text()), 'a' * 64)

    def test_failed_stop_does_not_claim_shutdown_or_reenable_recovery(self):
        subject = self.subject()
        subject.prepare_provider()
        self.write_config(error_method='host.stop', error_code='unreachable', retryable=True)
        with self.assertRaisesRegex(contract.ProviderError, '^unreachable$'):
            subject.stop_host()
        self.assertEqual(subject.host_state, 'unknown')
        self.assertEqual(self.subject().settings, {'auto_reconnect': False, 'auto_wake': False})

    def test_stopped_host_is_never_woken_indirectly_through_tunnel_recovery(self):
        self.state.write_text('stopped')
        port = int(self.url.rsplit(':', 1)[1])
        self.write_config(connection={'relay_url': self.url, 'tunnel': {
            'command': [sys.executable, '-c', 'raise SystemExit("must not launch")'], 'port': port}})
        subject = self.subject()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart:
            with self.assertRaisesRegex(contract.ProviderError, 'host_stopped'):
                subject.recover(wake=False)
            restart.assert_not_called()
        with self.assertRaisesRegex(contract.ProviderError, 'host_stopped'):
            subject.start_component('tunnel')
        self.assertFalse(subject.children)
        self.assertNotIn('host.wake', self.methods())

    def test_published_schema_matches_runtime_operations_states_and_errors(self):
        path = Path(__file__).resolve().parents[1] / 'docs/remote-provider-v1.schema.json'
        definitions = json.loads(path.read_text())['$defs']
        self.assertEqual(definitions['capability']['enum'], list(contract.CAPABILITIES))
        self.assertEqual(definitions['host_state']['enum'], list(contract.HOST_STATES))
        self.assertEqual(set(definitions['transient_code']['enum']), contract.RETRYABLE)
        self.assertEqual(set(definitions['nontransient_code']['enum']), contract.ERROR_CODES - contract.RETRYABLE)

    def test_permanent_plugin_failure_blocks_automatic_mutations_across_ticks(self):
        subject = self.subject()
        self.write_config(error_method='relay.ensure', error_code='authentication_failed')
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), patch.object(subject.stop, 'wait', return_value=False):
            for _ in range(3): subject.tick()
            self.assertEqual(subject.provider_blocked, 'authentication_failed')
            subject.next_attempt = 0
            for _ in range(4): subject.tick()
        self.assertEqual(self.methods().count('relay.ensure'), 1)
        self.assertEqual(subject.recovery['last_error'], 'authentication_failed')

    def test_permanent_relay_failure_is_not_repaired_if_a_later_probe_is_unreachable(self):
        subject = self.subject()
        with patch.object(subject, 'probe', side_effect=['identity_mismatch'] + ['unreachable'] * 5), \
                patch.object(subject, 'internet_probe', return_value='connected'):
            for _ in range(6): subject.tick()
        self.assertEqual(subject.provider_blocked, 'identity_mismatch')
        self.assertEqual(subject.recovery['last_error'], 'identity_mismatch')
        self.assertFalse(set(self.methods()) & set(contract.CAPABILITIES))

    def test_supervisor_cancellation_finishes_active_provider_job_and_preserves_policies(self):
        subject = self.subject()
        subject.prepare_provider()
        pid_file = self.root / 'active-child.pid'
        self.write_config(mode='hang', child_pid=str(pid_file))
        with patch.object(subject, 'probe', return_value='unreachable'):
            subject.submit({'component': 'remote', 'action': 'wake', 'confirmed': True})
            deadline = time.monotonic() + 3
            while not pid_file.exists() and time.monotonic() < deadline:
                threading.Event().wait(0.01)
            self.assertTrue(pid_file.exists())
            subject.stop.set()
            self.assertTrue(subject.operation.acquire(timeout=5), 'provider job did not finish cancellation')
            subject.operation.release()
        self.assertEqual(subject.recovery['last_error'], 'operation_cancelled')
        self.assertEqual(subject.settings, {'auto_reconnect': True, 'auto_wake': False})
        with self.assertRaisesRegex(contract.ProviderError, 'operation_cancelled'):
            subject.submit({'component': 'all', 'action': 'recover'})

    def test_managed_tunnel_is_owned_by_supervisor_and_config_is_not_rewritten(self):
        port = int(self.url.rsplit(':', 1)[1])
        self.write_config(connection={'relay_url': self.url, 'tunnel': {
            'command': [sys.executable, '-c', 'import time; time.sleep(120)', 'custom-tunnel'], 'port': port}})
        subject = self.subject()
        subject.prepare_provider()
        self.assertNotIn('tunnel', subject.provider.spec)
        subject.start_component('tunnel')
        child = subject.children['tunnel']
        try:
            self.assertEqual(subject._identity('tunnel')['pid'], child.pid)
            self.assertEqual(subject.config['components']['tunnel']['pid_file'], str(subject.directory / 'provider-tunnel.pid'))
            adopted = self.subject()
            adopted.prepare_provider()
            self.assertEqual(adopted._identity('tunnel')['pid'], child.pid)
        finally:
            subject.stop_component('tunnel')
        self.assertIsNotNone(child.poll())


    def bundled(self, name, config):
        self.path.write_text(json.dumps(config))
        self.spec['command'] = [sys.executable, '-B', str(Path(__file__).parent / 'providers' / (name + '.py'))]
        return self.client()

    def test_direct_https_and_standalone_example_work_without_github(self):
        self.url = 'https://relay.example.com:8787'
        client = self.bundled('direct_https', {'relay_url': self.url})
        self.assertEqual(client.prepare(), {'relay_url': self.url})
        self.assertEqual(client.metadata['capabilities'], [])
        self.assertEqual(client.call('status'), {'host_state': 'unknown'})
        self.spec['command'] = [sys.executable, '-B', str(Path(__file__).resolve().parents[1] / 'examples/remote-provider/provider.py')]
        self.assertEqual(self.client().prepare(), {'relay_url': self.url})
        self.assertFalse(self.log.exists())

    def test_bundled_ssh_connection_quotes_commands_and_guards_existing_store(self):
        config = {'host': 'user@example', 'relay_url': self.url, 'remote_port': 8787, 'ssh': '/usr/bin/ssh',
                  'relay_state_file': "/private/store with 'quotes/mailbox/identity.json",
                  'start_command': ['systemctl', '--user', 'start', 'relay.service']}
        client = self.bundled('ssh', config)
        connection = client.prepare()
        self.assertEqual(connection['tunnel']['port'], int(self.url.rsplit(':', 1)[1]))
        self.assertIn('StrictHostKeyChecking=yes', connection['tunnel']['command'])
        self.assertEqual(client.call('status'), {'host_state': 'unknown'})
        self.assertEqual(client.metadata['capabilities'], ['relay.ensure'])
        with patch('providers.ssh.provider_command') as run:
            # Pass the mock explicitly: the constructor default is bound at import.
            provider = SSHProvider(config, run=run)
            run.return_value = b'mismatch'
            with self.assertRaisesRegex(contract.ProviderError, '^identity_mismatch$'):
                provider.call('relay.ensure', {'expected_state_id': 'a' * 64})
            self.assertEqual(run.call_count, 1, 'service command ran despite a changed/missing store')
            run.reset_mock()
            run.side_effect = [b'match', b'']
            self.assertEqual(provider.call('relay.ensure', {'expected_state_id': 'a' * 64}), {'state_id': 'a' * 64})
            self.assertIn('test ! -L', run.call_args_list[0].args[0][-1])
            self.assertIn('&& exec systemctl --user start relay.service', run.call_args_list[1].args[0][-1])
        config.pop('relay_state_file')
        with self.assertRaisesRegex(contract.ProviderError, 'invalid_configuration'):
            SSHProvider(config)

    def test_ssh_guard_uses_exact_pinned_identity_before_starting_service(self):
        identity = self.private('remote identity.json', json.dumps('a' * 64) + '\n')
        marker = self.root / 'started'
        config = {'host': 'user@example', 'relay_url': self.url, 'relay_state_file': str(identity),
                  'start_command': [sys.executable, '-c', 'from pathlib import Path; Path(' + repr(str(marker)) + ').touch()']}

        def local_ssh(command, **kwargs):
            return contract.run_command(['/bin/sh', '-c', command[-1]], **kwargs)

        provider = SSHProvider(config, run=local_ssh)
        provider.call('relay.ensure', {'expected_state_id': 'a' * 64})
        self.assertTrue(marker.exists())
        marker.unlink()
        identity.write_text(json.dumps('b' * 64))
        with self.assertRaisesRegex(contract.ProviderError, 'identity_mismatch'):
            provider.call('relay.ensure', {'expected_state_id': 'a' * 64})
        self.assertFalse(marker.exists())

    def test_bundled_codespaces_implements_contract_through_mock_cli(self):
        gh = self.root / 'gh'
        gh_log = self.root / 'gh-operations'
        gh.write_text('#!' + sys.executable + '\n' + '''import json, pathlib, sys
state = pathlib.Path(''' + repr(str(self.state)) + ''')
with open(''' + repr(str(gh_log)) + ''', 'a') as file: file.write(' '.join(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'api':
    if 'GET' in sys.argv: print(json.dumps({'state': state.read_text()}))
    elif sys.argv[-2].endswith('/start'): state.write_text('Available')
    elif sys.argv[-2].endswith('/stop'): state.write_text('Shutdown')
else:
    sys.stdin.read()
    print(json.dumps({'state_id': 'a' * 64}))
''')
        gh.chmod(0o700)
        self.state.write_text('Shutdown')
        client = self.bundled('codespaces', {'name': 'existing-host', 'relay_url': self.url,
                                          'remote_directory': '~/existing-relay', 'github_cli': str(gh)})
        client.prepare()
        self.assertEqual(client.call('status'), {'host_state': 'stopped'})
        with self.assertRaisesRegex(contract.ProviderError, 'host_stopped'):
            client.call('relay.ensure', {'expected_state_id': 'a' * 64})
        self.assertNotIn('/start', gh_log.read_text())
        # Already-running/stopped transitions do not need a polling delay.
        self.state.write_text('Available')
        self.assertEqual(client.call('host.wake'), {'host_state': 'running'})
        self.assertEqual(client.call('relay.ensure', {'expected_state_id': 'a' * 64}), {'state_id': 'a' * 64})
        self.state.write_text('Shutdown')
        self.assertEqual(client.call('host.stop'), {'host_state': 'stopped'})


if __name__ == '__main__':
    unittest.main()
