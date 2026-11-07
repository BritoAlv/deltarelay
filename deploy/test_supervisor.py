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

from supervision.control import Handler, Server, controller_status
from test_support import configure_provider
import supervision.supervisor as control
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
        self.provider_config = configure_provider(self.config)

    def supervisor(self):
        result = control.Supervisor(self.config)
        self.addCleanup(result.close)
        result.prepare_provider()
        return result

    def component(self, name, command=None):
        command = command or [sys.executable, '-c', 'import time; time.sleep(120)', name]
        if name == 'tunnel':
            provider = json.loads(self.provider_config.read_text())
            provider['connection']['tunnel'] = {'command': command, 'port': int(self.config['relay_url'].rsplit(':', 1)[1])}
            self.provider_config.write_text(json.dumps(provider))
        else:
            self.config['components'][name] = {'command': command, 'pid_file': str(self.root / (name + '.pid'))}

    def wait_job(self, subject):
        self.assertTrue(subject.operation.acquire(timeout=5), 'background operation did not complete')
        subject.operation.release()

    def test_settings_persist_and_do_not_silently_enable_billing(self):
        subject = self.supervisor()
        self.assertEqual(subject.state.settings_copy(), {'auto_reconnect': True, 'auto_wake': False})
        subject.update_settings({'auto_reconnect': False, 'auto_wake': True})
        self.assertEqual(self.supervisor().state.settings_copy(), {'auto_reconnect': False, 'auto_wake': True})
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

    def test_transient_transport_failures_are_not_permanent_configuration_errors(self):
        subject = self.supervisor()
        failures = (ConnectionResetError(104, 'Connection reset by peer'),
                    ConnectionAbortedError(103, 'Software caused connection abort'),
                    BrokenPipeError(32, 'Broken pipe'),
                    http.client.IncompleteRead(b'{"version": 2'),
                    ssl.SSLError(1, 'TLS read failed'))
        for error in failures:
            with self.subTest(error=type(error).__name__), patch.object(subject.opener, 'open', side_effect=error):
                self.assertEqual(subject.probe(), 'unreachable')

        class Truncated:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return b'{"version": 2'
        with patch.object(subject.opener, 'open', return_value=Truncated()):
            self.assertEqual(subject.probe(), 'unreachable')

        missing = self.root / 'missing-token'
        with patch.dict(subject.probes.config, {'relay_token_file': str(missing)}):
            self.assertEqual(subject.probe(), 'configuration_error')

    def test_connection_reset_does_not_block_automatic_recovery(self):
        subject = self.supervisor()
        subject.state.internet_state = 'connected'
        subject.state.internet_next = time.monotonic() + 60
        with patch.object(subject.opener, 'open', side_effect=ConnectionResetError(104, 'Connection reset by peer')), \
                patch.object(subject, 'recover') as recover:
            for _ in range(4):
                subject.tick()
        recover.assert_called_once_with(wake=False)
        self.assertEqual(subject.policy.provider_blocked_value(), '')
        self.assertEqual(subject.state.recovery_copy()['last_error'], 'unreachable')

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
            subject.state.internet_state = 'unknown'
            subject.state.internet_next = 0
            with patch.object(subject.opener, 'open', side_effect=open_):
                subject.update_internet('unreachable')
            self.assertEqual(subject.state.internet_state, want)
            self.assertIsNotNone(subject.state.internet_checked_at)

        # Repeated checks are cached, and a reachable relay confirms internet
        # without generating extra external traffic.
        subject.state.internet_state = 'connected'
        subject.state.internet_next = time.monotonic() + 60
        with patch.object(subject.opener, 'open') as opened:
            subject.update_internet('unreachable')
            opened.assert_not_called()
        subject.state.internet_state = 'unreachable'
        with patch.object(subject.opener, 'open') as opened:
            subject.update_internet('connected')
            opened.assert_not_called()
        self.assertEqual(subject.state.internet_state, 'connected')
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
        self.assertEqual(subject.state.relay_value(), 'connected')
        self.assertIsNotNone(subject.state.recovery_copy()['last_connected_at'])

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
        self.assertEqual(subject.state.relay_value(), 'connected')

    def test_cold_tunnel_is_not_abandoned_after_five_fast_connection_refusals(self):
        self.component('tunnel')
        subject = self.supervisor()
        with patch.object(subject, 'probe', side_effect=['unreachable'] * 8 + ['connected']), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'remote', side_effect=control.ControlError('relay_recovery_failed')) as remote, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.recover()
        restart.assert_called_once_with('tunnel')
        remote.assert_not_called()
        self.assertEqual(subject.state.relay_value(), 'connected')

    def test_dashboard_wake_connects_the_tunnel_before_attempting_ssh_recovery(self):
        self.component('tunnel')
        self.component('gateway')
        subject = self.supervisor()
        subject.update_settings({'auto_reconnect': False, 'auto_wake': False})
        saved_settings = (subject.directory / 'settings.json').read_bytes()
        saved_pin = Path(self.config['relay_state_file']).read_bytes()
        host = ['stopped']

        def provider(method, params=None):
            self.assertTrue(subject.state.recovery_value('busy'))
            if method == 'host.wake':
                host[0] = 'running'
            else:
                self.assertEqual(method, 'status')
            return {'host_state': host[0]}

        with patch.object(subject, 'provider_call', side_effect=provider) as provider_call, \
                patch.object(subject, 'probe', side_effect=['unreachable', 'connected']), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'start_component') as start, \
                patch.object(subject, 'remote', side_effect=control.ControlError('relay_recovery_failed')) as remote, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.submit({'component': 'remote', 'action': 'wake', 'confirmed': True})
            self.wait_job(subject)
        status = subject.snapshot()
        self.assertEqual(status['recovery']['last_error'], '')
        self.assertEqual(status['relay_state'], 'connected')
        self.assertEqual(status['remote']['host_state'], 'running')
        self.assertFalse(status['recovery']['busy'])
        self.assertIsNotNone(status['recovery']['last_connected_at'])
        self.assertEqual([call.args[0] for call in provider_call.call_args_list], ['status', 'host.wake'])
        restart.assert_called_once_with('tunnel')
        start.assert_called_once_with('gateway')
        remote.assert_not_called()
        self.assertEqual((subject.directory / 'settings.json').read_bytes(), saved_settings)
        self.assertEqual(Path(self.config['relay_state_file']).read_bytes(), saved_pin)

    def test_transient_ssh_failure_still_verifies_the_tunnel_before_failing_wake(self):
        self.component('tunnel')
        subject = self.supervisor()
        for error in ('relay_recovery_failed', 'relay_ssh_timeout', 'provider_timeout'):
            with self.subTest(error=error), \
                    patch.object(subject, 'probe', side_effect=['unreachable'] * 17 + ['connected']), \
                    patch.object(subject, 'internet_probe', return_value='connected'), \
                    patch.object(subject, 'restart_component') as restart, \
                    patch.object(subject, 'remote', side_effect=control.ControlError(error)) as remote, \
                    patch.object(subject.stop, 'wait', return_value=False):
                subject.recover()
                self.assertEqual([call.args[0] for call in restart.call_args_list], ['tunnel', 'tunnel'])
                remote.assert_called_once_with(wake=False)
                self.assertEqual(subject.state.relay_value(), 'connected')

    def test_dashboard_wake_starts_a_missing_relay_only_after_waking_and_trying_the_tunnel(self):
        self.component('tunnel')
        subject = self.supervisor()
        subject.update_settings({'auto_reconnect': False, 'auto_wake': False})
        steps = []

        def provider(method, params=None):
            steps.append(method)
            if method == 'relay.ensure':
                self.assertEqual(params, {'expected_state_id': 'a' * 64})
                return {'state_id': 'a' * 64}
            return {'host_state': 'stopped' if method == 'status' else 'running'}

        with patch.object(subject, 'provider_call', side_effect=provider), \
                patch.object(subject, 'probe', side_effect=['unreachable'] * 18 + ['connected']), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component', side_effect=lambda name: steps.append('restart_' + name)), \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.submit({'component': 'remote', 'action': 'wake', 'confirmed': True})
            self.wait_job(subject)
        self.assertEqual(steps, ['status', 'host.wake', 'restart_tunnel', 'relay.ensure', 'restart_tunnel'])
        self.assertEqual(subject.state.relay_value(), 'connected')
        self.assertEqual(subject.state.recovery_value('last_error'), '')
        self.assertEqual(subject.state.settings_copy(), {'auto_reconnect': False, 'auto_wake': False})

    def test_dashboard_wake_cannot_report_success_from_provider_availability_alone(self):
        self.component('tunnel')
        subject = self.supervisor()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component'), \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.submit({'component': 'remote', 'action': 'wake', 'confirmed': True})
            self.wait_job(subject)
        self.assertEqual(subject.state.host_value(), 'running')
        self.assertEqual(subject.state.relay_value(), 'unreachable')
        self.assertEqual(subject.state.recovery_value('last_error'), 'unreachable')
        self.assertIsNone(subject.state.recovery_value('last_connected_at'))
        self.assertFalse(subject.state.recovery_value('busy'))

    def test_dashboard_wake_requires_the_saved_identity_before_waking_or_starting_services(self):
        self.component('tunnel')
        subject = self.supervisor()
        Path(self.config['relay_state_file']).unlink()
        with patch.object(subject, 'provider_call', return_value={'host_state': 'stopped'}) as provider, \
                patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart:
            subject.submit({'component': 'remote', 'action': 'wake', 'confirmed': True})
            self.wait_job(subject)
        provider.assert_called_once_with('status')
        restart.assert_not_called()
        self.assertEqual(subject.state.recovery_value('last_error'), 'identity_unavailable')
        self.assertEqual(subject.policy.provider_blocked_value(), 'identity_unavailable')

    def test_failed_post_ssh_verification_preserves_the_real_recovery_error(self):
        self.component('tunnel')
        subject = self.supervisor()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'remote', side_effect=control.ControlError('relay_ssh_timeout')) as remote, \
                patch.object(subject.stop, 'wait', return_value=False):
            with self.assertRaisesRegex(control.ControlError, '^relay_ssh_timeout$'):
                subject.recover()
        self.assertEqual([call.args[0] for call in restart.call_args_list], ['tunnel', 'tunnel'])
        remote.assert_called_once_with(wake=False)
        self.assertIsNone(subject.state.recovery_value('last_connected_at'))

    def test_permanent_remote_failure_does_not_rebuild_or_retry_the_tunnel(self):
        self.component('tunnel')
        subject = self.supervisor()
        for error in ('identity_mismatch', 'authentication_failed', 'protocol_mismatch', 'tls_verification_failed'):
            with self.subTest(error=error), patch.object(subject, 'probe', return_value='unreachable'), \
                    patch.object(subject, 'internet_probe', return_value='connected'), \
                    patch.object(subject, 'restart_component') as restart, \
                    patch.object(subject, 'remote', side_effect=control.ControlError(error)) as remote, \
                    patch.object(subject.stop, 'wait', return_value=False):
                with self.assertRaisesRegex(control.ControlError, '^' + error + '$'):
                    subject.recover()
                restart.assert_called_once_with('tunnel')
                remote.assert_called_once_with(wake=False)

    def test_relay_readiness_is_bounded_and_cancellable(self):
        subject = self.supervisor()
        now = [0.0]

        def wait(seconds):
            now[0] += seconds
            return False

        with patch.object(subject, 'clock', side_effect=lambda: now[0]), \
                patch.object(subject, 'probe', return_value='unreachable') as probe, \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject.stop, 'wait', side_effect=wait):
            self.assertFalse(subject.wait_for_relay())
            self.assertEqual(now[0], 30)
            self.assertEqual(probe.call_count, 16)
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject.stop, 'wait', return_value=True):
            with self.assertRaisesRegex(control.ControlError, '^operation_cancelled$'):
                subject.wait_for_relay()

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
        self.assertEqual(subject.state.relay_value(), 'connected')

    def test_remote_command_success_does_not_mean_connection_recovered(self):
        subject = self.supervisor()
        with patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'remote') as remote, patch.object(subject.stop, 'wait', return_value=False):
            with self.assertRaisesRegex(control.ControlError, '^unreachable$'):
                subject.recover()
        remote.assert_called_once_with(wake=False)
        self.assertIsNone(subject.state.recovery_copy()['last_connected_at'])

    def test_permanent_failure_after_tunnel_reconnect_blocks_remote_changes(self):
        self.component('tunnel')
        subject = self.supervisor()
        for error in ('identity_mismatch', 'authentication_failed', 'protocol_mismatch', 'tls_verification_failed'):
            subject.policy.set_provider_blocked('')
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
                self.assertEqual(subject.state.recovery_copy()['last_error'], error)

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
                patch.object(subject, 'recover', side_effect=control.ControlError('relay_ssh_timeout')):
            for _ in range(3): subject.tick()
            self.assertEqual(subject.state.recovery_copy()['last_error'], 'relay_ssh_timeout')
            self.assertEqual(subject.state.recovery_copy()['phase'], 'monitoring')
            subject.policy.set_next_attempt(float('inf'))
            for _ in range(3): subject.tick()
            self.assertEqual(subject.state.recovery_copy()['last_error'], 'relay_ssh_timeout')
        with patch.object(subject, 'probe', return_value='connected'):
            subject.tick()
        self.assertEqual(subject.state.recovery_copy()['last_error'], '')
        self.assertIsNone(subject.state.recovery_copy()['next_retry_at'])

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

    def test_stop_pauses_recovery_before_failure_without_stopping_local_services(self):
        self.component('tunnel')
        self.component('gateway')
        subject = self.supervisor()
        subject.update_settings({'auto_reconnect': True, 'auto_wake': True})
        for name in ('tunnel', 'gateway'):
            subject.start_component(name)
            self.addCleanup(self.cleanup_child, subject.processes.children[name])

        def stop_host(method, params=None):
            self.assertEqual(method, 'host.stop')
            self.assertEqual(control.private_json(subject.directory / 'settings.json'),
                             {'auto_reconnect': False, 'auto_wake': False})
            self.assertIsNotNone(subject.processes.children['tunnel'].poll())
            raise control.ControlError('unreachable')

        with patch.object(subject.provider, 'call', side_effect=stop_host):
            with self.assertRaisesRegex(control.ControlError, '^unreachable$'):
                subject.stop_host()
        self.assertIsNone(subject.processes.children['gateway'].poll())
        self.assertNotEqual(subject.state.host_value(), 'stopped')
        self.assertEqual(self.supervisor().state.settings_copy(), {'auto_reconnect': False, 'auto_wake': False})

    def test_remote_stop_wait_is_bounded_and_cancellable(self):
        for cancelled, wanted in ((False, 'host_stop_timeout'), (True, 'operation_cancelled')):
            subject = self.supervisor()
            with patch.object(subject.provider, 'call', return_value={'host_state': 'stopping'}), \
                    patch.object(subject.stop, 'wait', return_value=cancelled), \
                    patch.object(subject, 'clock', side_effect=[0, 121]):
                with self.assertRaisesRegex(control.ControlError, '^' + wanted + '$'):
                    subject.stop_host()
            self.assertNotEqual(subject.state.host_value(), 'stopped')
            self.assertEqual(subject.state.settings_copy(), {'auto_reconnect': False, 'auto_wake': False})

    def test_action_schema_confirmation_and_serialization(self):
        subject = self.supervisor()
        for value in ({'component': 'all', 'action': 'restart'}, {'component': 'tunnel', 'action': 'recover', 'request_id': 'bad'},
                      {'component': 'all', 'action': 'wake'}, {'component': 'codespace', 'action': 'start'},
                      {'component': 'codespace', 'action': 'stop', 'confirmed': True},
                      {'component': 'codespace', 'action': 'wake', 'confirmed': True},
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
                patch.object(subject.coordinator, 'connection', side_effect=control.ControlError('host_stopped')):
            subject.submit({'component': 'all', 'action': 'recover'})
            self.wait_job(subject)
        self.assertEqual([call.args[0] for call in start.call_args_list], ['dashboard', 'gateway', 'opencode', 'desktop'])
        self.assertEqual(subject.state.recovery_copy()['last_error'], 'host_stopped')

    def test_desktop_start_launches_once_without_restarting_or_recovering_other_services(self):
        self.component('desktop')
        subject = self.supervisor()
        with patch.dict(os.environ, {'DISPLAY': ':test'}), \
                patch.object(subject, 'restart_component') as restart, patch.object(subject, 'recover') as recover, \
                patch.object(subject, 'remote') as remote:
            subject.submit({'component': 'desktop', 'action': 'start'})
            self.wait_job(subject)
            self.assertEqual(subject.state.recovery_copy()['last_error'], '')
            first = subject.processes.children['desktop']
            self.addCleanup(self.cleanup_child, first)
            subject.submit({'component': 'desktop', 'action': 'start'})
            self.wait_job(subject)
            self.assertIs(subject.processes.children['desktop'], first)
            self.assertIsNone(first.poll())
            self.assertEqual(subject.state.states_copy()['desktop'], 'running')
            self.assertEqual(list(subject.processes.children), ['desktop'])
            restart.assert_not_called()
            recover.assert_not_called()
            remote.assert_not_called()

    def test_desktop_start_without_a_graphical_session_reports_a_safe_error(self):
        self.component('desktop')
        subject = self.supervisor()
        with patch.dict(os.environ, {'DISPLAY': '', 'WAYLAND_DISPLAY': ''}):
            subject.submit({'component': 'desktop', 'action': 'start'})
            self.wait_job(subject)
        self.assertEqual(subject.state.recovery_copy()['last_error'], 'graphical_session_required')
        self.assertFalse(subject.processes.children)

    def test_real_owned_process_is_adopted_and_restarted_without_signaling_unrelated_process(self):
        self.component('tunnel')
        subject = self.supervisor()
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
        self.addCleanup(lambda: self.cleanup_child(unrelated))
        subject.start_component('tunnel')
        first = subject.processes.children['tunnel']
        self.addCleanup(lambda: self.cleanup_child(subject.processes.children['tunnel']))
        self.assertEqual(subject._identity('tunnel')['pid'], first.pid)
        adopted = self.supervisor()
        self.assertEqual(adopted._identity('tunnel')['pid'], first.pid)
        subject.restart_component('tunnel')
        self.assertNotEqual(subject.processes.children['tunnel'].pid, first.pid)
        first.wait(timeout=3)
        self.assertIsNone(unrelated.poll())
        Path(subject.config['components']['tunnel']['pid_file']).write_text(str(unrelated.pid))
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
            subject = self.supervisor()
            subject.config['components']['tunnel']['port'] = listener.getsockname()[1]
            with self.assertRaisesRegex(control.ControlError, 'unrecognized_port_owner'):
                subject.start_component('tunnel')
            self.assertFalse(subject.processes.children)

    def test_unix_socket_snapshot_and_settings_api(self):
        subject = self.supervisor()
        path = subject.directory / 'test.sock'
        with Server(str(path), Handler) as server:
            server.supervisor = subject
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            self.addCleanup(server.shutdown)
            status = controller_status(path)
            self.assertTrue(status['managed'])
            connection = http.client.HTTPConnection('localhost')
            connection.sock = socket.socket(socket.AF_UNIX)
            connection.sock.connect(str(path))
            connection.request('POST', '/settings', json.dumps({'auto_reconnect': False, 'auto_wake': True}), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            self.assertEqual(response.status, 202)
            response.read()
            connection.close()
            self.assertEqual(subject.state.settings_copy(), {'auto_reconnect': False, 'auto_wake': True})
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
        configure_provider(self.config)

    def supervisor(self, **kwargs):
        result = control.Supervisor(self.config, **kwargs)
        self.addCleanup(result.close)
        result.prepare_provider()
        return result

    def test_snapshot_returns_copies_of_all_observable_state(self):
        subject = self.supervisor()
        snapshot = subject.snapshot()
        snapshot['settings']['auto_wake'] = True
        snapshot['recovery']['busy'] = True
        snapshot['components'][0]['state'] = 'tampered'
        snapshot['remote']['id'] = 'tampered'
        self.assertFalse(subject.state.settings_copy()['auto_wake'])
        self.assertFalse(subject.state.recovery_copy()['busy'])
        self.assertNotEqual(subject.state.states_copy()[control.COMPONENTS[0]], 'tampered')
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
                                                     'remote', 'components', 'topology'})
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
        self.assertEqual(subject.state.settings_copy(), value)

    def test_failed_settings_persistence_keeps_the_previous_snapshot(self):
        subject = self.supervisor()
        before = subject.state.settings_copy()
        with patch.object(supervisor_impl, 'save_json', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                subject.update_settings({'auto_reconnect': False, 'auto_wake': True})
        self.assertEqual(subject.state.settings_copy(), before)

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
                info_request = urllib.request.Request(f'http://127.0.0.1:{server_port}/info', headers={'Authorization': 'Bearer relay-secret'})
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
                gateway_pid = subject.processes.children['gateway'].pid
                request = urllib.request.Request(f'http://127.0.0.1:{gateway_port}/proxy', data=b'{"model":"mock","input":"reconnect test"}', headers={
                    'Content-Type': 'application/json', 'X-DeltaRelay-Local-Token': 'local-secret',
                    'X-DeltaRelay-Target': origin + '/v1/responses', 'X-DeltaRelay-Request-ID': str(uuid.uuid4())})
                with opener.open(request, timeout=20) as response:
                    self.assertEqual(response.read(len(frames[0])), frames[0])
                    for index in range(2):
                        subject.tick()
                        tunnel = subject.processes.children['tunnel']
                        tunnel.terminate()
                        tunnel.wait(timeout=3)
                        for _ in range(3): subject.tick()
                        self.assertNotEqual(subject.processes.children['tunnel'].pid, tunnel.pid)
                        self.assertEqual(subject.processes.children['gateway'].pid, gateway_pid)
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
                    for child in subject.processes.children.values(): SupervisorTest.cleanup_child(child)
                    subject.close()
                SupervisorTest.cleanup_child(relay)
                log.close()
                provider.shutdown()


if __name__ == '__main__':
    unittest.main()
