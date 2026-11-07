"""Read-only Linux network change hints, with a portable polling fallback.

No interface names/types are assumed and no network settings are changed.
RTNETLINK covers addresses, IPv4/IPv6 routes and policy routing (VPN split
routes included). Fingerprints cover link/address/DNS changes and missed events.
Only a generation counter, never addresses, SSIDs, or DNS contents, is published.
Hints accelerate probes; they are not evidence that a tunnel needs a restart.
"""

import hashlib
import struct
from pathlib import Path
import select
import socket

try:
    import fcntl
except ImportError:
    fcntl = None


def fingerprint(root=Path('/')):
    digest = hashlib.sha256()
    for relative in ('proc/net/route', 'proc/net/ipv6_route', 'proc/net/if_inet6',
                     'etc/resolv.conf', 'run/systemd/resolve/resolv.conf'):
        try:
            digest.update((root / relative).read_bytes()[:262144])
        except OSError:
            digest.update(relative.encode())
    try:
        for interface in sorted((root / 'sys/class/net').iterdir()):
            digest.update(interface.name.encode())
            for attribute in ('operstate', 'carrier'):
                try:
                    digest.update((interface / attribute).read_bytes()[:256])
                except OSError:
                    pass
            if fcntl is not None and root == Path('/'):
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as local:
                        address = fcntl.ioctl(local.fileno(), 0x8915,
                                              struct.pack('256s', interface.name.encode()[:15]))
                        digest.update(address[20:24])
                except OSError:
                    pass
    except OSError:
        pass
    return digest.digest()


class NetworkMonitor:
    def __init__(self, changed, stop, sample=fingerprint, socket_factory=socket.socket):
        self.changed = changed
        self.stop = stop
        self.sample = sample
        self.socket_factory = socket_factory

    def run(self):
        try:
            previous = self.sample()
        except Exception:
            previous = None
        listener = None
        try:
            try:
                listener = self.socket_factory(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)
                # Link, IPv4/IPv6 address, route and rule multicast groups.
                listener.bind((0, 0x1 | 0x10 | 0x40 | 0x80 | 0x100 | 0x400 | 0x80000))
                listener.setblocking(False)
            except (AttributeError, OSError):
                if listener:
                    listener.close()
                listener = None
            while not self.stop.is_set():
                event = False
                if listener:
                    try:
                        ready, _, _ = select.select([listener], [], [], 1)
                        if ready:
                            # A single hint per polling interval debounces bursts.
                            for _ in range(64):
                                try:
                                    listener.recv(65536)
                                    event = True
                                except BlockingIOError:
                                    break
                    except OSError:
                        listener.close()
                        listener = None
                elif self.stop.wait(1):
                    break
                try:
                    current = self.sample()
                except Exception:
                    # Enumeration can race an interface disappearing. The
                    # supervisor's periodic probe remains the fallback.
                    self.stop.wait(1)
                    continue
                if event or current != previous:
                    previous = current
                    self.changed()
        finally:
            if listener:
                listener.close()
