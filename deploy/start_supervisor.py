#!/usr/bin/env python3
"""Thin launcher for the supervision package and offline dashboard build."""

import argparse
import os
import sys
from pathlib import Path

from supervision.launcher import start
from supervision.onboarding import create_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True, help='private supervisor configuration')
    parser.add_argument('--setup', action='store_true', help='create first-run dashboard configuration if missing')
    parser.add_argument('--no-desktop', action='store_true')
    parser.add_argument('--no-dashboard', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.setup:
            create_config(args.project.resolve(strict=True), args.config.absolute())
        start(args.project.resolve(strict=True), args.config, args.no_dashboard, args.no_desktop)
    except Exception:
        print('Startup failed. Check private profile/configuration, offline build tools, and control/supervisor.log. '
              'No existing services were stopped.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
