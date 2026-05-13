#!/usr/bin/env python3
"""
Migration: media v1 → v2 (#413).

Navidrome switches from reverse-proxy-auth (`Remote-User` header,
never actually wired up) to OIDC against Authelia. No on-disk data
moves — `${DATA_DIR}/media/navidrome` keeps its layout.

What this script does:
  - Inform the operator about the auth flip. Subsonic API clients
    (mobile apps) keep using the local admin account because Subsonic
    doesn't speak OIDC.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    enabled = os.environ.get("NAVIDROME_OIDC_ENABLED", "true") == "true"
    print("Media v1 → v2: Navidrome switching auth mode (#413).")
    if enabled:
        print("  Navidrome login screen will now offer 'Sign in with Authelia'.")
        print("  LLDAP users land in Navidrome on first sign-in (autoregister).")
    else:
        print("  NAVIDROME_OIDC_ENABLED is false — keeping local-account login.")
    print("  Subsonic API mobile clients (Symfonium etc.) continue to use the")
    print("  Navidrome admin account because Subsonic doesn't speak OIDC.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
