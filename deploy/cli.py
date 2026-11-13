"""Human-friendly local startup without third-party terminal dependencies."""

import argparse
import os
from pathlib import Path
import sys

from remote_provider import ProviderError
from supervision.launcher import start
from supervision.onboarding import create_config
from supervision.profiles import active_profile, list_profiles, switch_codespace


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


def default_config():
    return Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'deltarelay/supervisor.json'


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
    use = commands.add_parser('use', help='select a private remote-host profile and restart local services',
                              description='Switch the active per-host profile without editing the supervisor configuration.')
    use.add_argument('profile', nargs='?', help='profile directory under .runtime/codespaces')
    use.add_argument('--config', type=Path, help='private supervisor JSON (defaults to XDG configuration)')
    use.add_argument('--list', action='store_true', help='list profiles without switching')
    use.add_argument('--no-start', action='store_true', help='update the active pointer without restarting services')
    use.add_argument('--color', choices=('auto', 'always', 'never'), default='auto',
                     help='terminal styling (auto respects NO_COLOR and redirected output)')
    args = parser.parse_args(argv)
    console = Console(sys.stdout, args.color)
    errors = Console(sys.stderr, args.color)
    project = Path(__file__).resolve().parents[1]
    os.umask(0o077)
    console.heading()
    if args.command == 'use':
        return use_profile(project, args, console, errors)
    try:
        config = args.config
        if config is None:
            config = default_config()
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


def use_profile(project, args, console, errors):
    if args.list or not args.profile:
        names = list_profiles(project)
        if not names:
            console.write('  No private profiles found under .runtime/codespaces.', '33')
            return 0
        active = active_profile(project)
        for name in names:
            marker = '*' if name == active else ' '
            console.write(f'  {marker} {name}')
        return 0
    config = args.config or default_config()
    try:
        console.report(f'Switching the active remote-host profile to {args.profile}')
        switch_codespace(project, args.profile, config, restart=not args.no_start, report=console.report)
    except KeyboardInterrupt:
        errors.write('Switch interrupted. Local services may need a restart.', '33')
        return 130
    except ProviderError as error:
        errors.write(f'Switch failed: {error}. Check the profile layout and local supervisor state.', '1;31')
        return 1
    except Exception:
        # Configuration and child exceptions can contain private credentials.
        errors.write('Switch failed. Check private configuration, offline build tools, and control/supervisor.log.', '1;31')
        return 1
    console.write(f'  Active profile: {args.profile}', '1;32')
    return 0
