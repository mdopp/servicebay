#!/usr/bin/env python3
"""
Migration: auth v2 → v3 (#2380).

What changed between v2 and v3: LLDAP's HTTP server (the admin web UI
and the `/api/graphql` user-management API, `LLDAP_PORT`, default
17170) is now bound to the host **loopback only** via
`LLDAP_HTTP_HOST=127.0.0.1` on the lldap container. Under v2 no bind
address was set, so LLDAP used its `0.0.0.0` default — and because the
`auth` pod runs `hostNetwork: true` that meant every host interface.
LLDAP's admin surface therefore answered directly at
`http://<box-lan-ip>:{{LLDAP_PORT}}/`, bypassing nginx and with it
Authelia's forward-auth gate (admin group + two-factor).

This is the `hostNetwork` equivalent of the `hostIP: 127.0.0.1` port
publish radicale got in #2357: a `hostNetwork` pod publishes no ports,
so the bind address has to come from the app's own config.

The actual rebind is structural: `podman play kube` recreates the pod
from the v3 manifest, which carries the new env var. Nothing on disk
moves — LLDAP's `users.db` under the lldap data volume is untouched.

The existing `ldap.<domain>` NPM host is retargeted AUTOMATICALLY by
ServiceBay's core reconcile — this migration does NOT touch the proxy
itself (#2364). On every deploy the install runner runs
`ensureProxyHosts`, which walks the stack variables through
`buildProxyHosts`: LLDAP_SUBDOMAIN's `loopbackOnly: true` makes it emit
`forwardHost: 127.0.0.1`, and the proxy-hosts endpoint's existing-host
branch (`reconcileProxyHostUpstream` / `decideUpstreamReconcile`)
re-points the live host's forward target from the old LAN IP (now
closed) to `127.0.0.1:{{LLDAP_PORT}}`. That reconcile PUTs ONLY the
forward target, so exposure (internal), the Authelia forward-auth
advanced_config and the bound cert are untouched, and it is idempotent
(a no-op once the host is already loopback).

Everything that legitimately talks to LLDAP keeps working:
  - nginx runs on `hostNetwork`, so `127.0.0.1` IS the loopback LLDAP
    listens on.
  - ServiceBay's own container runs with host networking and its LLDAP
    client uses `http://localhost:{{LLDAP_PORT}}`.
  - `post-deploy.py` and this script run in the HOST netns (ADR 0007),
    so their localhost probes are unaffected.
  - Authelia binds LLDAP over the raw LDAP port on localhost, which
    this hop does not change.

NOT changed by this hop: the raw LDAP port (`LLDAP_LDAP_PORT`, default
3890) stays bound to every interface. Isolated (non-hostNetwork) pods
reach it through `host.containers.internal`, which rootless
podman/pasta maps to the host's LAN address rather than loopback, so a
loopback bind there would break radicale's `ldap_uri` and Jellyfin's
LDAP-Auth plugin. Restricting that port needs host-level packet
filtering and is tracked separately as #2388.

What this script does:
  - Inform the operator that the LLDAP web UI/API port is now
    loopback-bound, that `ldap.<domain>` is retargeted automatically by
    the core reconcile (no manual proxy edit), that no data moves, and
    that the raw LDAP port is unchanged (#2388).
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue;
    a non-zero exit aborts the deploy before the new yaml lands.

This script is intentionally read-only and idempotent — it just logs
guidance and returns.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 2
  - NEW_SCHEMA_VERSION = 3
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, LLDAP_PORT, LLDAP_LDAP_PORT, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    http_port = os.environ.get("LLDAP_PORT", "17170")
    ldap_port = os.environ.get("LLDAP_LDAP_PORT", "3890")
    print(f"Auth v2 → v3: LLDAP HTTP port {http_port} is now bound to 127.0.0.1 only (#2380).")
    print("  It is no longer served on 0.0.0.0, so the admin web UI and")
    print("  /api/graphql can't be hit directly on the LAN — access goes through")
    print("  the nginx reverse proxy at ldap.<domain>, which Authelia gates on")
    print("  the admins group + two-factor.")
    print("  ServiceBay retargets the existing ldap.<domain> proxy host to")
    print(f"  127.0.0.1:{http_port} automatically on this deploy (core reconcile,")
    print("  #2364) — no manual proxy edit; exposure, forward-auth config and the")
    print("  cert are preserved.")
    print(f"  The raw LDAP port {ldap_port} is UNCHANGED (still bound to every")
    print("  interface) — isolated pods reach it via host.containers.internal;")
    print("  restricting it needs host-level filtering, tracked as #2388.")
    print("  Nothing to move or transform on disk; LLDAP's users.db is untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
