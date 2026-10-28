#!/usr/bin/env python3
"""Start the local dashboard for an existing private recovery profile, offline."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from recover_codespace import ensure_process, port_open
from recover_relay import NoRedirect, RecoveryError, owned_pid, private_text


def needs_build(output, sources):
    if not output.is_file():
        return True
    built = output.stat().st_mtime_ns
    return any(path.is_file() and path.stat().st_mtime_ns > built for path in sources)


def prepare_build(project):
    binary = project / 'bin' / 'deltarelay'
    assets = project / 'web' / 'dist'
    go_sources = [project / 'go.mod']
    for directory in ('cmd', 'internal'):
        go_sources.extend((project / directory).rglob('*.go'))
    if binary.is_symlink():
        raise RecoveryError('Refusing to replace a symlinked bin/deltarelay; build a regular local binary first')
    if needs_build(binary, go_sources) or not os.access(binary, os.X_OK):
        if shutil.which('go') is None:
            raise RecoveryError('Go is required to build bin/deltarelay; build it locally before startup')
        print('Building the local dashboard binary (Go, offline)', flush=True)
        binary.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.dashboard-build-', dir=binary.parent)
        os.close(fd)
        temporary = Path(name)
        try:
            environment = dict(os.environ, GOPROXY='off', GOSUMDB='off', GOTOOLCHAIN='local')
            subprocess.run(['go', 'build', '-trimpath', '-o', str(temporary), './cmd/deltarelay'],
                           cwd=project, env=environment, check=True, timeout=180)
            temporary.chmod(0o700)
            # Atomic replacement also works when another command is executing
            # an older binary. It does not restart that process or the gateway.
            os.replace(temporary, binary)
        finally:
            temporary.unlink(missing_ok=True)

    web_sources = [project / name for name in (
        'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
        'web/package.json', 'web/astro.config.mjs', 'web/tsconfig.json',
    )]
    for directory in ('src', 'public'):
        web_sources.extend((project / 'web' / directory).rglob('*'))
    if needs_build(assets / 'index.html', web_sources):
        if shutil.which('pnpm') is None:
            raise RecoveryError('pnpm is required to build web/dist; run the offline dashboard build first')
        print('Building the Astro dashboard using the offline pnpm cache', flush=True)
        subprocess.run(['pnpm', 'install', '--offline', '--frozen-lockfile', '--trust-lockfile'],
                       cwd=project, check=True, timeout=180)
        subprocess.run(['pnpm', 'build'], cwd=project, check=True, timeout=180)
        if not (assets / 'index.html').is_file():
            raise RecoveryError('Dashboard build did not produce web/dist/index.html')
    return binary, assets


def dashboard_ready(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(f'http://127.0.0.1:{port}/', timeout=1) as response:
            return response.status == 200 and b'DeltaRelay' in response.read(65536)
    except urllib.error.HTTPError as error:
        error.close()
    except (OSError, urllib.error.URLError):
        pass
    return False


def gateway_diagnostics_ready(profile):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://127.0.0.1:18788/v1/dashboard', headers={
        'X-DeltaRelay-Local-Token': private_text(profile / 'local.token'),
    })
    try:
        with opener.open(request, timeout=3) as response:
            data = json.loads(response.read((8 << 20) + 1))
            return isinstance(data, dict) and data.get('version') == 1 and isinstance(data.get('history'), dict)
    except urllib.error.HTTPError as error:
        error.close()
    except (OSError, ValueError, urllib.error.URLError):
        pass
    return False


def start_dashboard(project, profile, port=8790):
    token = private_text(profile / 'local.token')
    if not token or '\n' in token or '\r' in token:
        raise RecoveryError('Invalid local gateway token file')
    binary, assets = project / 'bin' / 'deltarelay', project / 'web' / 'dist'
    command = [str(binary), 'dashboard', '--listen', f'127.0.0.1:{port}',
               '--gateway', 'http://127.0.0.1:18788', '--local-token-file', str(profile / 'local.token'),
               '--assets', str(assets)]
    # Do not overwrite/rebuild assets under a dashboard that is already serving
    # them. Recovery never stops a live service to apply an update.
    if owned_pid(profile / 'dashboard.pid', command) is None:
        if port_open(port):
            raise RecoveryError(f'Port {port} has an unrecognized owner; no process was stopped or replaced')
        prepare_build(project)
    started = ensure_process(profile, 'dashboard.pid', command, command, 'dashboard.log', port)
    deadline = time.monotonic() + 10
    while not dashboard_ready(port):
        if owned_pid(profile / 'dashboard.pid', command) is None:
            raise RecoveryError(f'Dashboard exited during startup; see {profile / "logs/dashboard.log"}')
        if time.monotonic() >= deadline:
            raise RecoveryError(f'Dashboard did not become ready; see {profile / "logs/dashboard.log"}; no process was stopped')
        time.sleep(0.1)
    print(f'Dashboard {"started" if started else "already running"}: http://127.0.0.1:{port}', flush=True)
    print(f'Dashboard log: {profile / "logs/dashboard.log"}', flush=True)
    if not gateway_diagnostics_ready(profile):
        print('Dashboard is running, but gateway diagnostics are unavailable. An older profile gateway '
              'must be rebuilt/restarted when safe; no running gateway was replaced.', flush=True)
    return started


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8790)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    os.umask(0o077)
    try:
        project, profile = args.project.resolve(strict=True), args.profile.resolve(strict=True)
        (profile / 'logs').mkdir(mode=0o700, exist_ok=True)
        fd = os.open(profile / '.dashboard.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RecoveryError('Another dashboard startup is already running for this profile') from None
            start_dashboard(project, profile, args.port)
    except (RecoveryError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Dashboard startup failed: {error}', file=sys.stderr)
        print('No services were stopped. Install/build dependencies offline, or use --no-dashboard to skip it.', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('Dashboard startup cancelled. Existing services were left running.', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())
