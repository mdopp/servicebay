#!/usr/bin/env python3
"""claude-dev v3 → v4 (#2803): informational only — nothing on disk moves.

v4 adds a SECOND coding agent, pi, to the same container: the `pi` CLI on the
PATH of every SSH session, plus `pi-web-ui` as a second service on its own port,
published on the host's loopback and fronted by nginx + Authelia through
CLAUDE_DEV_PI_SUBDOMAIN. The Claude side is untouched — `start-claude`, the
running sessions and Remote Control all behave exactly as in v3. The /workspace
volume, the persisted SSH host keys, ~/.claude, the provisioned LDAP homes and
every checkout are where v3 left them; ownership and permissions do not change.

pi's own state (~/.pi and ~/.pi-web under /workspace) is created by the
container on first boot, so there is nothing to move here either.

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
    port = os.environ.get("CLAUDE_DEV_PI_PORT", "8791")
    sub = os.environ.get("CLAUDE_DEV_PI_SUBDOMAIN", "pi")
    group = os.environ.get("CLAUDE_DEV_LDAP_GROUP", "admins")
    model_url = os.environ.get(
        "CLAUDE_DEV_PI_MODEL_BASE_URL", "http://host.containers.internal:18080/v1"
    )

    log("claude-dev v3 -> v4: nothing to migrate — no data moves, no permissions change.")
    log("  /workspace, the SSH host keys, ~/.claude and every checkout are untouched.")
    log("  Your Claude sessions, start-claude and Remote Control are unchanged.")
    log("  What is new: a second coding agent, pi, in the same container.")
    log(f"  It is on the PATH of every SSH session, and its chat window is at")
    log(f"  https://{sub}.<your domain>, behind the same sign-in as the")
    log(f"  configuration page and open only to members of '{group}'.")
    log(f"  The chat listens on 127.0.0.1:{port} on this box, so the reverse proxy")
    log("  is the only way in; there is no second password in front of it.")
    log(f"  Its only model source is this box's own model server at {model_url} —")
    log("  no cloud account, no API key. If that server is not running when the")
    log("  container starts, pi's model picker will be empty until it is.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
