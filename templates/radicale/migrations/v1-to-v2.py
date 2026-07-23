#!/usr/bin/env python3
"""
Migration: radicale v1 → v2 (#2357).

What changed between v1 and v2: the Radicale DAV port
(`RADICALE_PORT`, default 5232) is now published to the host
**loopback only** (`hostIP: 127.0.0.1`) instead of `0.0.0.0`. Under
v1 the port had no `hostIP`, so podman bound it on every interface and
Radicale's HTTP API was reachable directly on the LAN at
`http://<box-lan-ip>:5232/`, bypassing the nginx reverse proxy that
fronts `caldav.<domain>`.

The actual rebind is structural: `podman play kube` recreates the pod
from the v2 manifest, which carries the `hostIP: 127.0.0.1`. nginx
runs on hostNetwork and now forwards `caldav.<domain>` to
`127.0.0.1:{{RADICALE_PORT}}` (the `loopbackOnly: true` flag on
RADICALE_SUBDOMAIN in variables.json), so the public subdomain keeps
working while the direct-on-LAN path is closed.

What this script does:
  - Inform the operator that the DAV port is now loopback-bound and
    that `caldav.<domain>` is unaffected. It is read-only — no data
    moves (Radicale's collections live on /data, untouched).
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 1
  - NEW_SCHEMA_VERSION = 2
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, RADICALE_SUBDOMAIN, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    port = os.environ.get("RADICALE_PORT", "5232")
    print(f"Radicale v1 → v2: DAV port {port} is now bound to 127.0.0.1 only (#2357).")
    print("  It is no longer published on 0.0.0.0, so it can't be hit directly")
    print("  on the LAN — access goes through the nginx reverse proxy at")
    print("  caldav.<domain> (TLS), which now forwards to 127.0.0.1.")
    print("  No data is moved; Radicale's collections under /data are untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
