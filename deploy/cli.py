"""Human-friendly local startup without third-party terminal dependencies."""

import argparse
import os
from pathlib import Path
import sys

from supervision.launcher import start
from supervision.onboarding import create_config


class Console:
    def __init__(self, stream, color='auto'):
        self.stream = stream
        self.color = color == 'always' or (color == 'auto' and stream.isatty()
                                         and 'NO_COLOR' not in os.environ
                                         and os.environ.get('TERM') != 'dumb')

    def write(self, text, style='36'):
        if self.color:
            text = f'\033[{style}m{text}\033[0m'
        print(text, file=self.stream, flush=True)

    def heading(self):
        self.write('╭─ DeltaRelay ───────────────────────────────────╮' if self.color
                   else 'DeltaRelay', '1;36')
        self.write('  Local controls first · offline builds · persistent recovery', '2')
        if self.color:
            self.write('╰───────────────────────────────────────────────╯', '1;36')

    def report(self, message):
        self.write(f'  {"›" if self.color else ">"} {message}')


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='deltarelay', description='Start DeltaRelay with offline, dependency-free local controls.')
    commands = parser.add_subparsers(dest='command', required=True)
    launch = commands.add_parser('start', help='start/reuse the persistent supervisor and dashboard',
                                 description='Start local controls before remote recovery. Nothing is downloaded.')
    launch.add_argument('--config', type=Path, help='private supervisor JSON (defaults to XDG configuration)')
    launch.add_argument('--no-desktop', action='store_true', help='skip the initial OpenCode/Desktop launch')
    launch.add_argument('--no-dashboard', action='store_true', help='skip a new dashboard launch; leave existing services running')
    launch.add_argument('--color', choices=('auto', 'always', 'never'), default='auto',
                        help='terminal styling (auto respects NO_COLOR and redirected output)')
    args = parser.parse_args(argv)
    console = Console(sys.stdout, args.color)
    errors = Console(sys.stderr, args.color)
    project = Path(__file__).resolve().parents[1]
    os.umask(0o077)
    console.heading()
    try:
        config = args.config
        if config is None:
            config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'deltarelay/supervisor.json'
            console.report('Preparing local configuration and first-run controls')
            create_config(project, config.absolute())
        console.report('Checking local supervisor')
        start(project, config, args.no_dashboard, args.no_desktop, report=console.report)
    except KeyboardInterrupt:
        errors.write('Startup interrupted. Already-started services are left running.', '33')
        return 130
    except Exception:
        # Configuration and child exceptions can contain private credentials.
        errors.write('Startup failed. Check private configuration, offline build tools, and control/supervisor.log. '
                     'No existing services were stopped.', '1;31')
        return 1
    console.write('  Ready — local supervisor available; remote connectivity recovers separately.', '1;32')
    return 0
