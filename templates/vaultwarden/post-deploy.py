#!/usr/bin/env python3
"""
post-deploy hook for the `vaultwarden` stack.

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts and
src/lib/stackInstall/credentialsManifest.ts):
  - logOidcClientSecrets vaultwarden branch → informational log line
    about the SSO_ENABLED state.
  - credentialsManifest.ts vaultwarden branch that mutated the generic
    OIDC entry's `notes` field based on VAULTWARDEN_SSO_ENABLED.

The OIDC `__SB_CREDENTIAL__` entry itself is still emitted by the
variable-driven loop in credentialsManifest.ts (it walks every
variables[].meta.oidcClient with a clientSecretVar). That loop is
template-agnostic, so we keep using it. The Vaultwarden-specific bit
was always just the SSO_ENABLED-dependent note text — that lives here
now as an install-log line, which is the moment when the operator is
actually paying attention.

Vaultwarden's OIDC secret is wired into the container env via
SSO_CLIENT_SECRET — there's nothing to paste into a UI. The credential
entry exists for disaster recovery only.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import os
import sys


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def main() -> int:
    secret = env("VAULTWARDEN_SSO_SECRET")
    enabled = env("VAULTWARDEN_SSO_ENABLED") == "true"
    domain = env("PUBLIC_DOMAIN")

    if not secret:
        # No OIDC secret generated — nothing to surface.
        return 0

    if enabled:
        log(
            "Vaultwarden SSO is ENABLED via env (SSO_CLIENT_SECRET is wired in). "
            "Family members log in via Authelia with the household password."
        )
    else:
        log(
            "Vaultwarden SSO is DISABLED. Family members will use local "
            "Vaultwarden accounts. To re-enable: set VAULTWARDEN_SSO_ENABLED=true "
            "in the wizard and redeploy."
        )

    if domain:
        log(
            f"   OIDC issuer: https://auth.{domain} — "
            f"client_id: vaultwarden — secret saved in the credentials banner."
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
