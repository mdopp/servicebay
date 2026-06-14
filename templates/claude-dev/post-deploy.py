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
    ldap_enabled = bool(env("LLDAP_ADMIN_PASSWORD"))
    ldap_group = env("CLAUDE_DEV_LDAP_GROUP", "admins")

    log(f"✅ Claude Dev container is up — SSH in on port {ssh_port}.")
    if ldap_enabled:
        log(f"   Primary login: your LLDAP account (e.g. mdopp), if you're in group '{ldap_group}':")
        log(f"     ssh -p {ssh_port} <your-ldap-user>@{host}     # password = your LLDAP password")
        log(f"   Break-glass:   local 'dev' account still works ({'SSH key' if has_key else 'password below'}):")
        log(f"     ssh -p {ssh_port} dev@{host}")
        log("   Each LDAP user gets a persistent home under /workspace/home/<user>.")
    else:
        auth_hint = "SSH key" if has_key else "the password below"
        log(f"   Log in as user 'dev' ({auth_hint}):  ssh -p {ssh_port} dev@{host}")
        log("   (LDAP login appears once the `auth` stack is installed and claude-dev is reinstalled.)")
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
