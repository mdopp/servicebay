#!/usr/bin/env python3
"""claude-dev v2 → v3 (#2678): informational only — nothing on disk moves.

v3 adds the container's own configuration UI: a second published port, bound
to the host's 127.0.0.1, and a new proxy host in front of it. The /workspace
volume, the persisted SSH host keys, ~/.claude, the provisioned LDAP homes and
every checkout are exactly where v2 left them. Ownership and permissions are
untouched.

This script exists because the migration chain has to be unbroken — the install
runner refuses a deploy when a hop between the installed schema version and the
template's has no script (`selectMigrationChain`,
`lib/stackInstall/migrations.ts`). Spelling the hop out here beats aborting an
operator's redeploy over a change that needs no migration at all.

It must also never fail the deploy: a non-zero exit would leave the operator
unable to re-deploy their own dev box, and nothing here can go wrong.

Idempotent by construction: it only prints.
"""

from __future__ import annotations

import os
import sys


def log(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def main() -> int:
    port = os.environ.get("CLAUDE_DEV_CONFIG_PORT", "8790")
    sub = os.environ.get("CLAUDE_DEV_CONFIG_SUBDOMAIN", "claude")
    group = os.environ.get("CLAUDE_DEV_LDAP_GROUP", "admins")

    log("claude-dev v2 -> v3: nothing to migrate — no data moves, no permissions change.")
    log("  /workspace, the SSH host keys, ~/.claude and every checkout are untouched.")
    log("  Your SSH access does not change.")
    log("  What is new: the container serves its own configuration page at")
    log(f"  https://{sub}.<your domain>. This first version is the shell only —")
    log("  the pages go in one at a time and appear in the sidebar as they land.")
    log(f"  It listens on 127.0.0.1:{port} on this box, so the reverse proxy is the")
    log("  only way in, and it accepts only signed-in members of the")
    log(f"  '{group}' group — the same people who may SSH in.")
    log("  It reuses the read-only ServiceBay token this container already has;")
    log("  no new credential is created.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
