import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import cli
from remote_provider import ProviderError


class CLITest(unittest.TestCase):
    def invoke(self, *args):
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), patch.object(os, 'umask'):
            code = cli.main(list(args))
        return code, output.getvalue(), errors.getvalue()

    @patch.object(cli, 'start')
    @patch.object(cli, 'create_config')
    def test_default_xdg_setup_and_options(self, create, start):
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': '/private/settings'}):
            code, output, errors = self.invoke('start', '--no-desktop', '--no-dashboard')
        self.assertEqual(code, 0, errors)
        project = Path(__file__).resolve().parents[1]
        config = Path('/private/settings/deltarelay/supervisor.json')
        create.assert_called_once_with(project, config)
        self.assertEqual(start.call_args.args, (project, config, True, True))
        self.assertIn('Ready', output)
        self.assertNotIn('\033', output)
        self.assertTrue(callable(start.call_args.kwargs['report']))

    @patch.object(cli, 'start')
    @patch.object(cli, 'create_config')
    def test_no_frontend_alias_sets_the_same_option(self, create, start):
        code, _, errors = self.invoke('start', '--no-frontend', '--config', '/private/host.json')
        self.assertEqual(code, 0, errors)
        self.assertEqual(start.call_args.args[2:], (False, True))

    @patch.object(cli, 'start')
    @patch.object(cli, 'create_config')
    def test_explicit_configuration_never_initializes_setup(self, create, start):
        code, output, _ = self.invoke('start', '--config', '/private configuration/host.json', '--color', 'always')
        self.assertEqual(code, 0)
        create.assert_not_called()
        self.assertEqual(start.call_args.args[1], Path('/private configuration/host.json'))
        self.assertIn('\033[', output)

    @patch.object(cli, 'start', side_effect=RuntimeError('secret configuration value'))
    def test_errors_are_sanitized_and_never_report_ready(self, start):
        code, output, errors = self.invoke('start', '--config', '/private/host.json')
        self.assertEqual(code, 1)
        self.assertNotIn('Ready', output)
        self.assertNotIn('secret configuration value', errors)
        self.assertIn('supervisor.log', errors)

    @patch.object(cli, 'start', side_effect=KeyboardInterrupt)
    def test_interrupt_leaves_services_alone(self, start):
        code, _, errors = self.invoke('start', '--config', '/private/host.json')
        self.assertEqual(code, 130)
        self.assertIn('left running', errors)

    @patch.object(cli, 'start')
    @patch.object(cli, 'create_config')
    def test_invalid_arguments_do_not_start_services(self, create, start):
        for args in ([], ['stop', '--timeout', '0'], ['start', '--unknown'], ['start', '--config']):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                self.invoke(*args)
        create.assert_not_called()
        start.assert_not_called()

    @patch.object(cli, 'switch_codespace')
    def test_use_switches_profile_and_restarts_services(self, switch):
        code, output, errors = self.invoke('use', 'alpha', '--config', '/private/supervisor.json')
        self.assertEqual(code, 0, errors)
        switch.assert_called_once()
        self.assertEqual(switch.call_args.args[:3], (Path(__file__).resolve().parents[1], 'alpha',
                                                      Path('/private/supervisor.json')))
        self.assertTrue(switch.call_args.kwargs['restart'])
        self.assertIn('Active profile: alpha', output)

    @patch.object(cli, 'switch_codespace')
    def test_use_can_update_only_the_pointer(self, switch):
        code, output, errors = self.invoke('use', 'alpha', '--no-start', '--config', '/private/supervisor.json')
        self.assertEqual(code, 0, errors)
        self.assertFalse(switch.call_args.kwargs['restart'])

    @patch.object(cli, 'switch_codespace')
    @patch.object(cli, 'active_profile', return_value='beta')
    @patch.object(cli, 'list_profiles', return_value=['alpha', 'beta'])
    def test_use_list_marks_the_active_profile(self, listed, active, switch):
        code, output, errors = self.invoke('use', '--list')
        self.assertEqual(code, 0, errors)
        self.assertIn('  alpha', output)
        self.assertIn('* beta', output)
        switch.assert_not_called()

    @patch.object(cli, 'shutdown')
    @patch.object(cli.sys.stdin, 'isatty', return_value=False)
    def test_stop_requires_confirmation_for_noninteractive_use(self, tty, stop):
        code, _, errors = self.invoke('stop', '--config', '/private/supervisor.json')
        self.assertEqual(code, 2)
        self.assertIn('--yes', errors)
        stop.assert_not_called()

    @patch.object(cli, 'shutdown')
    def test_stop_uses_the_shared_shutdown_and_reports_confirmation(self, stop):
        stop.return_value = {'remote': {'capabilities': ['host.stop'], 'host_state': 'stopped'}}
        code, output, errors = self.invoke('stop', '--yes', '--remote-only', '--timeout', '45',
                                           '--config', '/private/supervisor.json')
        self.assertEqual(code, 0, errors)
        self.assertEqual(stop.call_args.args, (Path('/private/supervisor.json'),))
        self.assertEqual({key: value for key, value in stop.call_args.kwargs.items() if key != 'report'},
                         {'remote_only': True, 'timeout': 45})
        self.assertTrue(callable(stop.call_args.kwargs['report']))
        self.assertIn('Remote shutdown confirmed', output)
        self.assertIn('Storage charges may continue', output)

    @patch.object(cli, 'shutdown')
    def test_stop_reports_unsupported_remote_power_off_without_claiming_billing_stopped(self, stop):
        stop.return_value = {'remote': {'capabilities': [], 'host_state': 'unknown'}}
        code, output, errors = self.invoke('stop', '--yes', '--config', '/private/supervisor.json')
        self.assertEqual(code, 1, errors)
        self.assertIn('Remote power-off is unsupported', output)
        self.assertIn('billing may continue', output)

    @patch.object(cli, 'shutdown', side_effect=ProviderError('host_stop_timeout'))
    def test_stop_failure_names_billing_risk_and_keeps_recovery_off(self, stop):
        code, _, errors = self.invoke('stop', '--yes', '--config', '/private/supervisor.json')
        self.assertEqual(code, 1)
        self.assertIn('compute charges may continue', errors)
        self.assertIn('recovery and wake remain off', errors)

    @patch.object(cli, 'shutdown', side_effect=ProviderError('supervisor_unavailable'))
    def test_stop_never_starts_a_supervisor_as_a_fallback(self, stop):
        code, _, errors = self.invoke('stop', '--yes', '--config', '/private/supervisor.json')
        self.assertEqual(code, 1)
        self.assertIn('supervisor is not running', errors)
        self.assertIn('no shutdown was requested', errors)

    @patch.object(cli, 'switch_codespace', side_effect=ProviderError('profiles_not_configured'))
    def test_use_reports_safe_switch_errors(self, switch):
        code, output, errors = self.invoke('use', 'alpha', '--config', '/private/supervisor.json')
        self.assertEqual(code, 1)
        self.assertNotIn('Active profile', output)
        self.assertIn('profiles_not_configured', errors)

    def test_auto_color_respects_terminal_and_environment(self):
        stream = io.StringIO()
        stream.isatty = lambda: True
        with patch.dict(os.environ, {'TERM': 'xterm'}, clear=True):
            self.assertTrue(cli.Console(stream).color)
            with patch.dict(os.environ, {'NO_COLOR': ''}):
                self.assertFalse(cli.Console(stream).color)
            with patch.dict(os.environ, {'TERM': 'dumb'}):
                self.assertFalse(cli.Console(stream).color)
            self.assertFalse(cli.Console(stream, 'never').color)

    def test_entry_point_help_from_outside_checkout(self):
        script = Path(__file__).resolve().parents[1] / 'deltarelay'
        for args, expected in ((['--help'], 'start'), (['start', '--help'], '--config'),
                               (['stop', '--help'], '--remote-only')):
            result = subprocess.run([sys.executable, '-B', str(script), *args], cwd=script.parent.parent,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(expected, result.stdout)

    def test_extensionless_launcher_is_executable(self):
        script = Path(__file__).resolve().parents[1] / 'deltarelay'
        result = subprocess.run([str(script), 'start', '--help'], cwd=script.parent.parent,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--config', result.stdout)
