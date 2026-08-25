#!/usr/bin/env python3
"""home-assistant v7 → v8 (#2573): informational only — this script moves nothing.

v8 moves the reverse-proxy trust list out of `configuration.yaml` and into
Home Assistant's own HTTP config store. That work is done by `post-deploy.py`,
which has to talk to a RUNNING Home Assistant over its websocket API — so it
cannot happen here: migrations run fail-fast *before* the new pod spec lands,
with no HA to talk to. `post-deploy.py` also owns the one-shot backup to
`configuration.yaml.pre-http-migration.bak` and only removes the `http:` block
after HA's store is confirmed to carry the trust list.

This script exists because the migration chain has to be unbroken — the
install runner refuses a deploy when a hop between the installed schema
version and the template's has no script (`selectMigrationChain`,
`lib/stackInstall/migrations.ts`). Without it, every box still recorded at
v7 aborts its `home-assistant` redeploy at the migration check (#2601): the
run stops before `deployItem`, nothing is rolled out, and the abort was easy
to miss. So the hop is spelled out here rather than blocking an upgrade that
needs no on-disk migration at all.

Idempotent by construction: it only prints.
"""

from __future__ import annotations

import sys


def log(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def main() -> int:
    log("home-assistant v7 → v8: nothing to migrate here — no data moves.")
    log("  What changes: the reverse-proxy trust list (use_x_forwarded_for +")
    log("  trusted_proxies) moves from configuration.yaml into Home Assistant's")
    log("  own HTTP config store, which HA 2026.8 made the only place it reads.")
    log("  The deploy step that follows does that over HA's websocket API and")
    log("  promotes the result, then removes the now-ignored http: block —")
    log("  never before the store is confirmed to carry the trust list, and only")
    log("  after backing the whole file up to")
    log("  configuration.yaml.pre-http-migration.bak.")
    log("  If it cannot reach HA's config API it says so and changes nothing;")
    log("  set it under Settings → System → Network → HTTP server.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
