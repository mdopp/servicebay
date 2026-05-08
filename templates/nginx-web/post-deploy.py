#!/usr/bin/env python3
"""
post-deploy hook for the `nginx-web` stack (Nginx Proxy Manager).

What this replaces (was hardcoded in src/lib/stackInstall/credentialsManifest.ts):
  - NPM admin entry in the SAVE-THESE-NOW banner → __SB_CREDENTIAL__

What stays in the engine (intentionally):
  - bootstrapNpmAdmin in postInstall.ts handles NPM's special first-init
    quirk (the image ships with admin@example.com/changeme as fallback;
    INITIAL_ADMIN_EMAIL/PASSWORD env vars get applied a few seconds AFTER
    the API reports up). The function returns a tri-state result that
    drives a wizard-side credential-prompt UI when the auto-bootstrap
    fails, which a script can't cleanly express. So the NPM bootstrap
    + the cross-template proxy-route aggregation continue to live in
    runPostInstall — this script only owns the banner entry.

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


def main() -> int:
    host = env("HOST", "<server-ip>")
    admin_port = env("NGINX_ADMIN_PORT", "81")
    email = env("NGINX_ADMIN_EMAIL", "admin@servicebay.local")
    password = env("NGINX_ADMIN_PASSWORD")

    if not password:
        # No password generated — bootstrapNpmAdmin will skip too. Nothing
        # to put in the credential banner.
        return 0

    emit_credential(
        service="Nginx Proxy Manager",
        url=f"http://{host}:{admin_port}",
        username=email,
        password=password,
        importance="critical",
        notes="Reverse-proxy admin. Needed for SSL cert renewal + access lists.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
