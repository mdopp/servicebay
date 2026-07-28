#!/usr/bin/env python3
"""
Migration: auth v3 → v4 (#2417).

What changed between v3 and v4
------------------------------
Authelia's `servicebay` OIDC client — the one guarding ServiceBay's own
admin panel behind the "Login with Authelia" button — used to ship a
**hardcoded** `client_secret` baked into
`templates/auth/configuration.yml.mustache`. Every ServiceBay install in
the world therefore shared one secret that anybody could read out of the
public repository.

From v4 that secret is a per-install `type: "secret"` variable
(`SERVICEBAY_OIDC_SECRET`), generated once per box by the wizard, stored
encrypted in `config.installedSecrets`, and reused verbatim on every
later deploy — exactly like `HA_OIDC_SECRET`, `IMMICH_SSO_SECRET` and
`VAULTWARDEN_SSO_SECRET` already were.

How the rotation happens (this script does NOT perform it)
----------------------------------------------------------
The rotation is structural, and deliberately lives in ServiceBay's
install path rather than here, because it spans two stores that a
Python script on the box cannot write atomically:

  1. `mergeAutheliaOidcClients` preserves every *incrementally registered*
     client's secret across an auth redeploy, and never rotates one — the
     #1559 invariant. `servicebay` is the ONE deliberate exception: that
     client is declared by this template's mustache, so the fresh render
     owns it and the newly generated value replaces the old literal in
     `configuration.yml`.
  2. After that file has actually landed on disk and the pod has come
     back, ServiceBay READS the `servicebay` client's secret back out of
     it and copies it into its own `config.oidc.clientSecret` — the value
     the admin panel posts to Authelia's token endpoint.

The direction matters. ServiceBay follows the file; it never leads it.
So ServiceBay cannot end up holding a secret Authelia has never seen —
the mismatch that produces a dead login button. And because the copy
happens only after a *successful* write, a deploy that fails earlier
leaves the old, still-consistent pair in place: a failed deploy is a
no-op, not a half-migration.

If the process dies in the narrow window between the two (config written,
copy not yet done), the result is a recoverable mismatch, never a
lockout:

  - The `/login` page also renders a **local admin username/password**
    form (`/api/auth/login`) that has nothing to do with OIDC. That is
    the break-glass door, and ServiceBay refuses to start this rotation
    at all on a box that does not have one (it aborts the deploy before
    writing anything).
  - The copy is idempotent and re-runs on every `auth` deploy, so simply
    redeploying `auth` converges the two sides again. Nothing about the
    mismatch is sticky.

What this script does
---------------------
It transforms nothing — there is nothing on disk to move, and doing the
rotation here would be the unsafe ordering (ServiceBay's copy would lead
the file instead of following it). It exists to tell the operator, at the
moment it matters, what is about to change and how to recover, and it
exits 0 so the deploy continues.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 3
  - NEW_SCHEMA_VERSION = 4
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, AUTHELIA_SUBDOMAIN, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

NOTE: this script never prints, reads or handles the secret value itself.

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    domain = os.environ.get("PUBLIC_DOMAIN", "<your-domain>")
    print("Auth v3 → v4: rotating the `servicebay` Authelia OIDC client secret (#2417).")
    print("  Until now that secret was a constant committed to the ServiceBay")
    print("  repository — identical on every install. This deploy replaces it")
    print("  with a value generated for this box alone.")
    print("  Both sides are updated by this deploy: Authelia's configuration.yml")
    print("  gets the new client_secret, and ServiceBay then copies that same")
    print("  value into its own config.oidc.clientSecret. Nothing moves on disk;")
    print("  Authelia's db.sqlite3 and LLDAP's users.db are untouched.")
    print("  Other services' SSO is unaffected — only the `servicebay` client")
    print("  rotates; immich/vaultwarden/home-assistant keep their own secrets.")
    print("  IF \"Login with Authelia\" on the admin panel fails after this deploy:")
    print(f"    1. Log in at https://admin.{domain}/login with the LOCAL admin")
    print("       username + password (the form below the SSO button). It does not")
    print("       use OIDC and is unaffected by this change.")
    print("    2. Re-deploy `auth`. The copy step is idempotent and re-syncs the")
    print("       two sides on every run.")
    print("  Existing browser sessions stay valid; only NEW SSO logins use the")
    print("  new secret. Users of other services do not need to log in again.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
