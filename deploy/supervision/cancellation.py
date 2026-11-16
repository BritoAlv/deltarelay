"""Cancellation of one mutation without shutting down the local controls."""


class Cancellation:
    def __init__(self, shutdown, interrupt):
        self.shutdown = shutdown
        self.interrupt = interrupt

    def is_set(self):
        return self.shutdown.is_set() or self.interrupt.is_set()

    def wait(self, timeout):
        # Callers use bounded waits (at most three seconds). Supervisor shutdown
        # wakes them immediately; an operation interrupt is checked on either side.
        return self.is_set() or self.shutdown.wait(timeout) or self.is_set()
