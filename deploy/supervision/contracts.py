"""Internal lifecycle contracts. These do not change the relay/provider protocols.

Adapters own one resource; only the coordinator can resolve dependencies. A
command returning successfully is an action outcome, never readiness evidence.
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Observation:
    lifecycle: str = 'unknown'
    readiness: str = 'unknown'
    detail: str = 'Not verified yet.'


@dataclass(frozen=True)
class Step:
    component: str
    action: str


class ComponentAdapter(Protocol):
    def observe(self) -> Observation: ...
    def start(self): ...
    def recover(self): ...
    def restart(self): ...
    def stop(self): ...
    def verify(self): ...


@dataclass
class ConnectionFacts:
    """Per-attempt facts, not a cached assumption that a service is healthy."""
    relay: str = 'unknown'
    provider_ready: bool = False
    host_checked: bool = False
    host: str = 'unknown'
    wake: bool = False
    can_wake: bool = False
    has_tunnel: bool = False
    tunnel_repairs: int = 0
    relay_attempted: bool = False
    verification_due: bool = False


def next_connection_step(facts):
    """Pure, bounded repair policy. Re-evaluated after every verified step.

    Lifecycle prerequisites are deliberately separate from the traffic graph:
    checking the relay through a tunnel must not create a tunnel/relay startup
    dependency cycle. Try the local link before touching the remote daemon.
    """
    if facts.relay == 'unknown':
        return Step('relay', 'observe')
    if facts.relay == 'connected':
        return None
    if not facts.provider_ready:
        return Step('remote_provider', 'observe')
    if not facts.host_checked:
        return Step('remote', 'observe')
    if facts.host in ('stopped', 'stopping'):
        return Step('remote', 'wake') if facts.wake and facts.can_wake else Step('remote', 'blocked')
    if facts.host == 'starting':
        return Step('remote', 'verify')
    if facts.verification_due:
        return Step('relay', 'verify')
    wanted_repairs = 2 if facts.relay_attempted else 1
    if facts.has_tunnel and facts.tunnel_repairs < wanted_repairs:
        return Step('tunnel', 'recover')
    if not facts.relay_attempted:
        return Step('relay', 'recover')
    return None
