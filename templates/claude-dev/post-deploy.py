#!/usr/bin/env python3
"""post-deploy hook for the `claude-dev` stack.

Surfaces the SSH login as a credential so the operator can attach the
Claude Code mobile app, and prints the one-time setup steps (clone a
repo into /workspace, start a session).

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sys


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def main() -> int:
    host = env("HOST", "<server-ip>")
    ssh_port = env("CLAUDE_DEV_SSH_PORT", "2222")
    ssh_password = env("CLAUDE_DEV_SSH_PASSWORD")
    has_key = bool(env("CLAUDE_DEV_SSH_AUTHORIZED_KEY"))

    auth_hint = "SSH key" if has_key else "the password below"
    log(f"✅ Claude Dev container is up — SSH in on port {ssh_port} as user 'dev' ({auth_hint}).")
    log(f"   Attach:  ssh -p {ssh_port} dev@{host}")
    log("   First session — clone a repo into the persistent volume and start Claude Code:")
    log("     git clone https://github.com/<you>/<repo> /workspace/<repo>")
    log("     cd /workspace/<repo> && claude")
    log("   /workspace persists across container restarts (git checkouts, ~/.claude history, gh auth).")
    log("   Point the Claude Code mobile app at the same SSH endpoint to drive sessions from a phone.")

    if ssh_password:
        emit_credential(
            service="Claude Dev (SSH)",
            url=f"ssh://dev@{host}:{ssh_port}",
            username="dev",
            password=ssh_password,
            importance="critical",
            notes="SSH into the containerised Claude Code dev box; point the Claude Code mobile app here. Key-based login is also enabled when CLAUDE_DEV_SSH_AUTHORIZED_KEY was set.",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
