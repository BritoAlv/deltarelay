#!/usr/bin/env python3
"""Compatibility entry point for the DeltaRelay supervision package.

The implementation lives in ``deploy/supervision/``. This module keeps the
existing executable path and import names used by private launchers and tests.
"""

import sys
import time

from recover_relay import NoRedirect, private_text
from remote_provider import (PERMANENT, ProviderError as ControlError, environment, origin,
                             plugin_environment, private_json, run_command, validate_spec)
from providers.legacy import load_provider, normalize_component, validate_legacy

from supervision import (COMPONENTS, DEFAULT_INTERNET_CHECK_URL, INTERNET_CHECK_INTERVAL,
                         LABELS, Handler, ProcessManager, RecoveryPolicy, RelayProbe, Server,
                         Supervisor, SupervisorState, internet_check_origin, loopback_origin,
                         matches, process, save_json, stamp, validate)
from supervision.control import main

__all__ = [
    'COMPONENTS', 'ControlError', 'DEFAULT_INTERNET_CHECK_URL', 'Handler',
    'INTERNET_CHECK_INTERVAL', 'LABELS', 'PERMANENT', 'ProcessManager', 'RecoveryPolicy',
    'RelayProbe', 'Server', 'Supervisor', 'SupervisorState', 'environment',
    'internet_check_origin', 'load_provider', 'loopback_origin', 'main', 'matches',
    'normalize_component', 'origin', 'plugin_environment', 'private_json', 'private_text',
    'process', 'run_command', 'save_json', 'stamp', 'time', 'validate', 'validate_legacy',
    'validate_spec', 'NoRedirect',
]


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Supervisor failed; check the private configuration, permissions, and exclusive control lock.',
              file=sys.stderr)
        sys.exit(1)
