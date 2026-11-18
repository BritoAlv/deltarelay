"""Human-friendly local startup without third-party terminal dependencies."""

import argparse
import os
from pathlib import Path
import sys

from remote_provider import ProviderError
from supervision.launcher import start
from supervision.onboarding import create_config
from supervision.profiles import active_profile, list_profiles, switch_codespace
from supervision.shutdown import shutdown


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


def bounded_timeout(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError('timeout must be an integer number of seconds') from None
    if not 1 <= seconds <= 600:
        raise argparse.ArgumentTypeError('timeout must be between 1 and 600 seconds')
    return seconds


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='deltarelay', description='Start or stop DeltaRelay through persistent local controls.')
    commands = parser.add_subparsers(dest='command', required=True)
    launch = commands.add_parser('start', help='start/reuse the persistent supervisor and dashboard',
                                 description='Start local controls before remote recovery. Nothing is downloaded.')
    launch.add_argument('--config', type=Path, help='private supervisor JSON (defaults to XDG configuration)')
    launch.add_argument('--no-desktop', '--no-frontend', dest='no_desktop', action='store_true',
                        help='skip the initial OpenCode and managed frontend launch')
    launch.add_argument('--no-dashboard', action='store_true', help='skip a new dashboard launch; leave existing services running')
    launch.add_argument('--color', choices=('auto', 'always', 'never'), default='auto',
                        help='terminal styling (auto respects NO_COLOR and redirected output)')
    stop = commands.add_parser('stop', help='stop the system and confirm remote shutdown; keep local controls available')
    stop.add_argument('--config', type=Path, help='private supervisor JSON (defaults to XDG configuration)')
    stop.add_argument('--remote-only', action='store_true', help='stop only the remote host and its local tunnel')
    stop.add_argument('--yes', action='store_true', help='confirm shutdown without an interactive prompt')
    stop.add_argument('--timeout', type=bounded_timeout, metavar='SECONDS', default=420,
                      help='maximum wait for confirmed shutdown (1–600 seconds; default 420)')
    stop.add_argument('--color', choices=('auto', 'always', 'never'), default='auto')
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
    if args.command == 'stop':
        if not args.yes:
            if not sys.stdin.isatty():
                errors.write('Shutdown requires confirmation. Pass --yes when running from a script.', '33')
                return 2
            try:
                answer = input('Stop the remote host' + ('?' if args.remote_only else ' and managed local applications?') +
                               ' Active work will be interrupted. [y/N] ')
            except EOFError:
                errors.write('Shutdown not confirmed; no services were changed.', '33')
                return 2
            except KeyboardInterrupt:
                errors.write('Shutdown cancelled; no services were changed.', '33')
                return 130
            if answer.strip().lower() not in ('y', 'yes'):
                console.report('Shutdown cancelled; no services were changed')
                return 0
        try:
            snapshot = shutdown(args.config or default_config(), remote_only=args.remote_only,
                                timeout=args.timeout, report=console.report)
        except KeyboardInterrupt:
            errors.write('Stopped waiting. Shutdown may still be in progress; check System controls.', '33')
            return 130
        except ProviderError as error:
            reason = {
                'supervisor_unavailable': 'The local supervisor is not running, so no shutdown was requested. '
                                          'Do not start it merely to shut down; use GitHub directly if shutdown is urgent.',
                'unsupported_operation': 'The active remote provider does not support confirmed shutdown; '
                                         'stop it through its hosting provider.',
                'shutdown_not_configured': 'A managed local service has no stop command; nothing was stopped. '
                                           'Configure it in System controls first.',
                'operation_in_progress': 'A shutdown or another operation is already in progress; no new shutdown was requested. '
                                         'Check System controls for its result.',
                'host_stop_timeout': 'Shutdown was not confirmed before the timeout; compute charges may continue.',
                'configuration_error': 'The private supervisor configuration is missing or invalid; no shutdown was requested.',
            }.get(str(error))
            if reason:
                accepted = str(error) not in ('supervisor_unavailable', 'configuration_error', 'unsupported_operation',
                                              'shutdown_not_configured', 'operation_in_progress')
                errors.write(reason + (' Automatic recovery and wake remain off after an accepted shutdown.' if accepted else ''), '1;31')
            else:
                errors.write(f'Shutdown unconfirmed — compute charges may continue ({error}). '
                             'Automatic recovery and wake remain off. Check System controls or GitHub before retrying.', '1;31')
            return 1
        except Exception:
            errors.write('Shutdown unconfirmed — compute charges may continue. Check System controls or GitHub. '
                         'An accepted shutdown keeps automatic recovery and wake disabled.', '1;31')
            return 1
        remote = snapshot.get('remote') or {}
        capabilities = remote.get('capabilities') or []
        run = (snapshot.get('topology') or {}).get('run') or {}
        if run.get('status') == 'failed':
            console.report(f"Remote shutdown is confirmed, but a stop step failed or was interrupted: "
                           f"{run.get('error') or 'unknown'}. Review System controls.")
        if 'host.stop' in capabilities:
            console.write('  Remote shutdown confirmed by the hosting provider. Recovery and wake remain off.', '1;32')
            console.report('Storage charges may continue. The dashboard and supervisor remain available.')
        else:
            console.write('  Local shutdown completed. Remote power-off is unsupported; remote billing may continue.', '33')
            return 1
        return 0
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
