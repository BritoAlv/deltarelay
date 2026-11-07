"""Recovery scheduling, backoff, and provider retry policy."""

import threading
import time


class RecoveryPolicy:
    """Owns all retry timing, independent of observable status.

    The supervisor serializes operations, but settings updates and snapshots can
    run on other threads, so the policy's small mutable surface has its own lock.
    Callers inject ``clock`` and ``wall_clock`` in tests; production defaults
    resolve the time module dynamically so existing controlled-time patches
    remain effective.
    """

    def __init__(self, clock=None, wall_clock=None):
        self._clock = clock or (lambda: time.monotonic())
        self._wall = wall_clock or time.time
        self.lock = threading.Lock()
        self.failures = 0
        self.delay = 2
        self.next_attempt = 0.0
        self.provider_blocked = ''
        self.provider_error = ''
        self.provider_next = 0.0
        self.provider_delay = 2
        self.host_status_next = 0.0
        self.components = {}

    def network_changed(self):
        """Debounce route changes, without clearing permanent failures/consent."""
        with self.lock:
            self.failures = max(2, self.failures)
            self.next_attempt = self._clock() + 1
            self.provider_next = 0.0
            self.host_status_next = 0.0

    def component_due(self, name):
        with self.lock:
            return self._clock() >= self.components.get(name, (0.0, 2))[0]

    def component_result(self, name, success):
        with self.lock:
            if success:
                self.components.pop(name, None)
                return
            _, delay = self.components.get(name, (0.0, 2))
            self.components[name] = (self._clock() + delay, min(30, delay * 2))

    def record_connected(self):
        with self.lock:
            self.failures, self.delay, self.next_attempt = 0, 2, 0.0

    def reset_attempt(self):
        with self.lock:
            self.next_attempt = 0.0

    def note_failure(self):
        with self.lock:
            self.failures += 1
            return self.failures

    def recovery_due(self):
        now = self._clock()
        with self.lock:
            return self.failures >= 3 and now >= self.next_attempt

    def defer(self):
        with self.lock:
            self.next_attempt = self._clock() + self.delay

    def schedule_retry(self):
        now = self._clock()
        with self.lock:
            self.next_attempt = now + self.delay
            retry_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self._wall() + self.delay))
            self.delay = min(30, self.delay * 2)
            return retry_at

    def delay_value(self):
        with self.lock:
            return self.delay

    def next_attempt_value(self):
        with self.lock:
            return self.next_attempt

    def set_next_attempt(self, value):
        with self.lock:
            self.next_attempt = value

    def set_provider_blocked(self, value):
        with self.lock:
            self.provider_blocked = value

    def provider_blocked_value(self):
        with self.lock:
            return self.provider_blocked

    def provider_due(self):
        now = self._clock()
        with self.lock:
            return not self.provider_blocked and now >= self.provider_next

    def host_status_due(self):
        now = self._clock()
        with self.lock:
            return now >= self.host_status_next

    def provider_ok(self, host_status_next=None):
        with self.lock:
            self.provider_error = ''
            self.provider_delay = 2
            if host_status_next is not None:
                self.host_status_next = host_status_next

    def provider_failed(self, error, permanent):
        with self.lock:
            self.provider_error = error
            if permanent:
                self.provider_blocked = error
            self.provider_next = self._clock() + self.provider_delay
            self.provider_delay = min(30, self.provider_delay * 2)

    def provider_status(self):
        now = self._clock()
        with self.lock:
            if self.provider_blocked:
                return self.provider_error, self.provider_blocked, None
            retry_at = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                     time.gmtime(self._wall() + max(0, self.provider_next - now)))
            return self.provider_error, self.provider_blocked, retry_at
