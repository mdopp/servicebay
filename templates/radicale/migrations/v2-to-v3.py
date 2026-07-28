#!/usr/bin/env python3
"""
Migration: radicale v2 → v3 (#2411).

What changed between v2 and v3: the access-rights MODEL. Under v2 the
`[rights]` section of Radicale's config was the built-in
`type = owner_only` module — each authenticated user may touch their
own `/<user>/` tree and nothing else, with no way to express a single
exception. v3 switches to `type = from_file` with
`file = /config/rights`, and the pod's `write-config` initContainer
seeds that ruleset next to `/config/config` on every deploy.

The ruleset is deliberately owner_only-equivalent plus exactly two
named exceptions:

  [root]             any authenticated user  → read the root collection
                     (so /.well-known/{caldav,carddav} discovery works;
                     this is what owner_only itself returns for `/`)
  [owner]            any authenticated user  → RrWw on their OWN
                     `/<user>/` subtree, and nothing else
  [solaris-subcal]   user `solaris` only     → RrWw on
                     `<resident>/solaris` (shared calendar)
  [solaris-contacts] user `solaris` only     → RrWw on
                     `<resident>/solaris-contacts` (shared address book)

So a normal user's access is unchanged. The two `solaris` sections are
the only widening: a service account named `solaris` (if such an LLDAP
user exists at all) may read/write those two named collections under
any principal — not the principal root, not the resident's other
calendars or address books. On a box with no `solaris` LLDAP account
they grant nothing.

Why it had to move into the template: the `[solaris-subcal]` rule used
to be patched onto the RUNNING pod by hand. `/config` is an in-pod
emptyDir seeded by the initContainer, so every re-render — an
`AutoUpdate=registry` image pull re-running `podman kube play
--replace` — recreated it from the v2 manifest and silently reverted
the rights to `owner_only`. Carrying the ruleset in the manifest is
what makes it stick.

The switch is structural: `podman play kube` recreates the pod from
the v3 manifest, whose initContainer writes both `/config/config` (now
pointing `[rights]` at the file) and `/config/rights`. Nothing on disk
moves — Radicale's collections under `/data/collections` are untouched,
and no collection is created, renamed or deleted by this hop.

What this script does:
  - Inform the operator that the rights model changed, that normal
    users see no behaviour change, what the two `solaris` grants are,
    and that a hand-edited `/config/rights` on a running pod is from
    now on regenerated from the template on every deploy.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue;
    a non-zero exit aborts the deploy before the new yaml lands.

This script is intentionally read-only and idempotent — it just logs
guidance and returns.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 2
  - NEW_SCHEMA_VERSION = 3
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, RADICALE_SUBDOMAIN, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import sys


def main() -> int:
    print("Radicale v2 → v3: access rights move from the built-in `owner_only`")
    print("  module to `from_file` (/config/rights), seeded by the pod's")
    print("  write-config initContainer on every deploy (#2411).")
    print("  Normal users: NO change. [root] + [owner] reproduce owner_only —")
    print("  read on the root collection for discovery, full read/write on your")
    print("  own /<user>/ subtree, no access to anyone else's.")
    print("  Added: the `solaris` service account (only if such an LLDAP user")
    print("  exists) may read/write exactly `<resident>/solaris` and")
    print("  `<resident>/solaris-contacts` under any principal — the shared")
    print("  calendar and address book the household sync maintains. It still")
    print("  gets 403 on a resident's other collections and on the principal")
    print("  root.")
    print("  Why in the template: a hand-patched /config/rights lived in an")
    print("  in-pod emptyDir and was wiped on every re-render (image auto-update")
    print("  → podman kube play --replace), silently reverting to owner_only.")
    print("  If you hand-edited /config/rights, that copy is now regenerated")
    print("  from the template on each deploy — edit the template instead.")
    print("  No data is moved; Radicale's collections under /data are untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
