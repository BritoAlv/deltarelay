"""Private, bounded supervisor journal and subprocess diagnostic transport.

The provider's stdout remains its versioned JSON protocol. Bundled providers use
an inherited diagnostic pipe for their *actual* child command/output records;
third-party providers need not implement that optional channel.
"""

import codecs
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import threading


TRACE_FD = 'DELTARELAY_TRACE_FD'
STREAMS = frozenset(('event', 'command', 'stdout', 'stderr', 'output', 'exit', 'error'))
MAX_LINE = 16384
MAX_TEXT = 4096
MAX_FILE_BYTES = 8 << 20
MAX_ENTRIES = 2000
_fd_lock = threading.Lock()
_ansi = re.compile(r'\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])')
_secret_key = re.compile(r'token|secret|password|authorization|api[_-]?key|credential', re.I)


class Redactor:
    """Mask known credentials plus common credential syntax, not diagnostic text."""

    def __init__(self, config=None):
        self.secrets = set()
        self._collect(dict(os.environ))
        self._collect(config or {})
        for key in ('relay_token_file', 'local_token_file', 'opencode_service_file'):
            path = (config or {}).get(key)
            if path:
                self._read(path, json_file=key == 'opencode_service_file')
        remote = (config or {}).get('remote', {})
        if remote.get('config_file'):
            self._read(remote['config_file'], json_file=True)

    def _collect(self, value):
        if isinstance(value, dict):
            for key, item in value.items():
                if _secret_key.search(key) and isinstance(item, str) and not key.endswith(('_file', '_path')):
                    self.add(item)
                elif isinstance(item, (dict, list)):
                    self._collect(item)
        elif isinstance(value, list):
            for item in value:
                self._collect(item)

    def _read(self, path, json_file=False):
        try:
            from remote_provider import private_json
            if json_file:
                self._collect(private_json(Path(path), 65536))
            else:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, 'r') as file:
                    info = os.fstat(file.fileno())
                    if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077 and info.st_size <= 65536:
                        self.add(file.read().strip())
        except Exception:
            # A missing/unreadable credential must still be diagnosed by its
            # normal owner. Never include file contents in this fallback.
            pass

    def add(self, value):
        if isinstance(value, str) and len(value) >= 4:
            self.secrets.add(value)
            # Also catch credentials escaped inside JSON/quoted command output.
            self.secrets.add(json.dumps(value)[1:-1])

    def __call__(self, text):
        text = _ansi.sub('', text)
        text = ''.join(c for c in text if c in '\n\t' or ord(c) >= 32 and not 127 <= ord(c) <= 159)
        for value in sorted(self.secrets, key=len, reverse=True):
            text = text.replace(value, '[REDACTED]')
        text = re.sub(r'(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', r'\1 [REDACTED]', text)
        text = re.sub(r'''(?ix)(\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token)\b["']?\s*[:=]\s*["']?)([^\s"',;\]}]+)''', r'\1[REDACTED]', text)
        text = re.sub(r'(?i)(--(?:token|password|secret|api-key)\s+)(\S+)', r'\1[REDACTED]', text)
        text = re.sub(r'(https?://)[^\s/@:]+:[^\s/@]+@', r'\1[REDACTED]@', text)
        return text


class OutputLines:
    """Incremental UTF-8 lines; do not leak secrets split across pipe reads."""

    def __init__(self, emit):
        self.emit = emit
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.pending = ''
        self.discarding = False
        self.last_cr = False

    def feed(self, data, final=False):
        text = self.decoder.decode(data, final=final)
        if self.last_cr and text.startswith('\n'):
            text = text[1:]
        self.last_cr = text.endswith('\r')
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        for index, part in enumerate(text.split('\n')):
            if index:
                if not self.discarding:
                    self.emit(self.pending)
                self.pending = ''
                self.discarding = False
            if not self.discarding:
                self.pending += part
                if len(self.pending) > MAX_LINE:
                    self.emit('[output line exceeded 16 KiB; line omitted]')
                    self.pending = ''
                    self.discarding = True
        if final:
            if self.pending and not self.discarding:
                self.emit(self.pending)
            self.pending = ''


def inherited_trace():
    """Optional side channel, never banners/progress on provider stdout."""
    value = os.environ.get(TRACE_FD, '')
    if not value.isdigit():
        return None
    fd = int(value)

    def emit(stream, text, execution=''):
        data = (json.dumps({'stream': stream, 'text': text, 'execution': execution}) + '\n').encode()
        try:
            with _fd_lock:
                while data:
                    data = data[os.write(fd, data):]
        except OSError:
            pass  # A diagnostic consumer cannot change a command's outcome.

    return emit


class ActivityJournal:
    def __init__(self, directory, config=None, cancel=None, max_bytes=MAX_FILE_BYTES):
        self.directory = Path(directory)
        self.path = self.directory / 'activity.jsonl'
        self.backup = self.directory / 'activity.jsonl.1'
        self.max_bytes = max_bytes
        self.cancel = cancel or threading.Event()
        self.redact = Redactor(config)
        self.lock = threading.RLock()
        self.local = threading.local()
        self.entries = deque(maxlen=MAX_ENTRIES)
        self.sequence = 0
        self.file_first = 0
        self.storage_error = False
        self.followers = {}
        self.follower_thread = None
        self.pending = deque()
        self.pending_bytes = 0
        self.wake = threading.Event()
        self.persist_lock = threading.Lock()
        try:
            for path in (self.backup, self.path):
                if not path.exists() and not path.is_symlink():
                    continue
                with self._open(path, os.O_RDONLY) as file:
                    if os.fstat(file.fileno()).st_size > max_bytes + 65536:
                        raise OSError('journal exceeds retention bound')
                    for line in file:
                        try:
                            entry = json.loads(line)
                            if (set(entry) != {'seq', 'time', 'component', 'trigger', 'operation', 'execution', 'stream', 'text'} or
                                    type(entry['seq']) is not int or entry['seq'] <= self.sequence or
                                    entry['stream'] not in STREAMS or
                                    any(not isinstance(entry[k], str) for k in entry if k != 'seq') or
                                    len(entry['text']) > MAX_TEXT):
                                raise ValueError('invalid journal record')
                            entry['text'] = self.redact(entry['text'])
                            self.entries.append(entry)
                            self.sequence = entry['seq']
                            if path == self.path and not self.file_first:
                                self.file_first = entry['seq']
                        except (ValueError, TypeError, KeyError):
                            self.storage_error = True
        except OSError:
            self.storage_error = True
        self.writer_thread = threading.Thread(target=self._write_loop, daemon=True)
        self.writer_thread.start()

    def _open(self, path, flags):
        fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise OSError('unsafe journal file')
            return os.fdopen(fd, 'r' if flags == os.O_RDONLY else 'a', encoding='utf-8')
        except BaseException:
            os.close(fd)
            raise

    @contextmanager
    def context(self, **fields):
        previous = getattr(self.local, 'fields', {})
        self.local.fields = {**previous, **fields}
        try:
            yield
        finally:
            self.local.fields = previous

    def sink(self, component=None):
        def emit(stream, text, execution=''):
            self.write(stream, text, component=component, execution=execution)
        return emit

    def write(self, stream, text, component=None, execution=''):
        fields = getattr(self.local, 'fields', {})
        text = self.redact(str(text))
        with self.lock:
            for offset in range(0, max(1, len(text)), MAX_TEXT):
                self.sequence += 1
                entry = {'seq': self.sequence,
                         'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                         'component': component or fields.get('component', 'supervisor'),
                         'trigger': fields.get('trigger', 'startup'),
                         'operation': fields.get('operation', ''), 'execution': execution,
                         'stream': stream, 'text': text[offset:offset + MAX_TEXT]}
                self.entries.append(entry)
                data = json.dumps(entry, ensure_ascii=False) + '\n'
                size = len(data.encode())
                if self.pending_bytes + size > max(65536, 2 * self.max_bytes):
                    # Do not block recovery or grow memory if storage stalls.
                    # The API makes degraded persistence explicit.
                    self.storage_error = True
                else:
                    self.pending.append((entry, data, size))
                    self.pending_bytes += size
        self.wake.set()

    def _write_loop(self):
        while not self.cancel.is_set():
            self.wake.wait(0.2)
            self.wake.clear()
            self.flush()
        self.flush()

    def flush(self):
        """Batch disk I/O outside the state/journal locks and command runners."""
        with self.persist_lock:
            with self.lock:
                pending = list(self.pending)
                self.pending.clear()
                self.pending_bytes = 0
            if not pending:
                return
            try:
                file = self._open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
                try:
                    size_on_disk = file.tell()
                    for entry, data, size in pending:
                        if size_on_disk + size > self.max_bytes:
                            # Validate the destination too; never follow a link
                            # or replace an unrelated non-private file.
                            if self.backup.exists() or self.backup.is_symlink():
                                with self._open(self.backup, os.O_RDONLY):
                                    pass
                            file.close()
                            os.replace(self.path, self.backup)
                            self.file_first = entry['seq']
                            file = self._open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
                            size_on_disk = 0
                        file.write(data)
                        size_on_disk += size
                        if not self.file_first:
                            self.file_first = entry['seq']
                finally:
                    file.close()
            except OSError:
                if not self.storage_error:
                    print('Supervisor activity journal storage failed; retaining bounded memory history.', file=sys.stderr, flush=True)
                self.storage_error = True

    def close(self):
        self.cancel.set()
        self.wake.set()
        if self.follower_thread is not None:
            self.follower_thread.join(timeout=2)
        self.writer_thread.join(timeout=2)
        self.flush()

    def read(self, after=None, before=None, limit=100):
        with self.lock:
            entries = list(self.entries)
            oldest = entries[0]['seq'] if entries else 0
            newest = entries[-1]['seq'] if entries else 0
            reset = after is not None and (after > newest or after < oldest - 1)
            if after is not None and not reset:
                selected = [e for e in entries if e['seq'] > after][:limit]
            elif before is not None:
                selected = [e for e in entries if e['seq'] < before][-limit:]
            else:
                selected = entries[-limit:]
            return {'version': 1, 'entries': [dict(e) for e in selected], 'oldest': oldest,
                    'newest': newest, 'reset': reset, 'storage_error': self.storage_error}

    def follow(self, component, path):
        """Tail existing merged service logs without changing process ownership."""
        path = Path(path)
        with self.lock:
            if path in self.followers:
                return
            try:
                size = path.lstat().st_size
            except OSError:
                size = 0
            self.followers[path] = {'component': component, 'offset': size, 'identity': None,
                                    'lines': OutputLines(lambda text: self._service_output(component, text)), 'failed': False}
            self.write('event', f'Following new stdout/stderr (merged) from {path}', component=component)
            if self.follower_thread is None:
                self.follower_thread = threading.Thread(target=self._follow_loop, daemon=True)
                self.follower_thread.start()

    def _service_output(self, component, text):
        with self.context(trigger='service', operation=''):
            self.write('output', text, component=component)

    def _follow_loop(self):
        while not self.cancel.wait(0.2):
            self.poll_services()
        self.poll_services(final=True)

    def poll_services(self, final=False):
        with self.lock:
            for path, state in self.followers.items():
                try:
                    with self._open(path, os.O_RDONLY) as file:
                        info = os.fstat(file.fileno())
                        identity = (info.st_dev, info.st_ino)
                        if state['identity'] is not None and state['identity'] != identity or info.st_size < state['offset']:
                            state['lines'].feed(b'', final=True)
                            state['offset'] = 0
                            state['lines'] = OutputLines(lambda text, c=state['component']: self._service_output(c, text))
                        state['identity'] = identity
                        # Read bytes, not text offsets; UTF-8 may span polls.
                        file.seek(state['offset'])
                        data = os.read(file.fileno(), 65536)
                        state['offset'] += len(data)
                        state['lines'].feed(data, final=final)
                        state['failed'] = False
                except FileNotFoundError:
                    continue
                except OSError as error:
                    if not state['failed']:
                        self.write('error', f'Cannot follow {path}: {error}', component=state['component'])
                        state['failed'] = True


def operation_id():
    return secrets.token_hex(8)
