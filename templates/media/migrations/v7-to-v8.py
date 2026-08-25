#!/usr/bin/env python3
"""media v7 → v8 (#2580): informational only — nothing on disk moves.

v8 hands the NVIDIA card to Jellyfin for video conversion. What changes
is the unit shape (a `.container` unit carrying `AddDevice=nvidia.com/gpu=all`
instead of a pod spec) and Jellyfin's own transcoding option, both applied
idempotently by `post-deploy.py`. The Jellyfin database, cache and library
stay exactly where v7 left them — the new unit binds the same three
directories the pod did. No data path changes, no ownership changes, no
config file is rewritten by this hop.

This script exists because the migration chain has to be unbroken — the
install runner refuses a deploy when a hop between the installed schema
version and the template's has no script (`selectMigrationChain`,
`lib/stackInstall/migrations.ts`). Without it, every box still recorded at
v7 aborts its `media` redeploy at the migration check (#2601): the run
stops before `deployItem`, nothing is rolled out, and the abort was easy
to miss. So the hop is spelled out here rather than blocking an upgrade
over a change that needs no migration at all.

Idempotent by construction: it only prints.
"""

from __future__ import annotations

import os
import sys


def log(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def main() -> int:
    gpu = os.environ.get("JELLYFIN_GPU_PASSTHROUGH", "").strip()
    log("media v7 → v8: nothing to migrate — no data moves, no permissions change.")
    log("  Your Jellyfin database, cache and library stay where they are; the new")
    log("  unit binds the same directories the pod did.")
    if gpu:
        log("  What changes: Jellyfin is handed the NVIDIA card and switched to NVENC,")
        log("  so a film that needs converting runs on the card instead of the")
        log("  processor. On a box with no card, nothing changes at all.")
    else:
        log("  JELLYFIN_GPU_PASSTHROUGH is blank, so video conversion stays in")
        log("  software exactly as it was on v7.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
