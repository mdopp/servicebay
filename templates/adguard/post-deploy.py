#!/usr/bin/env python3
"""
post-deploy hook for the `adguard` stack.

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts):
  - logAdguardCredentials  → `__SB_CREDENTIAL__` for AdGuard admin

AdGuard's first-start config is pre-seeded by the wizard's mustache step
(AdGuardHome.yaml.mustache lives in this directory). The bcrypt password
hash is computed server-side via /api/system/keys/bcrypt and baked into
that config. So this script has nothing to seed — it just surfaces the
credential the operator needs for their first login.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sys


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def main() -> int:
    host = env("HOST", "<server-ip>")
    user = env("ADGUARD_ADMIN_USER", "admin")
    password = env("ADGUARD_ADMIN_PASSWORD")
    port = env("ADGUARD_ADMIN_PORT", "8083")

    if not password:
        log("⚠️ ADGUARD_ADMIN_PASSWORD missing — first-login won't work; reset via the AdGuard Home setup wizard at http://<server-ip>:" + port)
        return 0

    log(f"✅ AdGuard admin saved (user: {user}) — open http://{host}:{port}. Password retrievable from Settings → Integrations → Saved credentials.")
    emit_credential(
        service="AdGuard Home",
        url=f"http://{host}:{port}",
        username=user,
        password=password,
        importance="critical",
        notes="DNS console. Add custom rewrites + manage blocklists.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
