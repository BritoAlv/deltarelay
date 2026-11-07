import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import cli


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
        script = Path(__file__).resolve().parents[1] / 'deltarelay.py'
        for args in (['--help'], ['start', '--help']):
            result = subprocess.run([sys.executable, '-B', str(script), *args], cwd=script.parent.parent,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('start' if len(args) == 1 else '--config', result.stdout)
