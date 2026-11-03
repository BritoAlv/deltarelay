"""Composable DeltaRelay supervision runtime.

The package separates configuration validation, observable state, process
ownership, probes, recovery policy, and the Unix-socket control API. The
top-level ``deploy/supervisor.py`` remains the executable compatibility entry
point.
"""

from .config import (COMPONENTS, DEFAULT_INTERNET_CHECK_URL, INTERNET_CHECK_INTERVAL,
                     LABELS, internet_check_origin, loopback_origin, validate)
from .control import Handler, Server, main
from .process import ProcessManager, matches, process
from .probes import RelayProbe
from .recovery import RecoveryPolicy
from .state import SupervisorState, save_json, stamp
from .supervisor import Supervisor

__all__ = [
    'COMPONENTS', 'DEFAULT_INTERNET_CHECK_URL', 'INTERNET_CHECK_INTERVAL', 'LABELS',
    'Handler', 'ProcessManager', 'RecoveryPolicy', 'RelayProbe', 'Server', 'Supervisor',
    'SupervisorState', 'internet_check_origin', 'loopback_origin', 'main', 'matches',
    'process', 'save_json', 'stamp', 'validate',
]
