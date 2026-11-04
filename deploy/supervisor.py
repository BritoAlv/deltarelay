#!/usr/bin/env python3
"""Run the private DeltaRelay supervisor."""

import sys
from supervision.control import main


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Supervisor failed; check the private configuration, permissions, and exclusive control lock.',
              file=sys.stderr)
        sys.exit(1)
