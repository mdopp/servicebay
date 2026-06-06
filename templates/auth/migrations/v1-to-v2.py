#!/usr/bin/env python3
"""
Migration: auth v1 → v2 (#1737 LLDAP-readiness gate, #1742 redirect).

What changed between v1 and v2: nothing on disk. The v1→v2 hop is
config/pod-only — both changes re-render from the template on every
deploy, so there is no data to move or transform:

  - #1737: the Authelia container now waits for LLDAP's LDAP socket to
    be reachable before exec'ing Authelia (a bounded `nc -w` connect
    loop in template.yml), eliminating the fatal LLDAP-startup-race
    crash on pod restarts. Pure pod-spec change.
  - #1742: a per-cookie `default_redirection_url` was added to the
    Authelia session config (configuration.yml.mustache) so a
    portal-direct login lands on the www landing page. Pure config
    change, rendered from the mustache template.

What this script does:
  - Documents the hop for the operator (no on-disk state is touched).
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue;
    a non-zero exit aborts the deploy before the new yaml lands.

This script is intentionally read-only and idempotent — it just logs
guidance and returns. The schema-version bump exists so the migration
chain is complete (the install runner refuses to deploy a v2 template
with no v1→v2 script); there is no data migration to perform because
both v2 changes re-render from template.yml / configuration.yml.mustache
on every deploy.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 1
  - NEW_SCHEMA_VERSION = 2
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, AUTHELIA_PORT, LLDAP_PORT, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import sys


def main() -> int:
    print("Auth v1 → v2: config/pod-only hop, no on-disk data migration.")
    print("  #1737: Authelia now waits for LLDAP's LDAP socket before starting")
    print("         (bounded nc -w connect loop in template.yml) — re-rendered")
    print("         from the template on every deploy.")
    print("  #1742: per-cookie default_redirection_url added to the Authelia")
    print("         session config (configuration.yml.mustache) — re-rendered")
    print("         from the mustache template on every deploy.")
    print("  Nothing to move or transform on disk; proceeding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
