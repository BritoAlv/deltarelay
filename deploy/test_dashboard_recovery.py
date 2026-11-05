"""Exercise dashboard power controls through the real HTTP and provider stack, offline."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from supervision.control import Handler, Server
from supervision.supervisor import Supervisor


FAKE_GH = '''import asyncio, json, sys, time
from pathlib import Path
config = json.loads(Path(__file__).with_suffix('.json').read_text())
args = sys.argv[1:]
with open(config['log'], 'a') as log: log.write(json.dumps(args) + '\\n')
state = Path(config['state'])
if args[0] == 'api':
    method = args[args.index('--method') + 1]
    if method == 'GET': print(json.dumps({'state': state.read_text()}))
    elif method == 'POST': state.write_text('Shutdown' if args[3].endswith('/stop') else 'Available')
elif args[:3] == ['codespace', 'ports', 'forward']:
    assert state.read_text() == 'Available', 'forwarding must not implicitly wake the host'
    remote, local = map(int, args[3].split(':'))
    assert remote == config['remote_port'], 'gh expects remote:local, not local:remote'
    time.sleep(0.2)
    async def pump(reader, writer):
        try:
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
        finally:
            writer.close()
    async def accept(reader, writer):
        try:
            source, destination = await asyncio.open_connection('127.0.0.1', remote)
        except OSError:
            writer.close()
            return
        tasks = [asyncio.create_task(pump(reader, destination)), asyncio.create_task(pump(source, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks: task.cancel()
    async def main():
        server = await asyncio.start_server(accept, '127.0.0.1', local)
        async with server: await server.serve_forever()
    asyncio.run(main())
else:
    raise SystemExit('SSH recovery must not run before trying the existing relay through its tunnel')
'''


@unittest.skipUnless(os.environ.get('DELTARELAY_RECOVERY_TEST_BINARY'),
                     'set DELTARELAY_RECOVERY_TEST_BINARY for dashboard-to-Codespaces lifecycle tests')
class DashboardRecoveryTest(unittest.TestCase):
    def test_dashboard_stop_wake_and_recover_complete_the_connection_with_background_recovery_off(self):
        binary = str(Path(os.environ['DELTARELAY_RECOVERY_TEST_BINARY']).resolve())
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)

        def private(name, value):
            path = root / name
            path.write_text(value)
            path.chmod(0o600)
            return path

        def free_port():
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                return listener.getsockname()[1]

        def stop_child(child):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
            child.wait(timeout=5)

        relay_port, tunnel_port, gateway_port, dashboard_port = [free_port() for _ in range(4)]
        relay_token = private('relay.token', 'fixture-relay-token')
        local_token = private('local.token', 'fixture-local-token')
        upstreams = private('upstreams.json', '[{"name":"mock","origin":"https://example.invalid","path_prefix":"/v1/"}]')
        log = (root / 'relay.log').open('ab')
        self.addCleanup(log.close)
        relay = subprocess.Popen([binary, 'serve', '--listen', f'127.0.0.1:{relay_port}',
                                  '--data', str(root / 'cache'), '--token-file', str(relay_token),
                                  '--upstreams', str(upstreams)], stdout=log, stderr=log)
        self.addCleanup(stop_child, relay)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 10
        while True:
            try:
                request = urllib.request.Request(f'http://127.0.0.1:{relay_port}/info',
                                                 headers={'Authorization': 'Bearer fixture-relay-token'})
                with opener.open(request, timeout=1) as response:
                    identity = json.load(response)['state_id']
                break
            except OSError:
                if relay.poll() is not None or time.monotonic() >= deadline:
                    self.fail('fixture relay did not start')
                time.sleep(0.05)
        pin = private('relay-state.json', json.dumps(identity))
        cli = private('fake-gh', '#!' + sys.executable + '\n' + FAKE_GH)
        cli.chmod(0o700)
        state = private('host.state', 'Shutdown')
        commands = root / 'commands.jsonl'
        private('fake-gh.json', json.dumps({'state': str(state), 'log': str(commands), 'remote_port': relay_port}))
        provider = private('codespaces.json', json.dumps({
            'name': 'fixture-codespace', 'remote_directory': '~/existing-relay',
            'relay_url': f'http://127.0.0.1:{tunnel_port}', 'remote_port': relay_port, 'github_cli': str(cli),
        }))
        origin = f'http://127.0.0.1:{dashboard_port}'
        gateway_url = f'http://127.0.0.1:{gateway_port}'
        control_socket = root / 'control/supervisor.sock'
        subject = Supervisor({
            'version': 1, 'profile': str(root), 'relay_url': f'http://127.0.0.1:{tunnel_port}',
            'gateway_url': gateway_url, 'relay_token_file': str(relay_token),
            'local_token_file': str(local_token), 'relay_state_file': str(pin),
            'remote': {'command': [sys.executable, '-B', str(Path(__file__).resolve().parent / 'providers/codespaces.py')],
                       'config_file': str(provider)},
            'components': {
                'gateway': {'command': [binary, 'gateway', '--listen', f'127.0.0.1:{gateway_port}',
                                        '--server', f'http://127.0.0.1:{tunnel_port}', '--token-file', str(relay_token),
                                        '--local-token-file', str(local_token), '--upstreams', str(upstreams),
                                        '--state-dir', str(root)],
                            'pid_file': str(root / 'gateway.pid'), 'port': gateway_port},
                'dashboard': {'command': [binary, 'dashboard', '--listen', f'127.0.0.1:{dashboard_port}',
                                          '--gateway', gateway_url, '--local-token-file', str(local_token),
                                          '--control-socket', str(control_socket), '--assets='],
                              'pid_file': str(root / 'dashboard.pid'), 'port': dashboard_port},
            },
        })

        def cleanup():
            subject.stop.set()
            if subject.operation.acquire(timeout=5):
                subject.operation.release()
            for child in subject.processes.children.values():
                stop_child(child)
            subject.close()

        self.addCleanup(cleanup)

        def get(path):
            with opener.open(origin + path, timeout=5) as response:
                return json.load(response)

        def wait_status(predicate):
            deadline = time.monotonic() + 15
            status = None
            while time.monotonic() < deadline:
                try:
                    status = get('/api/system')
                    if predicate(status):
                        return status
                except OSError:
                    pass
                time.sleep(0.05)
            self.fail(f'dashboard did not reach expected state: {status}')

        def action(name, action, confirmed=True):
            status = get('/api/system')
            request = urllib.request.Request(origin + '/api/system/action', method='POST',
                                             data=json.dumps({'component': name, 'action': action, 'confirmed': confirmed}).encode(),
                                             headers={'Origin': origin, 'Content-Type': 'application/json',
                                                      'X-DeltaRelay-Control': status['csrf_token']})
            try:
                response = opener.open(request, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.load(response)

        with Server(str(control_socket), Handler) as server, patch.object(subject.probes, 'internet', return_value='connected'):
            server.supervisor = subject
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.shutdown)
            subject.update_settings({'auto_reconnect': False, 'auto_wake': False})
            saved = {path: path.read_bytes() for path in (pin, relay_token, local_token, subject.directory / 'settings.json')}
            subject.start_component('dashboard')
            subject.start_component('gateway')
            subject.tick()
            initial = wait_status(lambda status: status['remote']['host_state'] == 'stopped')
            self.assertEqual(initial['relay_state'], 'unreachable')
            self.assertEqual(action('remote', 'wake', confirmed=False)[0], 409)
            self.assertEqual(state.read_text(), 'Shutdown')
            gateway_pid = subject.processes.children['gateway'].pid
            for cycle in range(2):
                self.assertEqual(action('remote', 'wake'), (202, {'accepted': True}))
                status = wait_status(lambda status: status['recovery']['busy'] and status['remote']['host_state'] == 'running')
                self.assertNotEqual(status['relay_state'], 'connected', 'provider availability must not substitute for relay health')
                status = wait_status(lambda status: not status['recovery']['busy'])
                self.assertEqual(status['recovery']['last_error'], '')
                self.assertEqual(status['relay_state'], 'connected')
                self.assertIsNotNone(status['recovery']['last_connected_at'])
                self.assertTrue(get('/api/dashboard')['relay']['reachable'])
                self.assertEqual(status['settings'], {'auto_reconnect': False, 'auto_wake': False})
                self.assertEqual(action('all', 'recover', confirmed=False), (202, {'accepted': True}))
                status = wait_status(lambda status: not status['recovery']['busy'])
                self.assertEqual(status['recovery']['last_error'], '')
                self.assertEqual(status['relay_state'], 'connected')
                self.assertEqual(subject.processes.children['gateway'].pid, gateway_pid)
                if cycle == 0:
                    self.assertEqual(action('remote', 'stop'), (202, {'accepted': True}))
                    status = wait_status(lambda status: not status['recovery']['busy'])
                    self.assertEqual(status['remote']['host_state'], 'stopped')
                    self.assertEqual(status['relay_state'], 'unreachable')
                    self.assertIsNotNone(subject.processes.children['tunnel'].poll())
                    self.assertIsNone(subject.processes.children['gateway'].poll())
                    self.assertIsNone(subject.processes.children['dashboard'].poll())
            for path, value in saved.items():
                self.assertEqual(path.read_bytes(), value)
            calls = [json.loads(line) for line in commands.read_text().splitlines()]
            self.assertEqual(sum(call[:3] == ['api', '--method', 'POST'] and call[3].endswith('/start') for call in calls), 2)
            self.assertFalse(any(call[:2] == ['codespace', 'ssh'] for call in calls))
            self.assertEqual(sum(call[:3] == ['codespace', 'ports', 'forward'] for call in calls), 2)
            server.shutdown()
