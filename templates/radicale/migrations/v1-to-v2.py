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

The existing `caldav.<domain>` NPM host is retargeted AUTOMATICALLY by
ServiceBay's core reconcile — this migration does NOT touch the proxy
itself (#2364, completing #2357). On every deploy the install runner
runs `ensureProxyHosts`, which walks the stack variables through
`buildProxyHosts`: RADICALE_SUBDOMAIN's `loopbackOnly: true` makes it
emit `forwardHost: 127.0.0.1`, and the proxy-hosts endpoint's
existing-host branch (`reconcileProxyHostUpstream` /
`decideUpstreamReconcile`) re-points the live host's forward target
from the old LAN IP (`192.168.178.100:{{RADICALE_PORT}}`, now closed)
to `127.0.0.1:{{RADICALE_PORT}}`. That reconcile PUTs ONLY the forward
target, so exposure (public), auth (Radicale Basic — no Authelia) and
the bound cert are untouched, and it is idempotent (a no-op once the
host is already loopback). No manual proxy edit is needed.

What this script does:
  - Inform the operator that the DAV port is now loopback-bound, that
    `caldav.<domain>` is retargeted to loopback automatically by the
    core reconcile (no manual proxy edit), and that no data moves
    (Radicale's collections live on /data, untouched). It is read-only.
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
    print(f"  ServiceBay retargets the existing caldav.<domain> proxy host to")
    print(f"  127.0.0.1:{port} automatically on this deploy (core reconcile,")
    print("  #2364) — no manual proxy edit; exposure (public), Basic auth and")
    print("  the cert are preserved.")
    print("  No data is moved; Radicale's collections under /data are untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
