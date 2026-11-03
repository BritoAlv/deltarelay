#!/usr/bin/env python3
"""Thin launcher for the supervision package and offline dashboard build."""

import argparse
import os
import sys
from pathlib import Path

from supervision.config import codespace_config, validate
from supervision.control import control_request, controller_status
from supervision.launcher import start

__all__ = ['codespace_config', 'control_request', 'controller_status', 'start']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--config', type=Path, help='private configuration for an existing remote host and optional provider plugin')
    parser.add_argument('--port', type=int, default=8790)
    parser.add_argument('--no-desktop', action='store_true')
    parser.add_argument('--no-dashboard', action='store_true')
    args = parser.parse_args()
    if not 0 < args.port < 65536 or not (args.profile or args.config):
        parser.error('provide --profile or --config and a valid port')
    os.umask(0o077)
    try:
        start(args.project.resolve(strict=True), args.profile, args.config, args.port, args.no_dashboard, args.no_desktop)
    except Exception:
        print('Startup failed. Check private profile/configuration, offline build tools, and control/supervisor.log. '
              'No existing services were stopped.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
