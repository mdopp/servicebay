#!/usr/bin/env python3
"""beets v2 → v3 (#2584): informational only — nothing on disk moves.

v3 adds a second container to the pod (`coverage`) and publishes it on a
new host port, bound to 127.0.0.1. No data path changes, no ownership
changes, no config rewrite: the library database, /config and the music
tree are all exactly where v2 left them.

This script exists because the migration chain has to be unbroken — the
install runner refuses a deploy when a hop between the installed schema
version and the template's has no script (`selectMigrationChain`,
`lib/stackInstall/migrations.ts`). So the hop is spelled out here rather
than aborting an operator's redeploy over a change that needs no
migration at all.

Idempotent by construction: it only prints.
"""

from __future__ import annotations

import os
import sys


def log(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def main() -> int:
    port = os.environ.get("BEETS_COVERAGE_PORT", "8338")
    log("beets v2 → v3: nothing to migrate — no data moves, no permissions change.")
    log("  What changes: the 'Beets library populated' health check used to go")
    log("  green as soon as ONE item was in the library, so a 99%-untagged")
    log("  collection reported healthy. It now compares the library against the")
    log("  audio files under /music and is RED below a percentage floor")
    log("  (BEETS_COVERAGE_MIN_PERCENT, default 90%).")
    log(f"  A new container answers that question on 127.0.0.1:{port} — loopback")
    log("  only, not reachable from the LAN. If something else on this box already")
    log("  owns that port, set BEETS_COVERAGE_PORT in the wizard before deploying.")
    log("  Expect the check to go RED after this upgrade if your library really is")
    log("  behind. That is the fix working, not a new fault.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
