import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from remote_provider import ProviderError
from supervision import launcher
from supervision.control import controller_status
from test_support import configure_provider


class StartupScriptTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'deploy').mkdir()
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'startup.sh', self.root / 'startup.sh')
        self.events = self.root / 'events'
        helper = self.root / 'deploy/start_supervisor.py'
        helper.write_text('import json,os,sys\nwith open(os.environ["EVENTS"], "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")\n')
        self.environment = dict(os.environ, EVENTS=str(self.events), DISPLAY='', WAYLAND_DISPLAY='',
                                XDG_CONFIG_HOME=str(self.root / 'config'))
        self.config = self.root / 'config/deltarelay/supervisor.json'
        self.config.parent.mkdir(parents=True)
        self.config.write_text('{}')

    def startup(self, *args):
        return subprocess.run(['bash', str(self.root / 'startup.sh'), *args],
                              cwd=self.root, env=self.environment, text=True, capture_output=True, timeout=10)

    def test_default_uses_xdg_configuration_without_network_or_display(self):
        result = self.startup('--no-desktop', '--no-dashboard')
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.events.read_text())
        self.assertIn(str(self.config), args)
        self.assertIn('--no-desktop', args)
        self.assertIn('--no-dashboard', args)
        self.assertNotIn('--profile', args)

    def test_explicit_configuration_can_live_outside_checkout(self):
        result = self.startup('--config', '/private configuration/vps.json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('/private configuration/vps.json', json.loads(self.events.read_text()))

    def test_missing_configuration_explains_setup_without_provisioning(self):
        self.config.unlink()
        self.environment['DELTARELAY_PROFILE'] = str(self.root)
        (self.root / '.runtime/codespace-test').mkdir(parents=True)
        (self.root / '.runtime/codespace-test/tunnel-supervisor.sh').write_text('CODESPACE=unused\n')
        result = self.startup('--no-desktop')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('docs/REMOTE_PROVIDERS.md', result.stderr)
        self.assertFalse(self.events.exists())

    def test_removed_or_unknown_arguments_fail_before_starting_anything(self):
        for args in [('--timeout', '1200'), ('--profile', str(self.root)), ('--unknown',)]:
            with self.subTest(args=args):
                self.assertNotEqual(self.startup(*args).returncode, 0)
                self.assertFalse(self.events.exists())

    def test_startup_propagates_controller_launch_failure(self):
        (self.root / 'deploy/start_supervisor.py').write_text('raise SystemExit(7)\n')
        self.assertEqual(self.startup('--no-desktop').returncode, 7)
        self.assertFalse(self.events.exists())

    def test_help_does_not_start_anything(self):
        result = self.startup('--help')
        self.assertEqual(result.returncode, 0)
        self.assertIn('--config', result.stdout)
        self.assertIn('offline', result.stdout)
        self.assertFalse(self.events.exists())


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {'version': 1, 'profile': str(self.root), 'relay_url': 'http://127.0.0.1:8787',
                       'gateway_url': 'http://127.0.0.1:8788', 'components': {},
                       **{key: str(self.root / key) for key in ('relay_token_file', 'local_token_file', 'relay_state_file')}}
        configure_provider(self.config)
        self.path = self.root / 'supervisor.json'
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.config))
        self.path.chmod(0o600)

    @patch('builtins.print')
    @patch.object(launcher, 'prepare_build')
    @patch.object(launcher, 'control_request')
    @patch.object(launcher, 'controller_status', return_value={'version': 2})
    def test_existing_supervisor_reuses_services_without_building(self, status, request, build, output):
        launcher.start(self.root, self.path, no_desktop=True)
        build.assert_not_called()
        self.assertEqual(request.call_args.args[2:], ('/action', {'component': 'dashboard', 'action': 'start'}))

    @patch('builtins.print')
    @patch.object(launcher.subprocess, 'Popen')
    @patch.object(launcher, 'prepare_build')
    @patch.object(launcher, 'controller_status', side_effect=[None, {'version': 2}])
    def test_new_supervisor_builds_offline_then_starts_with_explicit_config(self, status, build, popen, output):
        launcher.start(self.root, self.path, no_dashboard=True, no_desktop=True)
        build.assert_called_once_with(self.root)
        args = popen.call_args.args[0]
        self.assertEqual(args[:2], [sys.executable, '-B'])
        self.assertIn(str(self.path), args)
        self.assertIn('--no-dashboard', args)
        self.assertIn('--no-desktop', args)
        self.assertTrue(popen.call_args.kwargs['start_new_session'])

    def test_provider_is_required_and_old_configuration_is_rejected(self):
        from supervision.config import validate
        for change in ({'remote': None}, {'codespace': {}}, {'components': {'tunnel': {}}}, {'components': {'relay': {}}}):
            with self.subTest(change=change), self.assertRaises(ProviderError):
                validate({**self.config, **change})
        config = dict(self.config)
        del config['remote']
        with self.assertRaisesRegex(ProviderError, '^remote_provider_required$'):
            validate(config)

    def test_only_current_controller_status_is_reused(self):
        for version in (1, True, 3, None):
            with patch('supervision.control.control_request', return_value=(200, {'version': version})):
                self.assertIsNone(controller_status(self.root / 'control.sock'))
        with patch('supervision.control.control_request', return_value=(200, {'version': 2})):
            self.assertEqual(controller_status(self.root / 'control.sock'), {'version': 2})
