"""Bounded, private timeline of the supervisor's observed system state.

The dashboard is a viewer, not the recorder: this history keeps running while
no browser is open and can distinguish an intact supervisor from a period when
the tool itself was not running. Records contain only epoch seconds and a fixed
state name. They never contain commands, paths, credentials, or probe output.

Each line is a compact JSON array::

    [1760000000, "connected"]   state transition
    [1760000060]                heartbeat / last observation

The last heartbeat bounds a gap. At the next start a gap longer than
``OFF_GAP_SECONDS`` is recorded as ``off`` instead of guessing that the previous
state continued while the tool was not running.
"""

import json
import os
from pathlib import Path
import stat
import threading
import time
import urllib.parse


STATES = ('connected', 'recovering', 'unreachable', 'host_stopped',
          'no_internet', 'stopped', 'off', 'unknown')
HEARTBEAT_SECONDS = 60
OFF_GAP_SECONDS = 30
RETENTION_SECONDS = 90 * 86400
MAX_BUCKETS = 2000
MAX_INTERVALS = 6000
MAX_SPAN_SECONDS = 3660 * 86400
MAX_FILE_BYTES = 8 << 20
MAX_RECORDS = 400000


def stamp(seconds):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(seconds))


def classify(observation):
    """Derive one mutually exclusive state from the supervisor observation.

    ``intent`` and provider/host values are read under the state lock by the
    caller and passed as a plain copy. A busy operation wins over the previous
    connection fact so short recovery steps are visible in the timeline.
    """
    if observation.get('intent') == 'stopped':
        return 'stopped'
    if observation.get('busy'):
        return 'recovering'
    relay = observation.get('relay_state')
    if relay == 'connected':
        return 'connected'
    host = observation.get('host_state')
    if host in ('stopped', 'stopping'):
        return 'host_stopped'
    if host == 'starting':
        return 'recovering'
    if observation.get('internet_state') == 'unreachable':
        return 'no_internet'
    if relay and relay != 'unknown':
        return 'unreachable'
    return 'unknown'


def parse_query(raw):
    """Validate the bounded read-only history query.

    The same grammar is enforced by the dashboard proxy. Only three integer
    parameters are accepted; commands, paths, duplicate parameters, and
    oversized windows are rejected.
    """
    if len(raw) > 128:
        raise ValueError('invalid query')
    try:
        query = urllib.parse.parse_qs(raw, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        raise ValueError('invalid query') from None
    if set(query) != {'start', 'end', 'bucket'}:
        raise ValueError('invalid query')
    values = {}
    for key, items in query.items():
        if len(items) != 1 or not items[0].isascii() or not items[0].isdigit() or len(items[0]) > 16:
            raise ValueError('invalid query')
        value = int(items[0])
        if value > 253402300799:
            raise ValueError('invalid query')
        values[key] = value
    start, end, bucket = values['start'], values['end'], values['bucket']
    if start >= end or end - start > MAX_SPAN_SECONDS or bucket < 1:
        raise ValueError('invalid query')
    if (end - start + bucket - 1) // bucket > MAX_BUCKETS:
        raise ValueError('invalid query')
    return start, end, bucket


class StateHistory:
    """Append-only transition log plus in-memory interval aggregation."""

    def __init__(self, path, *, clock=None, journal=None):
        self.path = Path(path)
        self.backup = Path(str(path) + '.1')
        self.clock = clock or time.time
        self.journal = journal
        self.lock = threading.RLock()
        self.transitions = []
        self.current = 'unknown'
        self.tracking_since = None
        self.last_seen = None
        self.last_heartbeat = 0
        self.storage_error = False
        self.closed = False
        self._load_error = False
        self._records = self._load()

    def _log(self, stream, text):
        if self.journal:
            self.journal.write(stream, text, component='state')

    def _mark_storage_error(self):
        if not self.storage_error:
            self.storage_error = True
            self._log('error', 'State history is not being saved; timestamps remain available in memory.')

    def _read(self, path):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return []
        except OSError as error:
            self._load_error = True
            if path == self.path:
                self._log('error', f'State history could not be opened: {type(error).__name__}')
            return []
        with os.fdopen(fd, 'r', encoding='utf-8') as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    info.st_mode & 0o077 or info.st_size > MAX_FILE_BYTES + 65536):
                self._load_error = True
                if path == self.path:
                    self._log('error', 'State history file failed the private-file checks; it was not imported.')
                return []
            records = []
            for line in file:
                try:
                    value = json.loads(line)
                    if not isinstance(value, list) or len(value) not in (1, 2):
                        raise ValueError('invalid shape')
                    if type(value[0]) is not int or value[0] < 0:
                        raise ValueError('invalid time')
                    if len(value) == 2 and value[1] not in STATES:
                        raise ValueError('invalid state')
                    records.append((value[0], value[1] if len(value) == 2 else None))
                except (ValueError, TypeError):
                    self._load_error = True
                    continue
            return records

    def _load(self):
        records = self._read(self.backup) + self._read(self.path)
        if self._load_error:
            self._mark_storage_error()
        if len(records) > MAX_RECORDS:
            records = records[-MAX_RECORDS:]
        return records

    def start(self, initial_state):
        """Open the timeline and, when needed, close an ``off`` gap."""
        with self.lock:
            now = int(self.clock())
            records = self._records
            cutoff = now - RETENTION_SECONDS
            if records:
                # Retain the last transition before the cutoff so the state at
                # the start of the retained window is not lost.
                keep = 0
                for index, (at, state) in enumerate(records):
                    if state is not None and at <= cutoff:
                        keep = index
                records = records[keep:]
            transitions = [(at, state) for at, state in records
                           if state is not None and at <= now]
            last_seen = max((at for at, _ in records if at <= now), default=None)
            self.transitions = transitions
            if not transitions:
                self.tracking_since = now
                self.current = initial_state
                self.last_seen = now
                self.last_heartbeat = now
                self.transitions.append((now, initial_state))
                self._append([now, initial_state])
                self._append([now])
                return
            self.current = transitions[-1][1]
            self.tracking_since = max(cutoff, transitions[0][0])
            if last_seen is None or last_seen < transitions[-1][0]:
                last_seen = transitions[-1][0]
            self.last_seen = last_seen
            self.last_heartbeat = last_seen
            if now - last_seen > OFF_GAP_SECONDS:
                if self.current != 'off':
                    self._transition(last_seen, 'off')
                self._transition(now, initial_state)
            elif initial_state != self.current:
                self._transition(now, initial_state)
            self.last_seen = now
            self.last_heartbeat = now
            self._append([now])

    def _transition(self, at, state):
        at = max(at, self.transitions[-1][0] if self.transitions else at)
        if state != self.current or not self.transitions:
            self.transitions.append((at, state))
            self.current = state
            self._append([at, state])

    def _append(self, value):
        data = (json.dumps(value, separators=(',', ':')) + '\n').encode('utf-8')
        try:
            info = self.path.lstat() if self.path.exists() or self.path.is_symlink() else None
            if info is not None and (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077):
                raise OSError('unsafe state history file')
            if info is not None and info.st_size + len(data) > MAX_FILE_BYTES:
                if self.backup.exists() or self.backup.is_symlink():
                    backup = self.backup.lstat()
                    if (not stat.S_ISREG(backup.st_mode) or backup.st_uid != os.getuid() or
                            backup.st_mode & 0o077):
                        raise OSError('unsafe state history backup')
                    self.backup.unlink()
                os.replace(self.path, self.backup)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise OSError('unsafe state history file')
                while data:
                    data = data[os.write(fd, data):]
            finally:
                os.close(fd)
        except OSError:
            self._mark_storage_error()

    def observe(self, observation):
        """Record a classification change. Called outside the state lock."""
        state = classify(observation)
        with self.lock:
            if self.closed:
                return state
            now = int(self.clock())
            if self.last_seen is not None:
                now = max(now, self.last_seen)
            if state != self.current:
                self._transition(now, state)
            self.last_seen = now
            if now - self.last_heartbeat >= HEARTBEAT_SECONDS:
                self.last_heartbeat = now
                self._append([now])
            return state

    def tick(self):
        with self.lock:
            if self.closed:
                return
            now = int(self.clock())
            if self.last_seen is not None:
                now = max(now, self.last_seen)
            self.last_seen = now
            if now - self.last_heartbeat >= HEARTBEAT_SECONDS:
                self.last_heartbeat = now
                self._append([now])

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            now = int(self.clock())
            if self.last_seen is not None:
                now = max(now, self.last_seen)
            self.last_seen = now
            self.last_heartbeat = now
            self._append([now])

    def query(self, start, end, bucket):
        """Build bounded exact intervals and per-bucket seconds."""
        start, end, bucket = parse_query(f'start={start}&end={end}&bucket={bucket}')
        with self.lock:
            transitions = list(self.transitions)
            current = self.current
            now = max(int(self.clock()), transitions[-1][0] if transitions else 0)
            since = transitions[-1][0] if transitions else now
            tracking_since = self.tracking_since if self.tracking_since is not None else now
            storage_error = self.storage_error
        spans = []
        for index, (at, state) in enumerate(transitions):
            finish = transitions[index + 1][0] if index + 1 < len(transitions) else max(now, at)
            if finish > at:
                spans.append((at, finish, state))
        intervals = []
        for at, finish, state in spans:
            left = max(at, start)
            right = min(finish, end)
            if right <= left:
                continue
            if intervals and intervals[-1]['state'] == state and intervals[-1]['end'] == left:
                intervals[-1]['end'] = right
            else:
                intervals.append({'start': left, 'end': right, 'state': state})
        count = (end - start + bucket - 1) // bucket
        values = [{state: 0 for state in STATES} for _ in range(count)]
        totals = {state: 0 for state in STATES}
        for item in intervals:
            left, right, state = item['start'], item['end'], item['state']
            first = (left - start) // bucket
            last = (right - 1 - start) // bucket
            for index in range(first, last + 1):
                bucket_start = start + index * bucket
                bucket_end = min(start + (index + 1) * bucket, end)
                overlap = min(right, bucket_end) - max(left, bucket_start)
                if overlap > 0:
                    values[index][state] += overlap
                    totals[state] += overlap
        shown = intervals[:MAX_INTERVALS]
        return {
            'version': 1,
            'tracking_since': stamp(tracking_since),
            'generated_at': stamp(now),
            'start': stamp(start),
            'end': stamp(end),
            'bucket_seconds': bucket,
            'states': list(STATES),
            'buckets': [{'start': stamp(start + index * bucket), 'seconds': value}
                        for index, value in enumerate(values)],
            'intervals': [{'start': stamp(item['start']), 'end': stamp(item['end']), 'state': item['state']}
                          for item in shown],
            'intervals_complete': len(intervals) <= MAX_INTERVALS,
            'totals': totals,
            'current': {'state': current, 'since': stamp(since)},
            'persistent': not storage_error,
            'storage_error': storage_error,
        }
