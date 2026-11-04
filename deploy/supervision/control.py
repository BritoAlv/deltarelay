"""Unix-socket control API and executable entry point."""

import argparse
import fcntl
import http.client
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import sys
import threading
import urllib.parse

from activity import operation_id

from remote_provider import ProviderError as ControlError, private_json

from .supervisor import Supervisor


def control_request(path, method, endpoint, body=None):
    """Call the private Unix socket without exposing it through a TCP listener."""
    connection = http.client.HTTPConnection('localhost', timeout=2)
    try:
        connection.sock = socket.socket(socket.AF_UNIX)
        connection.sock.settimeout(2)
        connection.sock.connect(str(path))
        data = json.dumps(body) if body is not None else None
        headers = {'Content-Type': 'application/json'} if data is not None else {}
        connection.request(method, endpoint, data, headers)
        response = connection.getresponse()
        value = json.loads(response.read(65537))
        return response.status, value
    except (OSError, ValueError, http.client.HTTPException):
        return None, None
    finally:
        connection.close()


def controller_status(path):
    status, value = control_request(path, 'GET', '/status')
    return value if status == 200 and isinstance(value, dict) and value.get('version') in (1, 2) else None


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log bodies, credentials, commands, or private paths.

    def reply(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/status':
            self.reply(200, self.server.supervisor.snapshot())
        elif self.path.split('?', 1)[0] == '/journal':
            try:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True, strict_parsing=True)
                if set(query) - {'after', 'before', 'limit'} or 'after' in query and 'before' in query:
                    raise ValueError('invalid cursor')
                values = {}
                for key, items in query.items():
                    if len(items) != 1 or not items[0].isascii() or not items[0].isdigit() or len(items[0]) > 16:
                        raise ValueError('invalid cursor')
                    value = int(items[0])
                    if value > 9007199254740991 or key == 'limit' and not 1 <= value <= 100:
                        raise ValueError('invalid cursor')
                    values[key] = value
                self.reply(200, self.server.supervisor.journal.read(**values))
            except ValueError:
                self.reply(400, {'error': 'invalid_request'})
        else:
            self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096 or self.headers.get('Content-Type') != 'application/json':
                raise ControlError('invalid_request')
            value = json.loads(self.rfile.read(length))
            if self.path == '/settings':
                with self.server.supervisor.journal.context(trigger='manual', operation=operation_id()):
                    self.server.supervisor.update_settings(value)
            elif self.path == '/action':
                self.server.supervisor.submit(value)
            else:
                self.reply(404, {'error': 'not_found'})
                return
            self.reply(202, {'accepted': True})
        except ControlError as error:
            with self.server.supervisor.journal.context(trigger='manual'):
                self.server.supervisor.journal.write('error', f'Control request rejected: {error}')
            self.reply(409, {'error': str(error)})
        except (OSError, ValueError):
            self.reply(400, {'error': 'invalid_request'})


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Private, single-user service supervisor. No inference, shell API, or public listener.')
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--no-dashboard', action='store_true')
    parser.add_argument('--no-desktop', action='store_true')
    args = parser.parse_args(argv)
    os.umask(0o077)
    supervisor = Supervisor(private_json(args.config))
    lock = os.open(supervisor.directory / 'supervisor.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    path = supervisor.directory / 'supervisor.sock'
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ControlError('unsafe_socket')
        path.unlink()  # The exclusive lock proves no existing controller owns it.
    with Server(str(path), Handler) as server:
        os.chmod(path, 0o600)
        server.supervisor = supervisor
        server.timeout = 0.5
        signal.signal(signal.SIGTERM, lambda *_: supervisor.stop.set())
        signal.signal(signal.SIGINT, lambda *_: supervisor.stop.set())
        supervisor.state.set_dashboard_enabled(not args.no_dashboard)
        # The independent dashboard comes first, even with no remote network.
        for name in ('dashboard', 'gateway', 'opencode', 'desktop'):
            if name not in supervisor.config['components'] or name == 'dashboard' and args.no_dashboard or name in ('desktop', 'opencode') and args.no_desktop:
                continue
            try:
                supervisor.start_component(name)
                if name == 'dashboard':
                    current = supervisor._identity(name)
                    if current and '--control-socket' not in current['args']:
                        # Upgrade only the positively identified legacy read-only
                        # dashboard. Never replace the gateway or Desktop here.
                        supervisor.restart_component(name)
            except Exception as error:
                supervisor.journal.write('error', f'Startup {name} failed: {type(error).__name__}: {error}')
                supervisor.state.set_component(name, 'start_failed')
        worker = threading.Thread(target=supervisor.monitor, daemon=True)
        worker.start()
        while not supervisor.stop.is_set():
            server.handle_request()
        supervisor.journal.write('event', 'Supervisor shutting down; cancelling pending commands and leaving managed services running')
        # Do not let Python tear down daemon threads while a provider process
        # group is still being cancelled. Managed long-lived services stay up.
        worker.join(timeout=15)
        if supervisor.operation.acquire(timeout=15):
            supervisor.operation.release()
        supervisor.close()
    path.unlink(missing_ok=True)
    # Adopted services remain running when the controller itself stops.
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Supervisor failed; check the private configuration, permissions, and exclusive control lock.', file=sys.stderr)
        sys.exit(1)
