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
        for args in ([], ['stop'], ['start', '--unknown'], ['start', '--config']):
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
        for args in (['--help'], ['start', '--help']):
            result = subprocess.run([sys.executable, '-B', str(script), *args], cwd=script.parent.parent,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('start' if len(args) == 1 else '--config', result.stdout)

    def test_extensionless_launcher_is_executable(self):
        script = Path(__file__).resolve().parents[1] / 'deltarelay'
        result = subprocess.run([str(script), 'start', '--help'], cwd=script.parent.parent,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--config', result.stdout)
