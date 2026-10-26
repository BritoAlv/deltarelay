#!/usr/bin/env python3
"""Recover the existing private Codespace test profile, without replaying inference."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import sys
import time

from recover_relay import LinkError, RecoveryError, owned_pid, private_text, relay_info, write_pid


def run(command, timeout, input=None):
    child = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = child.communicate(input=input, timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        # Only this command's isolated process group, never another user's SSH.
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
        if isinstance(error, KeyboardInterrupt):
            raise
        raise LinkError('Connection attempt timed out') from None
    if child.returncode in (73, 74):
        try:
            detail = json.loads(stdout)['error']
        except (ValueError, KeyError):
            detail = 'Remote recovery refused unsafe or incomplete state'
        raise (LinkError if child.returncode == 74 else RecoveryError)(detail)
    if child.returncode:
        detail = stderr.strip().splitlines()
        message = detail[-1][:400] if detail else f'Command failed (exit {child.returncode})'
        if any(f'HTTP {status}' in stderr for status in (400, 401, 403, 404, 422)):
            raise RecoveryError(message)
        raise LinkError(message)
    return stdout


def retry(label, operation, deadline):
    delay = 2
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RecoveryError(f'{label} timed out; safe to rerun recovery after the connection improves')
        try:
            result = operation(remaining)
            if result is not None:
                return result
        except LinkError as error:
            print(f'{label}: {error}; retrying', flush=True)
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
        delay = min(delay * 2, 30)


def ensure_codespace(name, deadline):
    endpoint = f'/user/codespaces/{name}'

    def attempt(remaining):
        info = json.loads(run(['gh', 'api', '--method', 'GET', endpoint, '--jq',
                               '{state, idle_timeout_minutes}'], min(30, remaining)))
        state = info['state']
        if state == 'Available':
            return info
        if state == 'Shutdown':
            print('Starting the existing Codespace (GitHub usage/billing resumes)', flush=True)
            remaining = deadline - time.monotonic()
            if remaining > 0:
                run(['gh', 'api', '--method', 'POST', endpoint + '/start', '--silent'], min(30, remaining))
        elif state not in ('Starting', 'Queued', 'Provisioning', 'ShuttingDown', 'Awaiting'):
            raise RecoveryError(f'Codespace state is {state}; refusing to recreate or force-restart it')
        return None

    return retry('Codespace readiness', attempt, deadline)


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def ensure_process(root, pidfile, command, expected, logname, port):
    if owned_pid(root / pidfile, expected) is not None:
        return False
    if port_open(port):
        raise RecoveryError(f'Port {port} has an unrecognized owner; no process was stopped or replaced')
    fd = os.open(root / 'logs' / logname, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'ab') as log:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 cwd=root, start_new_session=True)
    write_pid(root / pidfile, child.pid)
    return True


def recover(root, codespace, remote_directory, timeout):
    binary = root / 'deltarelay-linux-amd64'
    supervisor = root / 'tunnel-supervisor.sh'
    for path in (binary, supervisor, root / 'upstreams.json'):
        if not path.is_file():
            raise RecoveryError(f'Missing existing profile file: {path}')
    expected = json.loads(private_text(root / 'state' / 'relay-state.json'))
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise RecoveryError('Invalid local relay identity; no state was reset')
    # Validate token permissions before starting anything; values stay out of argv/logs.
    private_text(root / 'relay.token')
    private_text(root / 'local.token')
    if f'CODESPACE={codespace}' not in supervisor.read_text().splitlines():
        raise RecoveryError('Codespace does not match the existing tunnel supervisor')
    deadline = time.monotonic() + timeout
    info = ensure_codespace(codespace, deadline)
    print(f"Codespace available; existing idle timeout: {info['idle_timeout_minutes']} minutes (unchanged)", flush=True)
    remote = Path(__file__).with_name('recover_relay.py').read_text()
    command = ['gh', 'codespace', 'ssh', '-c', codespace, '--', '-o', 'BatchMode=yes',
               '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
               shlex.join(['python3', '-', '--root', remote_directory, '--expected-state-id', expected])]
    result = retry('Remote relay recovery', lambda remaining: json.loads(run(command, min(90, remaining), input=remote)), deadline)
    if result.get('state_id') != expected:
        raise RecoveryError('Remote relay identity mismatch; local state was not changed')
    print('Remote relay ' + ('started' if result['started'] else 'already running') + '; saved identity preserved', flush=True)
    ensure_process(root, 'tunnel.pid', ['bash', str(supervisor)], [str(supervisor)], 'tunnel-supervisor.log', 18787)

    def tunnel_ready(remaining):
        if relay_info(18787, private_text(root / 'relay.token'), expected, timeout=min(5, remaining)) is not None:
            return True
        return None

    retry('Private tunnel readiness', tunnel_ready, deadline)
    gateway = [str(binary), 'gateway', '--listen', '127.0.0.1:18788', '--server', 'http://127.0.0.1:18787',
               '--token-file', str(root / 'relay.token'), '--local-token-file', str(root / 'local.token'),
               '--upstreams', str(root / 'upstreams.json'), '--state-dir', str(root / 'state')]
    ensure_process(root, 'gateway.pid', gateway, gateway, 'gateway.log', 18788)
    doctor = [str(binary), 'doctor', '--gateway', 'http://127.0.0.1:18788',
              '--local-token-file', str(root / 'local.token')]
    result = retry('Gateway readiness', lambda remaining: run(doctor, min(15, remaining)), deadline)
    print(result.strip(), flush=True)
    print('Ready. No model generation was submitted. Desktop and provider credentials were left unchanged.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codespace', required=True)
    parser.add_argument('--profile', type=Path, default=Path(__file__).resolve().parents[1] / '.runtime/codespace-test')
    parser.add_argument('--remote-directory', default='~/.local/share/deltarelay/codespace-test',
                        help='existing remote deployment directory (default: %(default)s; ~ uses the remote home)')
    parser.add_argument('--timeout', type=int, default=600, help='total retry window in seconds (default: 600)')
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error('--timeout must be positive')
    try:
        root = args.profile.resolve(strict=True)
        fd = os.open(root / '.recovery.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RecoveryError('Another recovery command is already running for this profile') from None
            recover(root, args.codespace, args.remote_directory, args.timeout)
    except (RecoveryError, OSError, ValueError) as error:
        print(f'Recovery failed: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('Recovery cancelled. Existing services and saved state were left intact.', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())
