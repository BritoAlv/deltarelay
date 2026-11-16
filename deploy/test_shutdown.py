"""Billing safety: shutdown wins over recovery, including its running commands."""

import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from remote_provider import ProviderError
from supervision.control import startup_components
from supervision.process import process
from supervision.shutdown import shutdown
from supervision.supervisor import HOST_STOP_TIMEOUT, Supervisor
from test_coordinator import make_config
from test_support import configure_provider


class ShutdownTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = make_config(self.root)
        self.provider_config = configure_provider(self.config)

    def supervisor(self, *, prepare=True):
        subject = Supervisor(self.config)
        self.addCleanup(subject.close)
        if prepare:
            subject.prepare_provider()
        return subject

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail('shutdown fixture did not complete')
            threading.Event().wait(0.01)

    def wait_operation(self, subject, identifier):
        def finished():
            run = subject.state.run_copy()
            return run and run['id'] == identifier and run['status'] != 'running'
        self.wait_for(finished)
        self.assertTrue(subject.operation.acquire(timeout=5))
        subject.operation.release()
        return subject.state.run_copy()

    def assert_paused(self, subject):
        self.assertEqual(subject.state.settings_copy(), {'auto_reconnect': False, 'auto_wake': False})
        self.assertEqual(json.loads((subject.directory / 'settings.json').read_text()), subject.state.settings_copy())
        self.assertEqual(subject.state.intent_copy()['remote'], 'stopped')
        self.assertIsNone(subject.state.recovery_value('next_retry_at'))

    def test_stop_interrupts_and_reaps_running_recovery_before_requesting_cloud_shutdown(self):
        subject = self.supervisor()
        pid_file = self.root / 'recovery.pid'
        command = [sys.executable, '-c',
                   f'import os,time; open({str(pid_file)!r},"w").write(str(os.getpid())); time.sleep(120)']

        def recover(**_):
            subject._run(command, timeout=120)
            self.fail('cancelled recovery continued')

        def provider(method, params=None):
            self.assertEqual(method, 'host.stop')
            self.assert_paused(subject)
            self.assertEqual(subject.state.intent_copy()['system'], 'stopped')
            self.assertIsNone(process(int(pid_file.read_text())), 'recovery command survived until cloud stop')
            return {'host_state': 'stopped'}

        with patch.object(subject.coordinator, 'connection', side_effect=recover), \
                patch.object(subject.provider, 'call', side_effect=provider) as calls:
            subject.submit({'component': 'all', 'action': 'recover'})
            self.wait_for(pid_file.exists)
            request = {'component': 'all', 'action': 'stop', 'confirmed': True, 'request_id': 'a' * 32}
            identifier = subject.submit(request)
            self.assert_paused(subject)
            self.assertEqual(subject.submit(request), identifier, 'duplicate stop created a second operation')
            run = self.wait_operation(subject, identifier)
            self.assertEqual(run['status'], 'completed')
            self.assertEqual(subject.submit(request), identifier)
        calls.assert_called_once_with('host.stop', None)
        self.assertFalse(subject.stop.is_set(), 'local supervisor must remain available')
        self.assertEqual(subject.state.host_value(), 'stopped')
        self.assert_paused(subject)

    def test_all_direct_remote_mutations_honor_intent_even_with_explicit_wake_argument(self):
        subject = self.supervisor()
        subject.suspend_recovery(system=True)
        actions = (
            lambda: subject.start_component('tunnel'),
            lambda: subject.restart_component('tunnel'),
            lambda: subject.remote(wake=True),
            lambda: subject.provider_call('host.wake'),
            lambda: subject.provider_call('relay.ensure', {'expected_state_id': 'a' * 64}),
            lambda: subject.recover(wake=True),
            lambda: subject.coordinator.adapters['remote'].start(),
        )
        with patch.object(subject.provider, 'call') as provider:
            for action in actions:
                with self.assertRaisesRegex(ProviderError, '^system_stopped$'):
                    action()
            provider.assert_not_called()
        for settings in ({'auto_reconnect': True, 'auto_wake': False},
                         {'auto_reconnect': False, 'auto_wake': True}):
            with self.assertRaisesRegex(ProviderError, '^system_stopped$'):
                subject.update_settings(settings)
        self.assert_paused(subject)

    def test_direct_tunnel_start_discovers_wake_capability_before_launching_gh(self):
        subject = self.supervisor(prepare=False)
        spec = {'command': [sys.executable, '-c', 'import time; time.sleep(120)', 'fixture-tunnel'],
                'pid_file': str(self.root / 'tunnel.pid')}
        subject.config['components']['tunnel'] = spec
        subject.state.register_component('tunnel', spec)

        def provider(method, params=None):
            if method == 'describe':
                return {'id': 'fixture', 'label': 'Test host', 'capabilities': ['host.wake', 'host.stop']}
            if method == 'connection':
                return {'relay_url': self.config['relay_url']}
            if method == 'status':
                return {'host_state': 'stopped'}
            raise AssertionError(f'unexpected provider mutation: {method}')

        with patch.object(subject.provider, 'call', side_effect=provider):
            with self.assertRaisesRegex(ProviderError, '^host_stopped$'):
                subject.start_component('tunnel')
        self.assertFalse(subject.processes.children)
        self.assertEqual(subject.state.host_value(), 'stopped')

    def test_tunnel_restart_command_is_also_gated_by_fresh_power_state(self):
        subject = self.supervisor(prepare=False)
        spec = {'start_command': ['/bin/true'], 'stop_command': ['/bin/true'], 'restart_command': ['/bin/true']}
        subject.config['components']['tunnel'] = spec
        subject.state.register_component('tunnel', spec)

        def provider(method, params=None):
            if method == 'describe':
                return {'id': 'fixture', 'label': 'Test host', 'capabilities': ['host.wake', 'host.stop']}
            if method == 'connection':
                return {'relay_url': self.config['relay_url']}
            if method == 'status':
                return {'host_state': 'stopped'}
            raise AssertionError(f'unexpected provider mutation: {method}')

        with patch.object(subject.provider, 'call', side_effect=provider), \
                patch.object(subject, '_run') as run:
            with self.assertRaisesRegex(ProviderError, '^host_stopped$'):
                subject.restart_component('tunnel')
        run.assert_not_called()
        self.assertEqual(subject.state.host_value(), 'stopped')

    def test_remote_only_stop_blocks_recover_restart_and_settings_until_explicit_resume(self):
        subject = self.supervisor()
        subject.suspend_recovery()
        with patch.object(subject.provider, 'call') as provider:
            for action in (lambda: subject.recover(wake=True),
                           lambda: subject.remote(restart=True),
                           lambda: subject.start_component('tunnel')):
                with self.assertRaisesRegex(ProviderError, '^host_stopped$'):
                    action()
            provider.assert_not_called()
        with self.assertRaisesRegex(ProviderError, '^host_stopped$'):
            subject.update_settings({'auto_reconnect': True, 'auto_wake': True})
        self.assert_paused(subject)

    def test_restart_and_network_changes_cannot_revive_a_partially_saved_stop(self):
        subject = self.supervisor()
        subject.suspend_recovery(system=True)
        # Simulate a crash after intent was saved but before settings were saved.
        (subject.directory / 'settings.json').write_text(json.dumps({'auto_reconnect': True, 'auto_wake': True}))
        reloaded = self.supervisor(prepare=False)
        self.assert_paused(reloaded)
        self.assertEqual(startup_components(reloaded), [])
        with patch.object(reloaded, 'provider_call', return_value={'host_state': 'stopped'}) as calls, \
                patch.object(reloaded, 'recover') as recover, \
                patch.object(reloaded, 'start_component') as start:
            for _ in range(3):
                reloaded.network_changed()
                reloaded.tick()
            recover.assert_not_called()
            start.assert_not_called()
            self.assertTrue(all(call.args[0] == 'status' for call in calls.call_args_list))
        self.assert_paused(reloaded)

    def test_failed_takeover_keeps_recovery_paused_and_clears_the_busy_state(self):
        subject = self.supervisor()
        subject.operation.acquire()
        with patch.object(subject.coordinator, 'begin', side_effect=ProviderError('configuration_error')):
            subject.submit({'component': 'all', 'action': 'stop', 'confirmed': True})
            subject.operation.release()
            self.wait_for(lambda: not subject.state.recovery_value('busy'))
        self.assertIsNone(subject.pending_stop)
        self.assertFalse(subject.state.recovery_value('busy'))
        self.assert_paused(subject)
        with patch.object(subject.provider, 'call') as provider:
            with self.assertRaisesRegex(ProviderError, '^system_stopped$'):
                subject.recover(wake=True)
            provider.assert_not_called()

    def test_cloud_confirmation_survives_temporary_status_failures_without_repeating_stop(self):
        subject = self.supervisor()
        with patch.object(subject.provider, 'call', side_effect=[
                {'host_state': 'stopping'}, ProviderError('provider_timeout'),
                {'host_state': 'stopping'}, {'host_state': 'stopped'}]) as calls, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.stop_host()
        self.assertEqual([call.args[0] for call in calls.call_args_list],
                         ['host.stop', 'status', 'status', 'status'])
        self.assertEqual(subject.state.host_value(), 'stopped')
        remote = next(node for node in subject.snapshot()['topology']['nodes'] if node['id'] == 'remote')
        self.assertIsNotNone(remote['checked_at'])
        self.assert_paused(subject)

    def test_lost_stop_response_is_confirmed_by_status_not_treated_as_failure(self):
        subject = self.supervisor()
        with patch.object(subject.provider, 'call', side_effect=[
                ProviderError('provider_failed'), {'host_state': 'stopped'}]) as calls, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.stop_host()
        self.assertEqual([call.args[0] for call in calls.call_args_list], ['host.stop', 'status'])
        self.assertEqual(subject.state.host_value(), 'stopped')
        self.assert_paused(subject)

    def test_unconfirmed_stop_never_reports_stopped_or_reenables_recovery(self):
        subject = self.supervisor()
        subject.state.set_host_state('stopped')  # Old evidence cannot confirm a new stop.
        with patch.object(subject.provider, 'call', side_effect=ProviderError('provider_timeout')), \
                patch.object(subject.stop, 'wait', return_value=False), \
                patch.object(subject, 'clock', side_effect=[0, HOST_STOP_TIMEOUT + 1]):
            with self.assertRaisesRegex(ProviderError, '^host_stop_timeout$'):
                subject.stop_host()
        self.assertEqual(subject.state.host_value(), 'unknown')
        self.assert_paused(subject)

    def test_local_stop_exception_does_not_skip_cloud_shutdown(self):
        self.config['components']['gateway'] = {
            'start_command': ['/bin/true'], 'stop_command': ['/bin/true']}
        subject = self.supervisor()
        with patch.object(subject, 'stop_component', side_effect=OSError('fixture local stop failure')), \
                patch.object(subject.provider, 'call', return_value={'host_state': 'stopped'}) as provider:
            identifier = subject.submit({'component': 'all', 'action': 'stop', 'confirmed': True})
            run = self.wait_operation(subject, identifier)
        provider.assert_called_once_with('host.stop', None)
        self.assertEqual(run['status'], 'failed')
        self.assertEqual(subject.state.host_value(), 'stopped')
        self.assert_paused(subject)

    def test_unknown_power_state_never_starts_a_wake_capable_transport(self):
        provider = json.loads(self.provider_config.read_text())
        provider['connection']['tunnel'] = {
            'command': [sys.executable, '-c', 'import time; time.sleep(120)', 'fixture-tunnel'],
            'port': int(self.config['relay_url'].rsplit(':', 1)[1]),
        }
        self.provider_config.write_text(json.dumps(provider))
        def provider(method, params=None):
            if method == 'status':
                return {'host_state': 'unknown'}
            raise AssertionError(f'unexpected provider mutation: {method}')

        subject = self.supervisor()
        with patch.object(subject.provider, 'call', side_effect=provider), \
                patch.object(subject, 'probe', return_value='unreachable'), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'start_component') as start, \
                patch.object(subject.stop, 'wait', return_value=False):
            with self.assertRaisesRegex(ProviderError, '^unreachable$'):
                subject.recover(wake=True)
        restart.assert_not_called()
        start.assert_not_called()
        self.assertFalse(subject.processes.children)
        self.assertEqual(subject.state.host_value(), 'unknown')
        with patch.object(subject.provider, 'call', return_value={'host_state': 'unknown'}):
            with self.assertRaisesRegex(ProviderError, '^host_unavailable$'):
                subject.start_component('tunnel')
        self.assertFalse(subject.processes.children)

    def test_script_reuses_the_supervisor_operation_and_waits_for_confirmed_stop(self):
        initial = {'remote': {'capabilities': ['host.stop']}}
        running = {'busy': True, 'settings': {'auto_reconnect': False, 'auto_wake': False},
                   'remote': {'capabilities': ['host.stop'], 'host_state': 'stopping'},
                   'topology': {'intent': {'system': 'stopped', 'remote': 'stopped'}, 'run': {'request_id': '', 'target': 'all', 'action': 'stop', 'status': 'running'}}}
        completed = {'busy': False, 'settings': {'auto_reconnect': False, 'auto_wake': False},
                     'remote': {'capabilities': ['host.stop'], 'host_state': 'stopped'},
                     'topology': {'intent': {'system': 'stopped', 'remote': 'stopped'}, 'run': {'request_id': '', 'target': 'all', 'action': 'stop', 'status': 'completed'}}}
        calls = []
        accepted = {}

        def control(socket, method, endpoint, body=None):
            calls.append((method, endpoint, body))
            if method == 'GET':
                return 200, initial if len(calls) == 1 else completed
            accepted.update(body)
            running['topology']['run']['request_id'] = body['request_id']
            completed['topology']['run']['request_id'] = body['request_id']
            return 202, {'accepted': True}

        with patch('supervision.shutdown.private_json', return_value={'profile': str(self.root)}), \
                patch('supervision.shutdown.validate'), \
                patch('supervision.shutdown.control_request', side_effect=control):
            result = shutdown(self.root / 'config.json', report=lambda _: None)
        self.assertEqual(result['remote']['host_state'], 'stopped')
        self.assertEqual(accepted['action'], 'stop')
        self.assertEqual(accepted['component'], 'all')
        self.assertTrue(accepted['confirmed'])
        self.assertRegex(accepted['request_id'], '^[a-f0-9]{32}$')
        self.assertEqual([method for method, _, _ in calls].count('POST'), 1)

    def test_script_retries_a_lost_accepted_response_with_the_same_request(self):
        accepted = []
        running = {'busy': True, 'settings': {'auto_reconnect': False, 'auto_wake': False},
                   'remote': {'capabilities': ['host.stop'], 'host_state': 'stopping'},
                   'topology': {'intent': {'system': 'stopped', 'remote': 'stopped'}, 'run': {'request_id': '', 'target': 'all', 'action': 'stop', 'status': 'running'}}}
        completed = {'busy': False, 'settings': {'auto_reconnect': False, 'auto_wake': False},
                     'remote': {'capabilities': ['host.stop'], 'host_state': 'stopped'},
                     'topology': {'intent': {'system': 'stopped', 'remote': 'stopped'}, 'run': {'request_id': '', 'target': 'all', 'action': 'stop', 'status': 'completed'}}}
        responses = [
            (200, {'remote': {'capabilities': ['host.stop']}}),
            (None, None),
            (202, {'accepted': True}),
        ] + [(200, completed)] * 4

        def control(socket, method, endpoint, body=None):
            response = responses.pop(0)
            if method == 'POST':
                accepted.append(body['request_id'])
                running['topology']['run']['request_id'] = body['request_id']
                completed['topology']['run']['request_id'] = body['request_id']
            return response

        with patch('supervision.shutdown.private_json', return_value={'profile': str(self.root)}), \
                patch('supervision.shutdown.validate'), \
                patch('supervision.shutdown.control_request', side_effect=control), \
                patch('supervision.shutdown.time.sleep'):
            result = shutdown(self.root / 'config.json', report=lambda _: None)
        self.assertEqual(result['remote']['host_state'], 'stopped')
        self.assertEqual(accepted, [accepted[0], accepted[0]])
        self.assertEqual(len(set(accepted)), 1, 'lost response must not create a second shutdown request')

    def test_script_refuses_a_missing_supervisor_and_unsupported_remote_power(self):
        with patch('supervision.shutdown.private_json', return_value={'profile': str(self.root)}), \
                patch('supervision.shutdown.validate'), \
                patch('supervision.shutdown.control_request', return_value=(None, None)):
            with self.assertRaisesRegex(ProviderError, '^supervisor_unavailable$'):
                shutdown(self.root / 'config.json', report=lambda _: None)
        with patch('supervision.shutdown.private_json', return_value={'profile': str(self.root)}), \
                patch('supervision.shutdown.validate'), \
                patch('supervision.shutdown.control_request', return_value=(200, {'remote': {'capabilities': []}})):
            with self.assertRaisesRegex(ProviderError, '^unsupported_operation$'):
                shutdown(self.root / 'config.json', remote_only=True, report=lambda _: None)

    def test_script_reports_an_unconfirmed_shutdown_instead_of_claiming_stopped(self):
        responses = [
            (200, {'remote': {'capabilities': ['host.stop']}}),
            (202, {'accepted': True}),
            (200, {'busy': False, 'settings': {'auto_reconnect': False, 'auto_wake': False},
                   'remote': {'capabilities': ['host.stop'], 'host_state': 'running'},
                   'topology': {'intent': {'system': 'stopped', 'remote': 'stopped'},
                                'run': {'request_id': '', 'target': 'all', 'action': 'stop', 'status': 'completed'}}}),
        ]
        completed = responses[-1][1]
        with patch('supervision.shutdown.private_json', return_value={'profile': str(self.root)}), \
                patch('supervision.shutdown.validate'), \
                patch('supervision.shutdown.control_request', side_effect=lambda *args, **kwargs:
                      responses.pop(0) if len(responses) > 1 else (200, completed)), \
                patch('supervision.shutdown.time.monotonic', side_effect=[0, 1, 2]):
            with self.assertRaisesRegex(ProviderError, '^host_stop_timeout$'):
                shutdown(self.root / 'config.json', timeout=1, report=lambda _: None)

    def test_shutdown_discovers_and_stops_a_tunnel_left_by_a_previous_supervisor(self):
        provider = json.loads(self.provider_config.read_text())
        provider['connection']['tunnel'] = {
            'command': [sys.executable, '-c', 'import time; time.sleep(120)', 'fixture-tunnel'],
            'port': int(self.config['relay_url'].rsplit(':', 1)[1]),
        }
        self.provider_config.write_text(json.dumps(provider))
        first = self.supervisor()
        first.start_component('tunnel')
        child = first.processes.children['tunnel']

        def cleanup_child():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        self.addCleanup(cleanup_child)
        reloaded = self.supervisor(prepare=False)
        identifier = reloaded.submit({'component': 'all', 'action': 'stop', 'confirmed': True})
        run = self.wait_operation(reloaded, identifier)
        self.assertEqual(run['status'], 'completed')
        self.assertIsNotNone(child.poll())
        self.assert_paused(reloaded)
