import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

from activity import ActivityJournal, MAX_LINE, OutputLines
from remote_provider import ExecutableProvider, ProviderError, run_command
from supervision.control import Handler, Server, control_request
from supervision.supervisor import Supervisor
from test_support import configure_provider


class ActivityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {'version': 1, 'profile': str(self.root), 'relay_url': 'http://127.0.0.1:1',
                       'gateway_url': 'http://127.0.0.1:2', 'components': {},
                       'relay_token_file': str(self.private('relay.token', 'relay-private-secret')),
                       'local_token_file': str(self.private('local.token', 'local-private-secret')),
                       'relay_state_file': str(self.private('identity.json', json.dumps('a' * 64)))}
        configure_provider(self.config)

    def private(self, name, text):
        path = self.root / name
        path.write_text(text)
        path.chmod(0o600)
        return path

    def journal(self, **kwargs):
        journal = ActivityJournal(self.root, self.config, **kwargs)
        self.addCleanup(journal.close)
        return journal

    def subject(self):
        subject = Supervisor(self.config)
        self.addCleanup(subject.close)
        return subject

    def test_real_output_is_available_before_exit_and_exit_code_is_preserved(self):
        journal = self.journal()
        release = self.root / 'release'
        errors = []
        command = [sys.executable, '-u', '-c',
                   'import pathlib,sys,time; print("ready stdout"); print("real SSH failure", file=sys.stderr); '
                   'p=pathlib.Path(sys.argv[1]);\nwhile not p.exists(): time.sleep(.01)\nsys.exit(7)', str(release)]

        def work():
            try:
                with journal.context(component='relay', trigger='manual', operation='a' * 16):
                    run_command(command, trace=journal.sink(), timeout=5)
            except ProviderError as error:
                errors.append(str(error))

        thread = threading.Thread(target=work)
        thread.start()
        try:
            deadline = time.monotonic() + 3
            while not any(e['stream'] == 'stderr' and e['text'] == 'real SSH failure' for e in journal.read()['entries']) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(thread.is_alive(), 'command output was held until exit')
            entries = journal.read()['entries']
            self.assertTrue(any(e['stream'] == 'command' and '$ ' in e['text'] for e in entries))
            self.assertTrue(any(e['stream'] == 'stdout' and e['text'] == 'ready stdout' for e in entries))
            self.assertTrue(any(e['stream'] == 'stderr' and e['text'] == 'real SSH failure' for e in entries))
            self.assertTrue(all(e['operation'] == 'a' * 16 and e['trigger'] == 'manual' for e in entries))
        finally:
            release.touch()
            thread.join(timeout=5)
        self.assertEqual(errors, ['command_failed'])
        self.assertIn('exit_code=7', journal.read()['entries'][-1]['text'])

    def test_timeout_cancellation_spawn_errors_and_broken_consumer_are_visible(self):
        journal = self.journal()
        with self.assertRaisesRegex(ProviderError, '^command_timeout$'):
            run_command([sys.executable, '-u', '-c', 'import time; print("waiting"); time.sleep(10)'], timeout=.15, trace=journal.sink())
        self.assertIn('outcome=command_timeout', journal.read()['entries'][-1]['text'])
        with self.assertRaisesRegex(ProviderError, '^command_failed$'):
            run_command([str(self.root / 'missing-command')], trace=journal.sink())
        self.assertIn('FileNotFoundError', journal.read()['entries'][-1]['text'])
        cancelled = threading.Event()
        timer = threading.Timer(.1, cancelled.set)
        timer.start()
        try:
            with self.assertRaisesRegex(ProviderError, '^operation_cancelled$'):
                run_command([sys.executable, '-c', 'import time; time.sleep(10)'], cancel=cancelled, trace=journal.sink())
        finally:
            timer.join()
        self.assertIn('outcome=operation_cancelled', journal.read()['entries'][-1]['text'])

        def broken(*_):
            raise OSError('consumer gone')
        self.assertEqual(run_command(['/bin/echo', 'still works'], trace=broken), b'still works\n')

    def test_redaction_across_pipe_reads_utf8_controls_and_oversized_lines(self):
        journal = self.journal()
        command = [sys.executable, '-c',
                   'import os,time; os.write(2,b"relay-private-"); time.sleep(.05); '
                   'os.write(2,b"secret\\nAuthorization: Bearer not-configured-secret\\n"); '
                   'os.write(1,"h\u00e9llo \\x1b[31mred\\x1b[0m\\n".encode())']
        run_command(command, trace=journal.sink())
        journal.flush()
        data = journal.path.read_text()
        for secret in ('relay-private-secret', 'not-configured-secret', '\\u001b'):
            self.assertNotIn(secret, data)
        self.assertIn('[REDACTED]', data)
        self.assertIn('héllo red', data)
        lines = []
        capture = OutputLines(lines.append)
        capture.feed(b'x' * (MAX_LINE + 1))
        capture.feed(b'ignored\nnext\n', final=True)
        self.assertEqual(lines, ['[output line exceeded 16 KiB; line omitted]', 'next'])
        lines.clear()
        capture = OutputLines(lines.append)
        capture.feed(b'first\r')
        capture.feed(b'\n\nsecond\n', final=True)
        self.assertEqual(lines, ['first', '', 'second'])

    def test_new_setup_credentials_are_masked_without_mutating_reader_snapshots(self):
        journal = self.journal()
        snapshot = journal.redact.secrets
        journal.redact.add('newly-generated-setup-credential')
        self.assertNotIn('newly-generated-setup-credential', snapshot)
        journal.write('stdout', 'diagnostic newly-generated-setup-credential')
        journal.flush()
        self.assertNotIn('newly-generated-setup-credential', journal.path.read_text())
        self.assertEqual(journal.read()['entries'][-1]['text'], 'diagnostic [REDACTED]')

    def test_rotation_restart_cursors_and_private_permissions(self):
        journal = self.journal(max_bytes=2048)
        for i in range(40):
            journal.write('event', f'background check {i}')
        journal.flush()
        for path in (journal.path, journal.backup):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertLessEqual(path.stat().st_size, 2048)
        journal.close()
        restored = self.journal(max_bytes=2048)
        page = restored.read()
        self.assertEqual(page['newest'], 40)
        self.assertGreater(page['oldest'], 1)
        self.assertTrue(restored.read(after=1)['reset'])
        self.assertTrue(restored.read(after=999)['reset'])
        self.assertEqual(restored.read(after=40)['entries'], [])
        earlier = restored.read(before=40, limit=2)['entries']
        self.assertEqual([e['seq'] for e in earlier], [38, 39])
        restored.write('event', 'after restart')
        self.assertEqual(restored.read(after=40)['entries'][0]['seq'], 41)
        self.assertNotIn('after restart', journal.read()['entries'][-1]['text'])

    def test_unsafe_files_and_storage_errors_do_not_change_operations(self):
        target = self.private('untouched', 'do not overwrite')
        (self.root / 'activity.jsonl').symlink_to(target)
        journal = self.journal()
        journal.write('event', 'in-memory fallback')
        journal.flush()
        self.assertTrue(journal.read()['storage_error'])
        self.assertEqual(target.read_text(), 'do not overwrite')
        self.assertEqual(journal.read()['entries'][-1]['text'], 'in-memory fallback')

    def test_service_output_is_followed_without_a_browser_and_masked_on_disk(self):
        journal = self.journal()
        path = self.private('gateway.log', 'old service history is not reimported\n')
        journal.follow('gateway', path)
        with path.open('a') as file:
            file.write('background stdout\nlocal-private-secret\n')
        journal.poll_services()
        entries = [e for e in journal.read()['entries'] if e['stream'] == 'output']
        self.assertEqual([e['text'] for e in entries], ['background stdout', '[REDACTED]'])
        self.assertTrue(all(e['component'] == 'gateway' and e['trigger'] == 'service' for e in entries))
        journal.flush()
        self.assertNotIn('local-private-secret', journal.path.read_text())

    def test_nested_provider_commands_do_not_corrupt_stdout_protocol(self):
        journal = self.journal()
        plugin = self.private('provider.py', '''import json, sys
from providers.common import provider_command
request = json.load(sys.stdin)
provider_command([sys.executable, '-c', 'import sys; print("nested stdout"); print("nested stderr", file=sys.stderr)'])
result = {'id': 'traced', 'label': 'Traced provider', 'capabilities': []} if request['method'] == 'describe' else {'relay_url': 'http://127.0.0.1:1'}
print(json.dumps({'protocol_version': 1, 'id': request['id'], 'result': result}))
''')
        config = self.private('provider.json', '{}')
        provider = ExecutableProvider({'command': [sys.executable, '-B', str(plugin)], 'config_file': str(config),
                                       'env': {'PYTHONPATH': str(Path(__file__).parent)}}, 'http://127.0.0.1:1', threading.Event(), trace=journal.sink('provider'))
        provider.prepare()
        entries = journal.read()['entries']
        self.assertEqual(provider.metadata['id'], 'traced')
        self.assertTrue(any(e['stream'] == 'stdout' and e['text'] == 'nested stdout' for e in entries))
        self.assertTrue(any(e['stream'] == 'stderr' and e['text'] == 'nested stderr' for e in entries))
        self.assertGreaterEqual(sum(e['stream'] == 'command' for e in entries), 4)
        self.assertTrue(any('"protocol_version": 1' in e['text'] for e in entries if e['stream'] == 'stdout'))

    def test_background_decisions_and_control_api_history_are_independent_of_gateway(self):
        from unittest.mock import patch
        subject = self.subject()
        subject.update_settings({'auto_reconnect': False, 'auto_wake': False})
        with patch.object(subject, 'probe', return_value='unreachable'), patch.object(subject, 'internet_probe', return_value='connected'):
            subject.tick()
        self.assertTrue(any('Automatic recovery skipped' in e['text'] and e['trigger'] == 'monitor' for e in subject.journal.read()['entries']))
        # Keep the socket short enough even with the approved long TMPDIR.
        path = self.root / 's'
        if len(str(path)) >= 104:
            self.skipTest('temporary directory exceeds Unix socket path limit')
        with Server(str(path), Handler) as server:
            server.supervisor = subject
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                code, page = control_request(path, 'GET', '/journal?after=0&limit=2')
                self.assertEqual(code, 200)
                self.assertEqual(len(page['entries']), 2)
                for query in ('after=1&before=2', 'path=/etc/passwd', 'after=-1', 'after=1&after=2', 'limit=101'):
                    self.assertEqual(control_request(path, 'GET', '/journal?' + query)[0], 400)
            finally:
                server.shutdown()
                worker.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
