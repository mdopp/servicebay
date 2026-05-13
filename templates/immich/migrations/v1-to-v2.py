#!/usr/bin/env python3
"""
Migration: immich v1 → v2 (#410).

What changed between v1 and v2:
  - The pod moved from Podman bridge networking to `hostNetwork: true`
    so OIDC discovery against `https://auth.<PUBLIC_DOMAIN>` works.
  - Three new wizard variables: IMMICH_ADMIN_NAME / IMMICH_ADMIN_EMAIL
    / IMMICH_ADMIN_PASSWORD seed the initial admin user.
  - A new IMMICH_SSO_SECRET pins the OIDC client secret so Authelia
    and Immich share the same value.
  - A new post-deploy.py runs admin sign-up + system-config OAuth wiring.

No on-disk data moves — the upload, model-cache, and pgdata volumes
keep their paths under `${DATA_DIR}/immich/`.

What this script does:
  - Inform the operator that the redeploy will rebind IMMICH_PORT at
    the host level (no NPM proxy changes needed).
  - If they had run v1 and already created an Immich admin via the
    first-run sign-up screen, flag that the new post-deploy will see
    a 400 on its idempotent re-seed and skip — no data loss.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    port = os.environ.get("IMMICH_PORT", "2283")
    print("Immich v1 → v2: switching to hostNetwork + adding admin/OIDC auto-config (#410).")
    print(f"  immich-server will bind {port}/tcp directly on the host so OIDC discovery")
    print("  against auth.<PUBLIC_DOMAIN> reaches Authelia via AdGuard rewrites.")
    print("  Redis + postgres sidecars are pinned to 127.0.0.1 so they stay off the LAN.")
    print("  If you already created an admin via Immich's first-run screen, the new")
    print("  post-deploy.py will see a 400 on its idempotent re-seed and leave that")
    print("  account untouched — no data loss.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
