import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from unittest.mock import patch

import start_supervisor
import supervisor as control
import supervision.supervisor as supervisor_impl


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            relay_url = f'http://127.0.0.1:{listener.getsockname()[1]}'
        for name, value in [('relay.token', 'relay-secret'), ('local.token', 'local-secret'), ('identity.json', json.dumps('a' * 64))]:
            path = self.root / name
            path.write_text(value)
            path.chmod(0o600)
        self.config = {'version': 1, 'profile': str(self.root), 'relay_url': relay_url,
                       'gateway_url': 'http://127.0.0.1:18788', 'relay_token_file': str(self.root / 'relay.token'),
                       'local_token_file': str(self.root / 'local.token'), 'relay_state_file': str(self.root / 'identity.json'),
                       'components': {}}

    def supervisor(self):
        result = control.Supervisor(self.config)
        self.addCleanup(result.stop.set)
        return result

    def component(self, name, command=None):
        command = command or [sys.executable, '-c', 'import time; time.sleep(120)', name]
        self.config['components'][name] = {'command': command, 'pid_file': str(self.root / (name + '.pid'))}

    def wait_job(self, subject):
        self.assertTrue(subject.operation.acquire(timeout=5), 'background operation did not complete')
        subject.operation.release()

    def test_settings_persist_and_do_not_silently_enable_billing(self):
        subject = self.supervisor()
        self.assertEqual(subject.settings, {'auto_reconnect': True, 'auto_wake': False})
        subject.update_settings({'auto_reconnect': False, 'auto_wake': True})
        self.assertEqual(self.supervisor().settings, {'auto_reconnect': False, 'auto_wake': True})
        self.assertEqual((subject.directory / 'settings.json').stat().st_mode & 0o777, 0o600)
        for value in ({'auto_wake': True}, {'auto_reconnect': 'false', 'auto_wake': False}, {'auto_reconnect': True, 'auto_wake': False, 'command': 'evil'}):
            with self.assertRaises(control.ControlError):
                subject.update_settings(value)
        self.assertNotIn('relay-secret', json.dumps(subject.snapshot()))

    def test_corrupt_settings_and_symlink_fail_closed(self):
        subject = self.supervisor()
        (subject.directory / 'settings.json').write_text('{broken')
        (subject.directory / 'settings.json').chmod(0o600)
        with self.assertRaises(ValueError):
            self.supervisor()
        with self.assertRaises(OSError):
            path = self.root / 'alias.json'
            path.symlink_to(self.root / 'identity.json')
            control.private_json(path)

    def test_health_probe_checks_auth_identity_protocol_and_tls(self):
        subject = self.supervisor()

        class Response:
            def __init__(self, data): self.data = data
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return json.dumps(self.data).encode()

        for data, want in [({'version': 2, 'state_id': 'a' * 64, 'forwarding': True}, 'connected'),
                           ({'version': 2, 'state_id': 'b' * 64, 'forwarding': True}, 'identity_mismatch'),
                           ({'version': 1}, 'protocol_mismatch'),
                           ({'version': 2, 'state_id': 'a' * 64, 'forwarding': False}, 'forwarding_disabled')]:
            with patch.object(subject.opener, 'open', return_value=Response(data)) as request:
                self.assertEqual(subject.probe(), want)
                self.assertEqual(request.call_args.args[0].get_header('Authorization'), 'Bearer relay-secret')
        for error, want in [(urllib.error.URLError(ConnectionRefusedError()), 'unreachable'),
                            (urllib.error.URLError(ssl.SSLCertVerificationError()), 'tls_verification_failed'),
                            (urllib.error.HTTPError('http://localhost', 401, '', {}, None), 'authentication_failed')]:
            with patch.object(subject.opener, 'open', side_effect=error):
                self.assertEqual(subject.probe(), want)

    def test_internet_check_distinguishes_offline_computer_from_down_vps(self):
        subject = self.supervisor()

        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return b''

        def internet_error(kind):
            if kind == 'offline':
                return urllib.error.URLError(socket.gaierror(-3, 'Temporary failure in name resolution'))
            return None

        for kind, want in [('online', 'connected'), ('offline', 'unreachable')]:
            error = internet_error(kind)
            def open_(request, timeout=0, error=error):
                if error:
                    raise error
                return Response()
            subject.internet_state = 'unknown'
            subject.internet_next = 0
            with patch.object(subject.opener, 'open', side_effect=open_):
                subject.update_internet('unreachable')
            self.assertEqual(subject.internet_state, want)
            self.assertIsNotNone(subject.internet_checked_at)

        # Repeated checks are cached, and a reachable relay confirms internet
        # without generating extra external traffic.
        subject.internet_state = 'connected'
        subject.internet_next = time.monotonic() + 60
        with patch.object(subject.opener, 'open') as opened:
            subject.update_internet('unreachable')
            opened.assert_not_called()
        subject.internet_state = 'unreachable'
        with patch.object(subject.opener, 'open') as opened:
            subject.update_internet('connected')
            opened.assert_not_called()
        self.assertEqual(subject.internet_state, 'connected')
        self.assertIn('internet_state', subject.snapshot())

    def test_hung_live_tunnel_is_rebuilt_without_restarting_gateway_or_relay(self):
        self.component('tunnel')
        self.component('gateway')
        subject = self.supervisor()
        with patch.object(subject, 'probe', side_effect=['unreachable', 'connected']), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'start_component') as start, \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'remote') as remote, patch.object(subject.stop, 'wait', return_value=False):
            subject.recover()
        restart.assert_called_once_with('tunnel')
        remote.assert_not_called()
        start.assert_called_once_with('gateway')
        self.assertEqual(subject.relay_state, 'connected')
        self.assertIsNotNone(subject.recovery['last_connected_at'])

    def test_slow_tunnel_gets_time_to_connect_before_remote_recovery(self):
        self.component('tunnel')
        subject = self.supervisor()
        with patch.object(subject, 'probe', side_effect=['unreachable'] * 3 + ['connected']), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'remote') as remote, patch.object(subject.stop, 'wait', return_value=False):
            subject.recover()
        restart.assert_called_once_with('tunnel')
        remote.assert_not_called()
        self.assertEqual(subject.relay_state, 'connected')

    def test_remote_recovery_reopens_tunnel_that_died_while_relay_was_down(self):
        self.component('tunnel')
        subject = self.supervisor()
        remote_ready = False
        restarts = []

        def restart(name):
            restarts.append((name, remote_ready))

        def remote(wake=False):
            nonlocal remote_ready
            remote_ready = True

        def probe():
            return 'connected' if restarts and restarts[-1][1] else 'unreachable'

        with patch.object(subject, 'probe', side_effect=probe), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component', side_effect=restart), \
                patch.object(subject, 'remote', side_effect=remote), patch.object(subject.stop, 'wait', return_value=False):
            subject.recover()
        self.assertEqual(restarts, [('tunnel', False), ('tunnel', True)])
        self.assertEqual(subject.relay_state, 'connected')

    def test_remote_command_success_does_not_mean_connection_recovered(self):
        subject = self.supervisor()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'remote') as remote, patch.object(subject.stop, 'wait', return_value=False):
            with self.assertRaisesRegex(control.ControlError, '^unreachable$'):
                subject.recover()
        remote.assert_called_once_with(wake=False)
        self.assertIsNone(subject.recovery['last_connected_at'])

    def test_permanent_failure_after_tunnel_reconnect_blocks_remote_changes(self):
        self.component('tunnel')
        subject = self.supervisor()
        for error in ('identity_mismatch', 'authentication_failed', 'protocol_mismatch', 'tls_verification_failed'):
            subject.provider_blocked = ''
            with self.subTest(error=error), \
                    patch.object(subject, 'probe', side_effect=['unreachable', error]), \
                    patch.object(subject, 'internet_probe', return_value='connected'), \
                    patch.object(subject, 'restart_component') as restart, \
                    patch.object(subject, 'remote') as remote, patch.object(subject.stop, 'wait', return_value=False):
                with self.assertRaisesRegex(control.ControlError, error):
                    subject.recover()
                restart.assert_called_once_with('tunnel')
                remote.assert_not_called()

    def test_permanent_failures_never_trigger_automatic_restarts(self):
        subject = self.supervisor()
        for error in ('identity_mismatch', 'authentication_failed', 'protocol_mismatch', 'tls_verification_failed'):
            with patch.object(subject, 'probe', return_value=error), patch.object(subject, 'recover') as recover:
                for _ in range(4): subject.tick()
                recover.assert_not_called()
                self.assertEqual(subject.recovery['last_error'], error)

    def test_automatic_recovery_debounces_and_respects_disabled_setting(self):
        subject = self.supervisor()
        with patch.object(subject, 'probe', return_value='unreachable'), patch.object(subject, 'internet_probe', return_value='connected'), patch.object(subject, 'recover') as recover:
            subject.tick()
            subject.tick()
            recover.assert_not_called()
            subject.tick()
            recover.assert_called_once_with(wake=False)
            subject.tick()
            self.assertEqual(recover.call_count, 1, 'backoff was ignored')
            subject.update_settings({'auto_reconnect': False, 'auto_wake': True})
            subject.tick()
            self.assertEqual(recover.call_count, 1)

    def test_recovery_error_survives_generic_probes_until_connection_returns(self):
        subject = self.supervisor()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'recover', side_effect=control.ControlError('codespace_ssh_timeout')):
            for _ in range(3): subject.tick()
            self.assertEqual(subject.recovery['last_error'], 'codespace_ssh_timeout')
            self.assertEqual(subject.recovery['phase'], 'monitoring')
            subject.next_attempt = float('inf')
            for _ in range(3): subject.tick()
            self.assertEqual(subject.recovery['last_error'], 'codespace_ssh_timeout')
        with patch.object(subject, 'probe', return_value='connected'):
            subject.tick()
        self.assertEqual(subject.recovery['last_error'], '')
        self.assertIsNone(subject.recovery['next_retry_at'])

    def test_successful_automatic_recovery_updates_status_without_backoff(self):
        self.component('tunnel')
        subject = self.supervisor()
        with patch.object(subject, 'probe', side_effect=['unreachable'] * 4 + ['connected']), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, '_identity', return_value={'pid': 123}), \
                patch.object(subject, 'restart_component'), patch.object(subject.stop, 'wait', return_value=False):
            for _ in range(3): subject.tick()
        status = subject.snapshot()
        self.assertEqual(status['relay_state'], 'connected')
        self.assertEqual(status['recovery']['attempts'], 1)
        self.assertFalse(status['recovery']['busy'])
        self.assertEqual(status['recovery']['phase'], 'monitoring')
        self.assertIsNone(status['recovery']['next_retry_at'])
        self.assertIsNotNone(status['recovery']['last_connected_at'])

    def test_codespace_ssh_failures_have_safe_specific_error_codes(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        subject = self.supervisor()
        for error, want in [('command_failed', 'relay_recovery_failed'), ('command_timeout', 'relay_ssh_timeout')]:
            with self.subTest(error=error), patch.object(supervisor_impl, 'run_command', side_effect=[
                    b'{"state":"Available"}', control.ControlError(error)]):
                with self.assertRaisesRegex(control.ControlError, '^' + want + '$'):
                    subject.remote()

    def test_private_codespace_cli_is_used_for_status_wake_and_ssh(self):
        binary = str(self.root / 'tools/gh')
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay', 'github_cli': binary}
        subject = self.supervisor()
        with patch.object(supervisor_impl, 'run_command', side_effect=[b'{"state":"Shutdown"}', b'',
                b'{"state":"Available"}', b'{"state":"Available"}', json.dumps({'state_id': 'a' * 64}).encode()]) as run, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.remote(wake=True)
        self.assertEqual(len(run.call_args_list), 5)
        self.assertTrue(all(call.args[0][0] == binary for call in run.call_args_list))

    def test_codespace_cli_override_requires_an_absolute_executable_path(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        for value in ('gh', '../gh', '', None, [], '/tmp/gh\0bad'):
            with self.subTest(value=value):
                self.config['codespace']['github_cli'] = value
                with self.assertRaisesRegex(control.ControlError, 'invalid_codespace'):
                    control.validate(self.config)

    def test_stopped_codespace_only_wakes_with_explicit_permission(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        subject = self.supervisor()
        with patch.object(supervisor_impl, 'run_command', return_value=b'{"state":"Shutdown"}') as run:
            with self.assertRaisesRegex(control.ControlError, 'host_stopped'):
                subject.remote()
            self.assertEqual(run.call_count, 1)
        for automatic in (False, True):
            subject.update_settings({'auto_reconnect': True, 'auto_wake': automatic})
            with patch.object(subject, 'remote') as remote, patch.object(subject, 'recover') as recover:
                subject.submit({'component': 'codespace', 'action': 'wake', 'confirmed': True})
                self.wait_job(subject)
                remote.assert_called_once_with(wake=True)
                recover.assert_called_once()
        with patch.object(supervisor_impl, 'run_command', side_effect=[b'{"state":"Shutdown"}', b'', b'{"state":"Available"}', b'{"state":"Available"}', json.dumps({'state_id': 'a' * 64}).encode()]) as run, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.remote(wake=True)
            self.assertIn('/user/codespaces/test-codespace/start', run.call_args_list[1].args[0])

    def test_codespace_stop_requires_confirmation_and_a_configured_codespace(self):
        subject = self.supervisor()
        with self.assertRaisesRegex(control.ControlError, '^invalid_action$'):
            subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': True})
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        subject = self.supervisor()
        with patch.object(supervisor_impl, 'run_command') as run:
            for confirmed in (None, False, 'true', 1):
                with self.assertRaisesRegex(control.ControlError, '^confirmation_required$'):
                    subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': confirmed})
            for name in (*control.COMPONENTS, 'all'):
                with self.assertRaisesRegex(control.ControlError, '^invalid_action$'):
                    subject.submit({'component': name, 'action': 'stop', 'confirmed': True})
            subject.operation.acquire()
            try:
                with self.assertRaisesRegex(control.ControlError, '^operation_in_progress$'):
                    subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': True})
            finally:
                subject.operation.release()
            run.assert_not_called()
        self.assertEqual(subject.settings, {'auto_reconnect': True, 'auto_wake': False})

    def test_codespace_stop_persists_recovery_pause_and_waits_for_shutdown(self):
        binary = str(self.root / 'tools/gh')
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay', 'github_cli': binary}
        self.component('tunnel')
        self.component('gateway')
        subject = self.supervisor()
        subject.update_settings({'auto_reconnect': True, 'auto_wake': True})
        subject.relay_state = 'connected'
        subject.state.update_recovery(next_retry_at=control.stamp())
        outputs = iter([b'{"state":"Available"}', b'', b'{"state":"ShuttingDown"}', b'{"state":"Shutdown"}'])

        def command(_, **kwargs):
            self.assertEqual(control.private_json(subject.directory / 'settings.json'),
                             {'auto_reconnect': False, 'auto_wake': False})
            stopped.assert_called_once_with('tunnel')
            self.assertTrue(subject.snapshot()['recovery']['busy'])
            return next(outputs)

        with patch.object(subject, 'stop_component') as stopped, \
                patch.object(supervisor_impl, 'run_command', side_effect=command) as run, \
                patch.object(subject.stop, 'wait', return_value=False), \
                patch.object(subject, 'start_component') as start, patch.object(subject, 'recover') as recover:
            subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': True})
            self.wait_job(subject)
            self.assertEqual([call.args[0] for call in run.call_args_list], [
                [binary, 'api', '--method', 'GET', '/user/codespaces/test-codespace', '--jq', '{state: .state}'],
                [binary, 'api', '--method', 'POST', '/user/codespaces/test-codespace/stop', '--silent'],
                [binary, 'api', '--method', 'GET', '/user/codespaces/test-codespace', '--jq', '{state: .state}'],
                [binary, 'api', '--method', 'GET', '/user/codespaces/test-codespace', '--jq', '{state: .state}'],
            ])
            status = subject.snapshot()
            self.assertEqual(status['remote']['host_state'], 'stopped')
            self.assertEqual(status['relay_state'], 'unreachable')
            self.assertEqual(subject.states['relay'], 'stopped')
            self.assertEqual(status['recovery']['last_error'], 'host_stopped')
            self.assertFalse(status['recovery']['busy'])
            self.assertIsNone(status['recovery']['next_retry_at'])
            self.assertEqual(self.supervisor().settings, {'auto_reconnect': False, 'auto_wake': False})
            with patch.object(subject, 'probe', return_value='unreachable'), \
                    patch.object(subject.provider, 'call', return_value={'host_state': 'stopped'}), \
                    patch.object(subject, 'internet_probe', return_value='connected'):
                for _ in range(4): subject.tick()
            recover.assert_not_called()
            start.assert_not_called()
            self.assertEqual(subject.states['relay'], 'stopped')
            self.assertEqual(subject.recovery['last_error'], 'host_stopped')
        # Manual wake remains available, but never silently restores the policies.
        with patch.object(subject, 'remote') as remote, patch.object(subject, 'recover') as recover:
            subject.submit({'component': 'codespace', 'action': 'wake', 'confirmed': True})
            self.wait_job(subject)
            remote.assert_called_once_with(wake=True)
            recover.assert_called_once()
        self.assertEqual(subject.settings, {'auto_reconnect': False, 'auto_wake': False})
        self.assertEqual((self.root / 'identity.json').read_text(), json.dumps('a' * 64))
        self.assertEqual((self.root / 'relay.token').read_text(), 'relay-secret')

    def test_codespace_stop_is_idempotent_for_stopped_or_stopping_codespaces(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        for state in ('Shutdown', 'ShuttingDown'):
            with self.subTest(state=state):
                subject = self.supervisor()
                with patch.object(supervisor_impl, 'run_command', side_effect=[json.dumps({'state': state}).encode(),
                        b'{"state":"Shutdown"}']) as run, patch.object(subject.stop, 'wait', return_value=False):
                    subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': True})
                    self.wait_job(subject)
                self.assertTrue(all(call.args[0][3] == 'GET' for call in run.call_args_list))
                self.assertEqual(subject.host_state, 'stopped')

    def test_failed_codespace_stop_keeps_recovery_disabled_and_does_not_claim_shutdown(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        for error in ('command_failed', 'command_timeout'):
            with self.subTest(error=error):
                subject = self.supervisor()
                subject.host_state = 'running'
                subject.update_settings({'auto_reconnect': True, 'auto_wake': True})
                with patch.object(supervisor_impl, 'run_command', side_effect=[b'{"state":"Available"}', control.ControlError(error)]):
                    subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': True})
                    self.wait_job(subject)
                self.assertEqual(subject.recovery['last_error'], error)
                self.assertEqual(subject.host_state, 'running')
                self.assertFalse(subject.recovery['busy'])
                self.assertEqual(self.supervisor().settings, {'auto_reconnect': False, 'auto_wake': False})

    def test_codespace_stop_wait_is_bounded_and_cancellable(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        for cancelled, want in ((False, 'host_stop_timeout'), (True, 'operation_cancelled')):
            with self.subTest(cancelled=cancelled):
                subject = self.supervisor()
                with patch.object(supervisor_impl, 'run_command', return_value=b'{"state":"ShuttingDown"}') as run, \
                        patch.object(subject.stop, 'wait', return_value=cancelled), \
                        patch.object(control.time, 'monotonic', side_effect=[0, 121]):
                    with self.assertRaisesRegex(control.ControlError, '^' + want + '$'):
                        subject.stop_host()
                run.assert_called_once()
                self.assertEqual(subject.host_state, 'unknown', 'unconfirmed shutdown must not be claimed')
                self.assertEqual(subject.settings, {'auto_reconnect': False, 'auto_wake': False})

    def test_codespace_stop_stops_owned_tunnel_without_stopping_other_local_services(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        self.component('tunnel')
        self.component('gateway')
        subject = self.supervisor()
        with patch.object(subject.provider, 'call', return_value={'host_state': 'running'}):
            for name in ('tunnel', 'gateway'):
                subject.start_component(name)
                self.addCleanup(self.cleanup_child, subject.children[name])
        with patch.object(supervisor_impl, 'run_command', return_value=b'{"state":"Shutdown"}'):
            subject.submit({'component': 'codespace', 'action': 'stop', 'confirmed': True})
            self.wait_job(subject)
        self.assertIsNotNone(subject.children['tunnel'].poll())
        self.assertIsNone(subject.children['gateway'].poll())
        self.assertEqual(subject.states['tunnel'], 'stopped')
        self.assertEqual(subject.host_state, 'stopped')

    def test_action_schema_confirmation_and_serialization(self):
        subject = self.supervisor()
        for value in ({'component': 'all', 'action': 'restart'}, {'component': 'tunnel', 'action': 'recover'},
                      {'component': 'all', 'action': 'wake'}, {'component': 'codespace', 'action': 'start'},
                      {'component': 'gateway', 'action': 'start', 'command': ['evil']}, []):
            with self.assertRaises(control.ControlError): subject.submit(value)
        subject.operation.acquire()
        try:
            with self.assertRaisesRegex(control.ControlError, 'operation_in_progress'):
                subject.submit({'component': 'all', 'action': 'recover'})
        finally:
            subject.operation.release()

    def test_manual_recover_all_starts_local_services_even_when_remote_is_down(self):
        for name in ('dashboard', 'gateway', 'opencode', 'desktop'): self.component(name)
        subject = self.supervisor()
        with patch.object(subject, 'start_component') as start, \
                patch.object(subject, 'recover', side_effect=control.ControlError('codespace_stopped')):
            subject.submit({'component': 'all', 'action': 'recover'})
            self.wait_job(subject)
        self.assertEqual([call.args[0] for call in start.call_args_list], ['dashboard', 'gateway', 'opencode', 'desktop'])
        self.assertEqual(subject.recovery['last_error'], 'codespace_stopped')

    def test_desktop_start_launches_once_without_restarting_or_recovering_other_services(self):
        self.component('desktop')
        subject = self.supervisor()
        with patch.dict(os.environ, {'DISPLAY': ':test'}), \
                patch.object(subject, 'restart_component') as restart, patch.object(subject, 'recover') as recover, \
                patch.object(subject, 'remote') as remote:
            subject.submit({'component': 'desktop', 'action': 'start'})
            self.wait_job(subject)
            self.assertEqual(subject.recovery['last_error'], '')
            first = subject.children['desktop']
            self.addCleanup(self.cleanup_child, first)
            subject.submit({'component': 'desktop', 'action': 'start'})
            self.wait_job(subject)
            self.assertIs(subject.children['desktop'], first)
            self.assertIsNone(first.poll())
            self.assertEqual(subject.states['desktop'], 'running')
            self.assertEqual(list(subject.children), ['desktop'])
            restart.assert_not_called()
            recover.assert_not_called()
            remote.assert_not_called()

    def test_desktop_start_without_a_graphical_session_reports_a_safe_error(self):
        self.component('desktop')
        subject = self.supervisor()
        with patch.dict(os.environ, {'DISPLAY': '', 'WAYLAND_DISPLAY': ''}):
            subject.submit({'component': 'desktop', 'action': 'start'})
            self.wait_job(subject)
        self.assertEqual(subject.recovery['last_error'], 'graphical_session_required')
        self.assertFalse(subject.children)

    def test_real_owned_process_is_adopted_and_restarted_without_signaling_unrelated_process(self):
        self.component('tunnel')
        subject = self.supervisor()
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
        self.addCleanup(lambda: self.cleanup_child(unrelated))
        subject.start_component('tunnel')
        first = subject.children['tunnel']
        self.addCleanup(lambda: self.cleanup_child(subject.children['tunnel']))
        self.assertEqual(subject._identity('tunnel')['pid'], first.pid)
        adopted = self.supervisor()
        self.assertEqual(adopted._identity('tunnel')['pid'], first.pid)
        subject.restart_component('tunnel')
        self.assertNotEqual(subject.children['tunnel'].pid, first.pid)
        first.wait(timeout=3)
        self.assertIsNone(unrelated.poll())
        (self.root / 'tunnel.pid').write_text(str(unrelated.pid))
        self.assertIsNone(subject._identity('tunnel'), 'unrelated PID was accepted')
        self.assertEqual((subject.directory / 'tunnel.log').stat().st_mode & 0o777, 0o600)

    @staticmethod
    def cleanup_child(child):
        if child.poll() is None: child.terminate()
        child.wait(timeout=5)

    def test_unknown_port_owner_is_never_replaced(self):
        self.component('tunnel')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            self.config['components']['tunnel']['port'] = listener.getsockname()[1]
            subject = self.supervisor()
            with self.assertRaisesRegex(control.ControlError, 'unrecognized_port_owner'):
                subject.start_component('tunnel')
            self.assertFalse(subject.children)

    def test_unix_socket_snapshot_and_settings_api(self):
        subject = self.supervisor()
        path = subject.directory / 'test.sock'
        with control.Server(str(path), control.Handler) as server:
            server.supervisor = subject
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            self.addCleanup(server.shutdown)
            status = start_supervisor.controller_status(path)
            self.assertTrue(status['managed'])
            connection = http.client.HTTPConnection('localhost')
            connection.sock = socket.socket(socket.AF_UNIX)
            connection.sock.connect(str(path))
            connection.request('POST', '/settings', json.dumps({'auto_reconnect': False, 'auto_wake': True}), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            self.assertEqual(response.status, 202)
            response.read()
            connection.close()
            self.assertEqual(subject.settings, {'auto_reconnect': False, 'auto_wake': True})
            server.shutdown()

    def test_private_config_validates_origins_and_browser_cannot_configure_commands(self):
        for url in ('http://evil.example', 'http://user@127.0.0.1:8787', 'http://127.0.0.1:8787/path'):
            self.config['relay_url'] = url
            with self.assertRaises(control.ControlError): control.validate(self.config)
        self.config['relay_url'] = 'http://127.0.0.1:18787'
        for url in ('http://evil.example', 'ftp://example.com/', 'https://user@example.com/', 'https://example.com/?query=1'):
            self.config['internet_check_url'] = url
            with self.assertRaises(control.ControlError): control.validate(self.config)
        for url in ('https://api.github.com/', 'http://127.0.0.1:9/'):
            self.config['internet_check_url'] = url
            control.validate(self.config)


class StateOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {'version': 1, 'profile': str(self.root), 'relay_url': 'http://127.0.0.1:18787',
                       'gateway_url': 'http://127.0.0.1:18788',
                       'relay_token_file': str(self.root / 'relay.token'),
                       'local_token_file': str(self.root / 'local.token'),
                       'relay_state_file': str(self.root / 'identity.json'),
                       'components': {}}

    def supervisor(self, **kwargs):
        result = control.Supervisor(self.config, **kwargs)
        self.addCleanup(result.stop.set)
        return result

    def test_snapshot_returns_copies_of_all_observable_state(self):
        subject = self.supervisor()
        snapshot = subject.snapshot()
        snapshot['settings']['auto_wake'] = True
        snapshot['recovery']['busy'] = True
        snapshot['components'][0]['state'] = 'tampered'
        snapshot['remote']['id'] = 'tampered'
        self.assertFalse(subject.settings['auto_wake'])
        self.assertFalse(subject.recovery['busy'])
        self.assertNotEqual(subject.states[control.COMPONENTS[0]], 'tampered')
        self.assertNotEqual(subject.snapshot()['remote']['id'], 'tampered')

    def test_snapshots_stay_consistent_while_operations_transition(self):
        subject = self.supervisor()
        state = subject.state
        stop = threading.Event()
        errors = []

        def writer():
            try:
                for _ in range(1000):
                    state.begin_operation('restart_gateway')
                    state.set_component('gateway', 'starting')
                    state.set_component('gateway', 'running')
                    state.begin_attempt('recovering_connection')
                    state.update_recovery(last_error='bounded_failure')
                    state.finish_operation()
            except BaseException as error:  # Surface thread assertions to the test.
                errors.append(error)
            finally:
                stop.set()

        def reader():
            attempts = 0
            try:
                while not stop.is_set():
                    snapshot = state.snapshot()
                    recovery = snapshot['recovery']
                    self.assertEqual(set(snapshot), {'version', 'managed', 'collected_at', 'settings', 'recovery',
                                                     'relay_state', 'internet_state', 'internet_checked_at',
                                                     'remote', 'components'})
                    if not recovery['busy']:
                        self.assertIn(recovery['phase'], ('starting', 'monitoring'))
                    self.assertGreaterEqual(recovery['attempts'], attempts)
                    self.assertEqual(len(snapshot['components']), len(control.COMPONENTS))
                    self.assertEqual(set(snapshot['settings']), {'auto_reconnect', 'auto_wake'})
                    attempts = recovery['attempts']
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=10)
        self.assertEqual(errors, [])

    def test_slow_settings_persistence_does_not_block_snapshots(self):
        subject = self.supervisor()
        entered, release = threading.Event(), threading.Event()
        value = {'auto_reconnect': False, 'auto_wake': True}

        def persist(settings):
            entered.set()
            self.assertTrue(release.wait(2))

        writer = threading.Thread(target=subject.state.apply_settings, args=(value, persist))
        writer.start()
        self.assertTrue(entered.wait(1))
        reader_done = threading.Event()
        threading.Thread(target=lambda: (subject.snapshot(), reader_done.set()), daemon=True).start()
        self.assertTrue(reader_done.wait(0.5), 'snapshot waited for settings disk I/O')
        release.set()
        writer.join(timeout=2)
        self.assertEqual(subject.settings, value)

    def test_failed_settings_persistence_keeps_the_previous_snapshot(self):
        subject = self.supervisor()
        before = subject.settings
        with patch.object(supervisor_impl, 'save_json', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                subject.update_settings({'auto_reconnect': False, 'auto_wake': True})
        self.assertEqual(subject.settings, before)

    def test_collaborators_are_injectable_at_real_boundaries(self):
        class Probe:
            def relay(self): return 'connected'
            def internet(self): return 'connected'
            def expected_identity(self): return 'a' * 64

        class Processes:
            def __init__(self):
                self.children, self.identities, self.started = {}, {}, []

            def identity(self, _): return None

            def start(self, name): self.started.append(name)

            def stop(self, name): self.started.append('stop:' + name)

        processes = Processes()
        self.config['components']['gateway'] = {'command': ['/bin/true'], 'pid_file': str(self.root / 'gateway.pid')}
        subject = self.supervisor(probes=Probe(), processes=processes)
        self.assertEqual(subject.probe(), 'connected')
        self.assertEqual(subject.expected_identity(), 'a' * 64)
        subject.start_component('gateway')
        self.assertEqual(processes.started, ['gateway'])

    def test_executable_entry_point_imports_away_from_the_repository(self):
        scripts = [Path(__file__).resolve().parents[1] / 'deploy/supervisor.py',
                   Path(__file__).resolve().parents[1] / 'deploy/start_supervisor.py']
        with tempfile.TemporaryDirectory() as directory:
            for script in scripts:
                with self.subTest(script=script.name):
                    result = subprocess.run([sys.executable, '-B', str(script), '--help'], cwd=directory,
                                            text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('--config', result.stdout)


class RecoveryPolicyTest(unittest.TestCase):
    def test_backoff_and_provider_retry_use_injected_clock(self):
        now = [0.0]
        wall = [1000.0]
        policy = control.RecoveryPolicy(clock=lambda: now[0], wall_clock=lambda: wall[0])
        for _ in range(2):
            policy.note_failure()
        self.assertFalse(policy.recovery_due())
        policy.note_failure()
        self.assertTrue(policy.recovery_due())
        retry_at = policy.schedule_retry()
        self.assertEqual(retry_at, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(1002)))
        self.assertEqual(policy.delay_value(), 4)
        self.assertEqual(policy.next_attempt_value(), 2)
        policy.record_connected()
        self.assertEqual((policy.failures, policy.delay_value(), policy.next_attempt_value()), (0, 2, 0))

        policy.provider_failed('unreachable', False)
        self.assertFalse(policy.provider_due())
        now[0] = 2
        self.assertTrue(policy.provider_due())
        policy.provider_ok(host_status_next=20)
        self.assertFalse(policy.host_status_due())
        now[0] = 20
        self.assertTrue(policy.host_status_due())
        policy.provider_failed('identity_mismatch', True)
        self.assertEqual(policy.provider_blocked_value(), 'identity_mismatch')
        self.assertFalse(policy.provider_due())
        self.assertEqual(policy.provider_status(), ('identity_mismatch', 'identity_mismatch', None))


class LauncherTest(unittest.TestCase):
    def test_existing_codespace_adapter_contains_paths_not_secret_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tunnel-supervisor.sh').write_text('CODESPACE=existing-test\n')
            config = start_supervisor.codespace_config(root, root, 8791)
            self.assertIn('--control-socket', config['components']['dashboard']['command'])
            self.assertNotIn('tunnel-supervisor.sh', ' '.join(config['components']['tunnel']['command']))
            self.assertEqual(config['components']['dashboard']['port'], 8791)
            self.assertEqual(config['codespace']['name'], 'existing-test')


@unittest.skipUnless(os.environ.get('DELTARELAY_RECOVERY_TEST_BINARY'),
                     'set DELTARELAY_RECOVERY_TEST_BINARY for supervised real transport recovery')
class RealTransportTest(unittest.TestCase):
    def test_two_network_switches_resume_one_provider_generation(self):
        binary = os.environ['DELTARELAY_RECOVERY_TEST_BINARY']
        frames = [b'data: first\n\n', b'data: middle\n\n', b'data: finished\n\n']
        releases = [threading.Event(), threading.Event()]
        calls = []

        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                calls.append(1)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(frames[0])
                self.wfile.flush()
                for event, frame in zip(releases, frames[1:]):
                    if not event.wait(25): return
                    self.wfile.write(frame)
                    self.wfile.flush()

        def free_port():
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                return listener.getsockname()[1]

        forwarder = '''import asyncio, sys
async def pump(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()
async def accept(reader, writer):
    try:
        remote, destination = await asyncio.open_connection('127.0.0.1', int(sys.argv[2]))
    except OSError:
        writer.close()
        return
    tasks = [asyncio.create_task(pump(reader, destination)), asyncio.create_task(pump(remote, writer))]
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in tasks: task.cancel()
async def main():
    server = await asyncio.start_server(accept, '127.0.0.1', int(sys.argv[1]))
    async with server: await server.serve_forever()
asyncio.run(main())
'''
        with tempfile.TemporaryDirectory() as directory, http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider) as provider:
            root = Path(directory)
            provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
            provider_thread.start()
            server_port, tunnel_port, gateway_port = free_port(), free_port(), free_port()
            origin = f'http://127.0.0.1:{provider.server_port}'
            for name, value in [('relay.token', 'relay-secret'), ('local.token', 'local-secret'),
                                ('upstreams.json', json.dumps([{'name': 'mock', 'origin': origin, 'path_prefix': '/v1/'}]))]:
                path = root / name
                path.write_text(value)
                path.chmod(0o600)
            log = (root / 'relay.log').open('ab')
            relay = subprocess.Popen([binary, 'serve', '--listen', f'127.0.0.1:{server_port}', '--data', str(root / 'store'),
                                      '--token-file', str(root / 'relay.token'), '--upstreams', str(root / 'upstreams.json'),
                                      '--allow-private-upstreams'], stdout=log, stderr=log)
            subject = None
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                info_request = urllib.request.Request(f'http://127.0.0.1:{server_port}/v2/info', headers={'Authorization': 'Bearer relay-secret'})
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with opener.open(info_request, timeout=1) as response: identity = json.load(response)['state_id']
                        break
                    except OSError:
                        if time.monotonic() >= deadline: raise
                        time.sleep(0.05)
                state = root / 'identity.json'
                state.write_text(json.dumps(identity))
                state.chmod(0o600)
                plugin = root / 'custom-provider.py'
                plugin.write_text('''import json, sys
request = json.load(sys.stdin)
config = json.load(open(request['config_file']))
method = request['method']
if method == 'describe': result = {'id': 'local_fault_test', 'label': 'Custom remote host', 'capabilities': []}
elif method == 'connection': result = config
else: result = {'host_state': 'unknown'}
print(json.dumps({'protocol_version': 1, 'id': request['id'], 'result': result}))
''')
                plugin_config = root / 'custom-provider.json'
                plugin_config.write_text(json.dumps({'relay_url': f'http://127.0.0.1:{tunnel_port}', 'tunnel': {
                    'command': [sys.executable, '-c', forwarder, str(tunnel_port), str(server_port)], 'port': tunnel_port}}))
                plugin_config.chmod(0o600)
                subject = control.Supervisor({
                    'version': 1, 'profile': str(root), 'relay_url': f'http://127.0.0.1:{tunnel_port}',
                    'gateway_url': f'http://127.0.0.1:{gateway_port}', 'relay_token_file': str(root / 'relay.token'),
                    'local_token_file': str(root / 'local.token'), 'relay_state_file': str(state),
                    'remote': {'command': [sys.executable, '-B', str(plugin)], 'config_file': str(plugin_config)},
                    'components': {
                        'gateway': {'command': [binary, 'gateway', '--listen', f'127.0.0.1:{gateway_port}',
                                                '--server', f'http://127.0.0.1:{tunnel_port}', '--token-file', str(root / 'relay.token'),
                                                '--local-token-file', str(root / 'local.token'), '--upstreams', str(root / 'upstreams.json'),
                                                '--allow-private-upstreams', '--state-dir', str(root / 'state'), '--stats-file', str(root / 'stats.json')],
                                     'pid_file': str(root / 'gateway.pid'), 'port': gateway_port},
                    }})
                subject.prepare_provider()
                subject.start_component('tunnel')
                subject.start_component('gateway')
                deadline = time.monotonic() + 10
                while subject.probe() != 'connected':
                    if time.monotonic() >= deadline: self.fail('tunnel did not become ready')
                    time.sleep(0.05)
                time.sleep(0.1)
                gateway_pid = subject.children['gateway'].pid
                request = urllib.request.Request(f'http://127.0.0.1:{gateway_port}/v1/proxy', data=b'{"model":"mock","input":"reconnect test"}', headers={
                    'Content-Type': 'application/json', 'X-DeltaRelay-Local-Token': 'local-secret',
                    'X-DeltaRelay-Target': origin + '/v1/responses', 'X-DeltaRelay-Request-ID': str(uuid.uuid4())})
                with opener.open(request, timeout=20) as response:
                    self.assertEqual(response.read(len(frames[0])), frames[0])
                    for index in range(2):
                        subject.tick()
                        tunnel = subject.children['tunnel']
                        tunnel.terminate()
                        tunnel.wait(timeout=3)
                        for _ in range(3): subject.tick()
                        self.assertNotEqual(subject.children['tunnel'].pid, tunnel.pid)
                        self.assertEqual(subject.children['gateway'].pid, gateway_pid)
                        releases[index].set()
                        self.assertEqual(response.read(len(frames[index + 1])), frames[index + 1])
                    self.assertEqual(response.read(), b'')
                self.assertEqual(len(calls), 1, 'network repair duplicated provider generation')
                self.assertEqual(json.loads(state.read_text()), identity)
                self.assertEqual(subject.probe(), 'connected')
                self.assertEqual(subject.snapshot()['remote']['id'], 'local_fault_test')
            finally:
                for release in releases: release.set()
                if subject:
                    for child in subject.children.values(): SupervisorTest.cleanup_child(child)
                SupervisorTest.cleanup_child(relay)
                log.close()
                provider.shutdown()


if __name__ == '__main__':
    unittest.main()
