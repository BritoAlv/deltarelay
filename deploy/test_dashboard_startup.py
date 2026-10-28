import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import start_dashboard as dashboard


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / 'checkout'
        self.profile = self.root / 'profile'
        self.project.mkdir()
        self.profile.mkdir()
        self.token = self.profile / 'local.token'
        self.token.write_text('private-local-test-token')
        self.token.chmod(0o600)

    @patch.object(dashboard, 'gateway_diagnostics_ready', return_value=True)
    @patch.object(dashboard, 'dashboard_ready', return_value=True)
    @patch.object(dashboard, 'ensure_process', return_value=True)
    @patch.object(dashboard, 'prepare_build')
    @patch.object(dashboard, 'port_open', return_value=False)
    @patch.object(dashboard, 'owned_pid', return_value=None)
    @patch('builtins.print')
    def test_starts_dashboard_with_correct_gateway_assets_and_token_file(self, output, owned, port, build, ensure, ready, diagnostics):
        self.assertTrue(dashboard.start_dashboard(self.project, self.profile))
        build.assert_called_once_with(self.project)
        args = ensure.call_args.args
        self.assertEqual(args[0:2], (self.profile, 'dashboard.pid'))
        command = args[2]
        self.assertEqual(command[0:2], [str(self.project / 'bin/deltarelay'), 'dashboard'])
        self.assertIn('http://127.0.0.1:18788', command)
        self.assertIn('127.0.0.1:8790', command)
        self.assertIn(str(self.token), command)
        self.assertIn(str(self.project / 'web/dist'), command)
        self.assertNotIn('private-local-test-token', command)
        self.assertEqual(args[-2:], ('dashboard.log', 8790))
        diagnostics.assert_called_once_with(self.profile)

    @patch.object(dashboard, 'gateway_diagnostics_ready', return_value=True)
    @patch.object(dashboard, 'dashboard_ready', return_value=True)
    @patch.object(dashboard, 'ensure_process', return_value=False)
    @patch.object(dashboard, 'prepare_build')
    @patch.object(dashboard, 'owned_pid', return_value=123)
    @patch('builtins.print')
    def test_existing_dashboard_is_reused_without_rebuilding_live_assets(self, output, owned, build, ensure, ready, diagnostics):
        self.assertFalse(dashboard.start_dashboard(self.project, self.profile))
        build.assert_not_called()
        ensure.assert_called_once()

    @patch.object(dashboard, 'prepare_build')
    @patch.object(dashboard, 'port_open', return_value=True)
    @patch.object(dashboard, 'owned_pid', return_value=None)
    def test_unknown_port_owner_is_not_replaced_or_rebuilt(self, owned, port, build):
        with self.assertRaisesRegex(dashboard.RecoveryError, 'unrecognized owner'):
            dashboard.start_dashboard(self.project, self.profile)
        build.assert_not_called()

    @patch.object(dashboard, 'gateway_diagnostics_ready', return_value=False)
    @patch.object(dashboard, 'dashboard_ready', return_value=True)
    @patch.object(dashboard, 'ensure_process', return_value=False)
    @patch.object(dashboard, 'owned_pid', return_value=123)
    @patch('builtins.print')
    def test_old_gateway_warns_but_dashboard_still_runs(self, output, owned, ensure, ready, diagnostics):
        self.assertFalse(dashboard.start_dashboard(self.project, self.profile))
        self.assertIn('no running gateway was replaced', ' '.join(str(c) for c in output.call_args_list))

    @patch.object(dashboard, 'prepare_build')
    def test_public_token_fails_before_build_or_process_start(self, build):
        self.token.chmod(0o644)
        with self.assertRaises(dashboard.RecoveryError):
            dashboard.start_dashboard(self.project, self.profile)
        build.assert_not_called()

    @patch.object(dashboard.subprocess, 'run')
    @patch.object(dashboard.shutil, 'which', return_value='/local/tool')
    @patch('builtins.print')
    def test_missing_builds_use_offline_tools_and_atomic_binary(self, output, which, run):
        source = self.project / 'internal/example.go'
        source.parent.mkdir()
        source.write_text('package example')

        def build(command, **kwargs):
            if command[0] == 'go':
                self.assertEqual(kwargs['env']['GOPROXY'], 'off')
                self.assertEqual(kwargs['env']['GOTOOLCHAIN'], 'local')
                Path(command[command.index('-o') + 1]).write_text('new binary')
            elif command == ['pnpm', 'install', '--offline', '--frozen-lockfile', '--trust-lockfile']:
                pass
            elif command == ['pnpm', 'build']:
                assets = self.project / 'web/dist'
                assets.mkdir(parents=True)
                (assets / 'index.html').write_text('<title>DeltaRelay</title>')
            else:
                self.fail(f'Unexpected build command: {command}')

        run.side_effect = build
        binary, assets = dashboard.prepare_build(self.project)
        self.assertEqual(binary.read_text(), 'new binary')
        self.assertTrue(os.access(binary, os.X_OK))
        self.assertTrue((assets / 'index.html').is_file())
        self.assertEqual(run.call_count, 3)
        dashboard.prepare_build(self.project)
        self.assertEqual(run.call_count, 3, 'current build was unnecessarily rebuilt')
        os.utime(source, ns=(binary.stat().st_mtime_ns + 1, binary.stat().st_mtime_ns + 1))
        dashboard.prepare_build(self.project)
        self.assertEqual(run.call_count, 4, 'changed Go source did not rebuild the binary')

    @patch.object(dashboard.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['go', 'build']))
    @patch.object(dashboard.shutil, 'which', return_value='/local/tool')
    @patch('builtins.print')
    def test_failed_build_preserves_existing_binary(self, output, which, run):
        binary = self.project / 'bin/deltarelay'
        binary.parent.mkdir()
        binary.write_text('original binary')
        binary.chmod(0o700)
        source = self.project / 'go.mod'
        source.write_text('module example')
        os.utime(source, ns=(binary.stat().st_mtime_ns + 1, binary.stat().st_mtime_ns + 1))
        with self.assertRaises(subprocess.CalledProcessError):
            dashboard.prepare_build(self.project)
        self.assertEqual(binary.read_text(), 'original binary')
        self.assertEqual(list(binary.parent.glob('.dashboard-build-*')), [])


class StartupScriptTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.profile = self.root / 'private profile'
        self.profile.mkdir()
        (self.root / 'deploy').mkdir()
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'startup.sh', self.root / 'startup.sh')
        self.events = self.root / 'events'
        helper = self.root / 'deploy/start_supervisor.py'
        helper.write_text('import json,os,sys\nwith open(os.environ["EVENTS"], "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")\n')
        self.environment = dict(os.environ, DELTARELAY_PROFILE=str(self.profile), EVENTS=str(self.events),
                                DISPLAY='', WAYLAND_DISPLAY='', DELTARELAY_DASHBOARD_PORT='19890')

    def startup(self, *args):
        return subprocess.run(['bash', str(self.root / 'startup.sh'), *args],
                              cwd=self.root, env=self.environment, text=True, capture_output=True, timeout=10)

    def test_no_desktop_starts_independent_supervisor_without_network_recovery(self):
        result = self.startup('--no-desktop', '--timeout', '1200')
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events.read_text().splitlines()
        self.assertEqual(len(events), 1)
        self.assertIn(str(self.profile), events[0])
        self.assertIn('19890', events[0])
        self.assertIn('--no-desktop', events[0])
        self.assertNotIn('--timeout', events[0])

    def test_dashboard_opt_out_reaches_supervisor(self):
        result = self.startup('--no-desktop', '--no-dashboard')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--no-dashboard', self.events.read_text())

    def test_no_graphical_session_does_not_block_local_controls(self):
        result = self.startup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.events.read_text().splitlines()), 1)

    def test_generic_vps_config_does_not_require_codespace_wrappers(self):
        result = self.startup('--config', '/private configuration/vps.local.json', '--no-desktop')
        self.assertEqual(result.returncode, 0, result.stderr)
        event = self.events.read_text()
        self.assertIn('/private configuration/vps.local.json', event)
        self.assertNotIn('--profile', event)

    def test_unknown_argument_fails_before_starting_anything(self):
        result = self.startup('--unknown')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.events.exists())

    def test_startup_propagates_controller_launch_failure(self):
        (self.root / 'deploy/start_supervisor.py').write_text('raise SystemExit(7)\n')
        result = self.startup('--no-desktop')
        self.assertEqual(result.returncode, 7)
        self.assertFalse(self.events.exists())

    def test_help_does_not_start_anything(self):
        result = self.startup('--help')
        self.assertEqual(result.returncode, 0)
        self.assertIn('--no-dashboard', result.stdout)
        self.assertIn('offline', result.stdout)
        self.assertFalse(self.events.exists())


@unittest.skipUnless(os.environ.get('DELTARELAY_RECOVERY_TEST_BINARY'),
                     'set DELTARELAY_RECOVERY_TEST_BINARY for the real dashboard startup test')
class RealDashboardTest(unittest.TestCase):
    def test_real_dashboard_starts_once_with_private_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project, profile = root / 'checkout', root / 'profile'
            (project / 'bin').mkdir(parents=True)
            (project / 'web/dist').mkdir(parents=True)
            (profile / 'logs').mkdir(parents=True)
            (project / 'web/dist/index.html').write_text('<!doctype html><title>DeltaRelay</title>')
            token = profile / 'local.token'
            token.write_text('dashboard-test-token')
            token.chmod(0o600)
            binary = project / 'bin/deltarelay'
            shutil.copyfile(os.environ['DELTARELAY_RECOVERY_TEST_BINARY'], binary)
            binary.chmod(0o700)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            popen = subprocess.Popen
            children = []

            def track(*args, **kwargs):
                child = popen(*args, **kwargs)
                children.append(child)
                return child

            try:
                with patch.object(dashboard.subprocess, 'Popen', side_effect=track), \
                        patch.object(dashboard, 'gateway_diagnostics_ready', return_value=True), \
                        patch('builtins.print'):
                    self.assertTrue(dashboard.start_dashboard(project, profile, port))
                    pid = (profile / 'dashboard.pid').read_text()
                    self.assertFalse(dashboard.start_dashboard(project, profile, port))
                    self.assertEqual((profile / 'dashboard.pid').read_text(), pid)
                self.assertEqual(len(children), 1)
                self.assertTrue(dashboard.dashboard_ready(port))
                self.assertEqual((profile / 'logs/dashboard.log').stat().st_mode & 0o777, 0o600)
                self.assertEqual((profile / 'dashboard.pid').stat().st_mode & 0o777, 0o600)
                self.assertNotIn('dashboard-test-token', (profile / 'logs/dashboard.log').read_text())
            finally:
                for child in children:
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()


if __name__ == '__main__':
    unittest.main()
