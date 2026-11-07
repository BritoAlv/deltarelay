"""Offline builds used by the supervisor launcher."""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from recover_relay import RecoveryError


def needs_build(output, sources):
    if not output.is_file():
        return True
    built = output.stat().st_mtime_ns
    return any(path.is_file() and path.stat().st_mtime_ns > built for path in sources)


def prepare_build(project, report=None):
    def emit(message):
        if report is None:
            print(message, flush=True)
        else:
            report(message)

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
        emit('Building the local dashboard binary (Go, offline)')
        binary.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.dashboard-build-', dir=binary.parent)
        os.close(fd)
        temporary = Path(name)
        try:
            environment = dict(os.environ, GOPROXY='off', GOSUMDB='off', GOTOOLCHAIN='local')
            subprocess.run(['go', 'build', '-trimpath', '-o', str(temporary), './cmd/deltarelay'],
                           cwd=project, env=environment, check=True, timeout=180)
            temporary.chmod(0o700)
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
        emit('Building the Astro dashboard using the offline pnpm cache')
        subprocess.run(['pnpm', 'install', '--offline', '--frozen-lockfile', '--trust-lockfile'],
                       cwd=project, check=True, timeout=180)
        subprocess.run(['pnpm', 'build'], cwd=project, check=True, timeout=180)
        if not (assets / 'index.html').is_file():
            raise RecoveryError('Dashboard build did not produce web/dist/index.html')
    return binary, assets
