#!/usr/bin/env python3
"""First install into a new private remote directory, or resume that exact install.

Executed over trusted SSH with an allowlisted tar payload on stdin. This is not
part of the recovery provider contract and never replaces an existing deployment.
"""

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import tarfile
import tempfile


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Expected an owned private directory; no existing files changed')


def read_file(path, limit=64 << 20):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise ValueError('Expected an owned private regular file')
        return file.read(limit + 1)


def publish(path, data, mode=0o600):
    if path.exists() or path.is_symlink():
        if read_file(path) != data:
            raise ValueError('Existing deployment file differs; nothing was replaced')
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            os.chmod(temporary, mode)
            os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def inspect_root(root, expected, port):
    if not re.fullmatch(r'[a-f0-9]{64}', expected) or not 1024 <= port <= 65535:
        raise ValueError('Invalid setup identity or port')
    root = root.expanduser().absolute()
    if root == Path('/') or root == Path.home():
        raise ValueError('Choose a new deployment directory, not a home/root directory')
    # Do not follow symlinked deployment paths, including parent components.
    for parent in (*reversed(root.parents), root):
        if parent.is_symlink():
            raise ValueError('Symlinked deployment paths are not accepted')
    marker = json.dumps({'version': 1, 'state_id': expected, 'port': port}).encode()
    if root.exists():
        private_directory(root)
        try:
            matches = read_file(root / '.setup.json', 4096) == marker
        except FileNotFoundError:
            matches = False
        if not matches:
            raise ValueError('Remote directory already exists; choose a new directory. No deployment was overwritten')
    return root, marker


def install(root, expected, port, payload):
    root, marker = inspect_root(root, expected, port)
    try:
        root.mkdir(mode=0o700, parents=True)
        sync_directory(root.parent)
    except FileExistsError:
        # A concurrent creator must pass the same verification as a resume.
        inspect_root(root, expected, port)
    private_directory(root)
    lock_fd = os.open(root / '.setup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        publish(root / '.setup.json', marker)
        limits = {'deltarelay': 64 << 20, 'relay.token': 4096, 'upstreams.json': 65536, 'recover_relay.py': 65536}
        files = {}
        with tarfile.open(fileobj=payload, mode='r|') as archive:
            for entry in archive:
                if entry.name not in limits or entry.name in files or not entry.isfile() or not 0 < entry.size <= limits[entry.name]:
                    raise ValueError('Invalid setup archive entry')
                files[entry.name] = archive.extractfile(entry).read(limits[entry.name] + 1)
        if set(files) != set(limits):
            raise ValueError('Incomplete setup archive')
        for name, data in files.items():
            publish(root / name, data, 0o700 if name == 'deltarelay' else 0o600)
        data = root / 'cache'
        for path in (data, data / 'mailbox'):
            path.mkdir(mode=0o700, exist_ok=True)
            private_directory(path)
        publish(data / 'mailbox/identity.json', json.dumps(expected).encode())
        # The recovery helper requires an already-created store lock.
        fd = os.open(data / '.server.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        spec = importlib.util.spec_from_file_location('installed_recovery', root / 'recover_relay.py')
        recovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recovery)
        result = recovery.ensure_relay(root, expected, port)
        return {'state_id': result['state_id'], 'root': str(root)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--expected-state-id', required=True)
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--check', action='store_true', help='read-only destination and platform check')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.check:
            root, _ = inspect_root(args.root, args.expected_state_id, args.port)
            print(json.dumps({'system': platform.system(), 'machine': platform.machine(), 'root': str(root)}))
        else:
            print(json.dumps(install(args.root, args.expected_state_id, args.port, sys.stdin.buffer)))
    except Exception as error:
        # Diagnostics stay in the private journal and map. Never include stdin.
        print(f'Remote setup failed: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
