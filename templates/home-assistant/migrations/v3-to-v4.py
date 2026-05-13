#!/usr/bin/env python3
"""
Migration: home-assistant v3 → v4 (#420 / #422).

Z-Wave JS UI now starts unconditionally and is reachable at
`zwave.<lanDomain>` through a new LAN-only NPM proxy host. No data
moves — the existing `${DATA_DIR}/home-assistant/zwave-js` directory
is reused.

What this script does:
  - Inform the operator about the redeploy behaviour. The new
    container starts in "no serial device configured" mode when
    ZWAVE_DEVICE is left blank, so installs that previously skipped
    Z-Wave entirely now expose a UI at zwave.<lan>.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    device = os.environ.get("ZWAVE_DEVICE", "").strip()
    print("Home Assistant v3 → v4: Z-Wave JS UI always-on + new LAN subdomain (#420 / #422).")
    if device:
        print(f"  Z-Wave stick configured at {device}; the UI keeps that mount and continues to manage it.")
    else:
        print("  No ZWAVE_DEVICE configured. The Z-Wave JS UI still starts and is reachable at")
        print("  zwave.<lanDomain> — you can plug in a stick later and point the UI at it via")
        print("  Settings → Z-Wave → Serial Port without editing the pod yaml.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
