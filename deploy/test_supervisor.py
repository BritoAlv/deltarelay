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


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name, value in [('relay.token', 'relay-secret'), ('local.token', 'local-secret'), ('identity.json', json.dumps('a' * 64))]:
            path = self.root / name
            path.write_text(value)
            path.chmod(0o600)
        self.config = {'version': 1, 'profile': str(self.root), 'relay_url': 'http://127.0.0.1:18787',
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

    def test_hung_live_tunnel_is_rebuilt_without_restarting_gateway_or_relay(self):
        self.component('tunnel')
        self.component('gateway')
        subject = self.supervisor()
        with patch.object(subject, 'probe', side_effect=['unreachable', 'connected']), \
                patch.object(subject, 'restart_component') as restart, \
                patch.object(subject, 'remote') as remote, patch.object(subject.stop, 'wait', return_value=False):
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
        with patch.object(subject, 'probe', return_value='unreachable'), patch.object(subject, 'recover') as recover:
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

    def test_stopped_codespace_only_wakes_with_explicit_permission(self):
        self.config['codespace'] = {'name': 'test-codespace', 'remote_directory': '~/existing-relay'}
        subject = self.supervisor()
        with patch.object(control, 'run_command', return_value=b'{"state":"Shutdown"}') as run:
            with self.assertRaisesRegex(control.ControlError, 'codespace_stopped'):
                subject.remote()
            self.assertEqual(run.call_count, 1)
        for automatic in (False, True):
            subject.settings['auto_wake'] = automatic
            with patch.object(subject, 'remote') as remote, patch.object(subject, 'recover') as recover:
                subject.submit({'component': 'codespace', 'action': 'wake'})
                self.wait_job(subject)
                remote.assert_called_once_with(wake=True)
                recover.assert_called_once()
        with patch.object(control, 'run_command', side_effect=[b'{"state":"Shutdown"}', b'', b'{"state":"Available"}', json.dumps({'state_id': 'a' * 64}).encode()]) as run, \
                patch.object(subject.stop, 'wait', return_value=False):
            subject.remote(wake=True)
            self.assertIn('/user/codespaces/test-codespace/start', run.call_args_list[1].args[0])

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
                subject = control.Supervisor({
                    'version': 1, 'profile': str(root), 'relay_url': f'http://127.0.0.1:{tunnel_port}',
                    'gateway_url': f'http://127.0.0.1:{gateway_port}', 'relay_token_file': str(root / 'relay.token'),
                    'local_token_file': str(root / 'local.token'), 'relay_state_file': str(state),
                    'components': {
                        'tunnel': {'command': [sys.executable, '-c', forwarder, str(tunnel_port), str(server_port)],
                                   'pid_file': str(root / 'tunnel.pid'), 'port': tunnel_port},
                        'gateway': {'command': [binary, 'gateway', '--listen', f'127.0.0.1:{gateway_port}',
                                                '--server', f'http://127.0.0.1:{tunnel_port}', '--token-file', str(root / 'relay.token'),
                                                '--local-token-file', str(root / 'local.token'), '--upstreams', str(root / 'upstreams.json'),
                                                '--allow-private-upstreams', '--state-dir', str(root / 'state'), '--stats-file', str(root / 'stats.json')],
                                    'pid_file': str(root / 'gateway.pid'), 'port': gateway_port},
                    }})
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
            finally:
                for release in releases: release.set()
                if subject:
                    for child in subject.children.values(): SupervisorTest.cleanup_child(child)
                SupervisorTest.cleanup_child(relay)
                log.close()
                provider.shutdown()


if __name__ == '__main__':
    unittest.main()
