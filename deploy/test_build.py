import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from supervision import build


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)

    @patch.object(build.subprocess, 'run')
    @patch.object(build.shutil, 'which', return_value='/local/tool')
    @patch('builtins.print')
    def test_missing_builds_use_offline_tools_and_atomic_binary(self, output, which, run):
        source = self.project / 'internal/example.go'
        source.parent.mkdir()
        source.write_text('package example')

        def compile(command, **kwargs):
            if command[0] == 'go':
                self.assertEqual(kwargs['env']['GOPROXY'], 'off')
                self.assertEqual(kwargs['env']['GOTOOLCHAIN'], 'local')
                Path(command[command.index('-o') + 1]).write_text('new binary')
            elif command == ['pnpm', 'build']:
                assets = self.project / 'web/dist'
                assets.mkdir(parents=True)
                (assets / 'index.html').write_text('<title>DeltaRelay</title>')
            else:
                self.assertEqual(command, ['pnpm', 'install', '--offline', '--frozen-lockfile', '--trust-lockfile'])

        run.side_effect = compile
        binary, assets = build.prepare_build(self.project)
        self.assertEqual(binary.read_text(), 'new binary')
        self.assertTrue(os.access(binary, os.X_OK))
        self.assertTrue((assets / 'index.html').is_file())
        self.assertEqual(run.call_count, 3)
        build.prepare_build(self.project)
        self.assertEqual(run.call_count, 3, 'current build was unnecessarily rebuilt')
        os.utime(source, ns=(binary.stat().st_mtime_ns + 1, binary.stat().st_mtime_ns + 1))
        build.prepare_build(self.project)
        self.assertEqual(run.call_count, 4, 'changed Go source did not rebuild the binary')

    @patch.object(build.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['go', 'build']))
    @patch.object(build.shutil, 'which', return_value='/local/tool')
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
            build.prepare_build(self.project)
        self.assertEqual(binary.read_text(), 'original binary')
        self.assertEqual(list(binary.parent.glob('.dashboard-build-*')), [])

    def test_symlinked_binary_is_never_replaced(self):
        target = self.project / 'target'
        target.write_text('keep')
        (self.project / 'bin').mkdir()
        (self.project / 'bin/deltarelay').symlink_to(target)
        with self.assertRaises(build.RecoveryError):
            build.prepare_build(self.project)
        self.assertEqual(target.read_text(), 'keep')
