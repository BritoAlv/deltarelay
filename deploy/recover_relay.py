#!/usr/bin/env python3
"""Sent over SSH by recover_codespace.py; never creates a new relay store."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


class RecoveryError(Exception):
    pass


class LinkError(RecoveryError):
    pass


def private_text(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 4096:
        raise RecoveryError(f"Expected a small private regular file: {path}")
    return path.read_text().strip()


def owned_pid(path, expected):
    try:
        pid = int(path.read_text().strip())
        proc = Path('/proc') / str(pid)
        if pid <= 1 or proc.stat().st_uid != os.getuid():
            return None
        args = os.fsdecode((proc / 'cmdline').read_bytes()).split('\0')
        return pid if all(part in args for part in expected) else None
    except (OSError, ValueError):
        return None


def write_pid(path, pid):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(f'{pid}\n')
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def relay_info(port, token, expected, timeout=5):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(
        f'http://127.0.0.1:{port}/v2/info',
        headers={'Authorization': f'Bearer {token}'},
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            info = json.loads(response.read(65537))
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        raise RecoveryError(f'Relay authentication/health failed (HTTP {code})') from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, ConnectionRefusedError):
            return None
        raise LinkError('Relay health connection failed; no process replaced') from None
    except OSError:
        raise LinkError('Relay health connection timed out or dropped; no process replaced') from None
    except ValueError:
        raise RecoveryError('Invalid relay health response; no process replaced') from None
    if not isinstance(info, dict):
        raise RecoveryError('Invalid relay health response; no process replaced')
    if info.get('version') != 2 or info.get('state_id') != expected:
        raise RecoveryError('Relay protocol or identity mismatch; no state was reset')
    if not info.get('forwarding'):
        raise RecoveryError('Relay forwarding is disabled; check the upstream allowlist')
    return info


def saved_store(root, expected):
    matches = []
    for identity in root.glob('*/mailbox/identity.json'):
        if json.loads(private_text(identity)) == expected:
            matches.append(identity.parent.parent)
    if len(matches) != 1:
        raise RecoveryError('Expected exactly one existing store matching the local relay identity; refusing to initialize or reset state')
    return matches[0]


def ensure_relay(root, expected, port=18787):
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise RecoveryError('Invalid pinned relay identity')
    if not root.is_dir():
        raise RecoveryError('Remote deployment is missing; recovery does not redeploy it')
    data = saved_store(root, expected)
    token = private_text(root / 'relay.token')
    if not token or '\n' in token or '\r' in token:
        raise RecoveryError('Invalid relay token file')
    info = relay_info(port, token, expected)
    if info is not None:
        return {'started': False, 'state_id': expected, 'data_directory': str(data)}
    binary = root / 'deltarelay-linux-amd64'
    pid = owned_pid(root / 'server.pid', [str(binary), 'serve'])
    child = None
    if pid is None:
        if not binary.is_file() or not os.access(binary, os.X_OK) or not (root / 'upstreams.json').is_file():
            raise RecoveryError('Remote binary or allowlist is missing; no files were replaced')
        # The server also takes this lock. Do not launch a second owner if PID
        # metadata was lost while the original server is still starting.
        with (data / '.server.lock').open('r+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RecoveryError('Existing store is owned by a live server; no duplicate launched') from None
        command = [
            str(binary), 'serve', '--listen', f'127.0.0.1:{port}',
            '--data', str(data), '--token-file', str(root / 'relay.token'),
            '--upstreams', str(root / 'upstreams.json'),
            '--max-cache-bytes', str(2 << 30), '--max-journal-records', '10000',
        ]
        fd = os.open(root / 'recovery-server.log', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'ab') as log:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=root, start_new_session=True)
        write_pid(root / 'server.pid', child.pid)
    for _ in range(15):
        if child is not None and child.poll() is not None:
            raise RecoveryError('Remote relay exited; inspect the private recovery-server.log')
        if relay_info(port, token, expected) is not None:
            return {'started': child is not None, 'state_id': expected, 'data_directory': str(data)}
        time.sleep(1)
    raise LinkError('Existing relay did not become ready; no process was killed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--expected-state-id', required=True)
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        fd = os.open(root / '.recovery.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(ensure_relay(root, args.expected_state_id)))
    except LinkError as error:
        print(json.dumps({'error': str(error)}))
        return 74
    except (RecoveryError, OSError, ValueError) as error:
        print(json.dumps({'error': str(error)}))
        return 73
    return 0


if __name__ == '__main__':
    sys.exit(main())
