#!/usr/bin/env python3
"""
Migration: vaultwarden v1 → v2 (#408).

What changed between v1 and v2: the pod moved from Podman bridge
networking to `hostNetwork: true`, and Vaultwarden's Rocket server
now listens directly on `VAULTWARDEN_PORT` on the host instead of
behind a `hostPort:` shim. No data on disk moves — the volume mount
at `${DATA_DIR}/vaultwarden` is unchanged.

What this script does:
  - Inform the operator that the redeploy will rebind the port at
    the host level. Existing NPM proxy hosts continue to forward
    to `127.0.0.1:VAULTWARDEN_PORT` so the user-visible URL stays
    the same.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

This script is intentionally read-only — it just logs guidance.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 1
  - NEW_SCHEMA_VERSION = 2
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, VAULTWARDEN_PORT, …)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    port = os.environ.get("VAULTWARDEN_PORT", "8222")
    print(f"Vaultwarden v1 → v2: switching to hostNetwork (#408).")
    print(f"  Rocket will bind {port}/tcp directly on the host so SSO discovery")
    print(f"  reaches https://auth.<PUBLIC_DOMAIN>/.well-known/openid-configuration")
    print(f"  via the host's resolver (AdGuard rewrites). NPM proxy routes that")
    print(f"  forward to 127.0.0.1:{port} keep working unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
