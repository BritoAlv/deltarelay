"""Component contracts, incremental recovery, network hints and shutdown intent."""

import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from remote_provider import ProviderError
from supervision.contracts import ConnectionFacts, Step, next_connection_step
from supervision.network import NetworkMonitor, fingerprint
from supervision.supervisor import Supervisor
from test_support import configure_provider


def make_config(root):
    for name, value in (('relay.token', 'relay-secret'), ('local.token', 'local-secret'),
                        ('identity.json', json.dumps('a' * 64))):
        path = root / name
        path.write_text(value)
        path.chmod(0o600)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        relay_url = f'http://127.0.0.1:{listener.getsockname()[1]}'
    return {'version': 1, 'profile': str(root), 'relay_url': relay_url,
            'gateway_url': 'http://127.0.0.1:18788',
            'relay_token_file': str(root / 'relay.token'),
            'local_token_file': str(root / 'local.token'),
            'relay_state_file': str(root / 'identity.json'),
            'components': {}}


class ConnectionPolicyTest(unittest.TestCase):
    def test_order_is_bounded_and_does_not_cycle_between_tunnel_and_relay(self):
        facts = ConnectionFacts()
        self.assertEqual(next_connection_step(facts).action, 'observe')
        facts.relay = 'unreachable'
        self.assertEqual(next_connection_step(facts).component, 'remote_provider')
        facts.provider_ready = True
        self.assertEqual(next_connection_step(facts).component, 'remote')
        facts.host_checked = True
        facts.host = 'stopped'
        self.assertEqual(next_connection_step(facts), type(next_connection_step(facts))('remote', 'blocked'))
        facts.wake = facts.can_wake = True
        self.assertEqual(next_connection_step(facts).action, 'wake')
        facts.wake = False
        facts.host = 'running'
        facts.has_tunnel = True
        self.assertEqual(next_connection_step(facts), type(next_connection_step(facts))('tunnel', 'recover'))
        facts.tunnel_repairs = 1
        facts.verification_due = True
        self.assertEqual(next_connection_step(facts).action, 'verify')
        facts.verification_due = False
        self.assertEqual(next_connection_step(facts).action, 'recover')
        facts.relay_attempted = True
        self.assertEqual(next_connection_step(facts), type(next_connection_step(facts))('tunnel', 'recover'))
        facts.tunnel_repairs = 2
        self.assertIsNone(next_connection_step(facts))

    def test_permanent_and_consent_blockers_are_not_bypassed(self):
        facts = ConnectionFacts(relay='unreachable', provider_ready=True, host_checked=True,
                                host='stopped', wake=False, can_wake=True)
        self.assertEqual(next_connection_step(facts).action, 'blocked')
        facts.wake = True
        self.assertEqual(next_connection_step(facts).action, 'wake')
        facts.host = 'starting'
        self.assertEqual(next_connection_step(facts).action, 'verify')


class NetworkMonitorTest(unittest.TestCase):
    def test_fingerprint_covers_routes_addresses_and_dns(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / 'proc/net').mkdir(parents=True)
            (root / 'sys/class/net/eth0').mkdir(parents=True)
            (root / 'etc').mkdir()
            (root / 'proc/net/route').write_text('Iface Destination')
            (root / 'sys/class/net/eth0/operstate').write_text('up')
            (root / 'etc/resolv.conf').write_text('nameserver 192.0.2.1')
            initial = fingerprint(root)
            (root / 'etc/resolv.conf').write_text('nameserver 192.0.2.2')
            self.assertNotEqual(fingerprint(root), initial)
            changed = fingerprint(root)
            (root / 'sys/class/net/eth0/operstate').write_text('down')
            self.assertNotEqual(fingerprint(root), changed)

    def test_missed_netlink_events_still_fall_back_to_fingerprints(self):
        changed = threading.Event()
        samples = iter([b'one', b'one', b'two'])

        def sample():
            return next(samples, b'two')

        def unavailable(*_):
            raise OSError('netlink unavailable')

        monitor = NetworkMonitor(changed.set, threading.Event(), sample=sample,
                                 socket_factory=unavailable)
        thread = threading.Thread(target=monitor.run, daemon=True)
        thread.start()
        self.assertTrue(changed.wait(3))
        monitor.stop.set()
        thread.join(timeout=3)


class CoordinationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = make_config(self.root)
        self.provider_config = configure_provider(self.config)
        self.children = []

    def add_component(self, name):
        self.config['components'][name] = {
            'command': [sys.executable, '-c', 'import time; time.sleep(120)', name],
            'pid_file': str(self.root / (name + '.pid')),
        }

    def supervisor(self):
        subject = Supervisor(self.config)
        self.addCleanup(subject.close)
        subject.prepare_provider()
        return subject

    def wait_job(self, subject):
        self.assertTrue(subject.operation.acquire(timeout=5), 'background operation did not complete')
        subject.operation.release()

    def cleanup_children(self, subject):
        for child in subject.processes.children.values():
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)

    def test_connection_repairs_only_the_broken_transport_and_verifies_relay(self):
        self.add_component('gateway')
        provider = json.loads(self.provider_config.read_text())
        provider['connection']['tunnel'] = {
            'command': [sys.executable, '-c', 'import time; time.sleep(120)', 'tunnel'],
            'port': int(self.config['relay_url'].rsplit(':', 1)[1]),
        }
        self.provider_config.write_text(json.dumps(provider))
        subject = self.supervisor()
        observed = []

        def tunnel_recover():
            observed.append(subject.state.run_copy())
            subject.state.set_component('tunnel', 'running')

        subject.coordinator.adapters['tunnel'].recover = tunnel_recover
        with patch.object(subject, 'probe', side_effect=['unreachable', 'connected']), \
                patch.object(subject, 'internet_probe', return_value='connected'), \
                patch.object(subject.probes, 'gateway', return_value='ready'), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'start_component') as start, \
                patch.object(subject, 'remote') as remote, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.recover()
        restart.assert_not_called()
        remote.assert_not_called()
        start.assert_called_once_with('gateway')
        self.assertEqual(subject.state.relay_value(), 'connected')
        self.assertEqual(subject.state.run_copy()['status'], 'completed')
        self.assertEqual(observed[0]['current_component'], 'tunnel')
        self.assertEqual(observed[0]['current_action'], 'recover')
        self.assertIn('tunnel', [step['component'] for step in observed[0]['steps']])

    def test_system_shutdown_persists_intent_and_keeps_dashboard_running(self):
        for name in ('dashboard', 'gateway', 'opencode', 'desktop'):
            self.add_component(name)
        with patch.dict(os.environ, {'DISPLAY': ':test'}):
            subject = self.supervisor()
            self.addCleanup(self.cleanup_children, subject)
            for name in ('dashboard', 'gateway', 'opencode', 'desktop'):
                subject.start_component(name)
            dashboard = subject.processes.children['dashboard']
            with patch.object(subject.provider, 'call', side_effect=lambda method, params=None:
                              {'host_state': 'running' if method == 'status' else 'stopped'}):
                subject.submit({'component': 'all', 'action': 'stop', 'confirmed': True})
                self.wait_job(subject)
        self.assertEqual(subject.state.intent_copy()['system'], 'stopped')
        self.assertEqual(subject.state.settings_copy(), {'auto_reconnect': False, 'auto_wake': False})
        self.assertIsNone(dashboard.poll(), 'dashboard must stay running after system shutdown')
        for name in ('gateway', 'opencode', 'desktop'):
            self.assertIsNotNone(subject.processes.children[name].poll(), f'{name} was not stopped')
        reloaded = Supervisor(self.config)
        self.addCleanup(reloaded.close)
        self.assertEqual(reloaded.state.intent_copy()['system'], 'stopped')
        with self.assertRaisesRegex(ProviderError, '^system_stopped$'):
            reloaded.submit({'component': 'gateway', 'action': 'start'})
        with patch.object(reloaded.coordinator, 'start_locals', return_value=None) as start, \
                patch.object(reloaded.coordinator, 'connection') as connection:
            reloaded.submit({'component': 'all', 'action': 'start', 'confirmed': True})
            self.wait_job(reloaded)
        self.assertEqual(reloaded.state.intent_copy()['system'], 'running')
        self.assertTrue(reloaded.state.settings_copy()['auto_reconnect'])
        start.assert_called_once_with()
        connection.assert_called_once_with(wake=True)

    def test_shutdown_fails_closed_when_a_managed_component_has_no_stop_action(self):
        self.config['components']['opencode'] = {'start_command': ['opencode', 'service', 'start']}
        subject = self.supervisor()
        with self.assertRaisesRegex(ProviderError, '^shutdown_not_configured$'):
            subject.coordinator.stop_system()
        self.assertEqual(subject.state.intent_copy()['system'], 'running')
        self.assertFalse((subject.directory / 'intent.json').exists())

    def test_duplicate_request_id_does_not_start_a_second_operation(self):
        self.add_component('desktop')
        with patch.dict(os.environ, {'DISPLAY': ':test'}):
            subject = self.supervisor()
            self.addCleanup(self.cleanup_children, subject)
            request_id = 'b' * 32
            first = subject.submit({'component': 'desktop', 'action': 'start', 'request_id': request_id})
            self.wait_job(subject)
            child = subject.processes.children['desktop']
            second = subject.submit({'component': 'desktop', 'action': 'start', 'request_id': request_id})
            self.assertEqual(first, second)
            self.assertIs(subject.processes.children['desktop'], child)
            self.assertIsNone(child.poll())


class GatewayProbeTest(unittest.TestCase):
    def test_gateway_probe_never_restarts_for_old_binary_or_credentials(self):
        from supervision.probes import RelayProbe
        import urllib.error
        config = {'local_token_file': '/private/local.token',
                  'gateway_url': 'http://127.0.0.1:18788'}
        probe = RelayProbe(config, opener=None)
        for code, wanted in ((404, 'unknown'), (401, 'unknown'), (403, 'unknown'), (503, 'not_ready')):
            with patch('supervision.probes.private_text', return_value='token'), \
                    patch.object(probe, 'read_json', side_effect=urllib.error.HTTPError('http://localhost', code, '', {}, None)):
                self.assertEqual(probe.gateway(), wanted)


if __name__ == '__main__':
    unittest.main()
