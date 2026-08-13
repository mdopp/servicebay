#!/usr/bin/env python3
"""
Migration: claude-dev v1 → v2 (#2522).

What changed between v1 and v2: the pod dropped `hostNetwork: true` and now
runs in its own network namespace (ADR 0007 Decision 1). sshd's port is
published with an explicit `hostPort` on the SAME port number and with no
`hostIP`, so podman binds it on 0.0.0.0 — the reachability the hostNetwork
bind had. The operator's router port-forward, LAN `ssh -p <port> …@<box>`, and
the Claude Code mobile app connection are all unaffected, and the SSH host keys
persist on /workspace so `known_hosts` does not complain.

The LLDAP bind target moved from `localhost` to `host.containers.internal` —
the name podman writes into every container's /etc/hosts, and the only way an
isolated pod reaches an on-box sibling. The `LLDAP_HOST` variable was removed
(the value is a literal in the manifest now) because the install assembler
force-resolves LLDAP_HOST to "localhost" for every template, which is correct
for the hostNetwork `auth` pod that owns the variable but would silently
overwrite it here.

The rebind is structural: `podman play kube` recreates the pod from the v2
manifest. Nothing on disk moves — /workspace (git checkouts, ~/.claude history,
gh auth, per-user homes, host keys) is untouched.

What this script does:
  - Inform the operator that SSH reachability is unchanged and that nothing
    on disk moves.
  - Best-effort PREFLIGHT of the sibling precondition (ADR 0007 Decision 3,
    "siblings first, consumer second"): if LDAP login is configured, check
    that LLDAP's raw LDAP port is listening on something wider than the
    loopback, since an isolated pod can only reach it that way. `auth` binds
    it to 0.0.0.0 by design (its LAN half is closed by the `blockLanAccess`
    nftables rule, #2388), so this normally passes silently.
  - Exit 0 — ALWAYS. This is a warning, never an abort. Aborting would leave
    the operator unable to re-deploy their own dev box, and a broken LDAP path
    does not lock anyone out: the local `dev` break-glass account still works.
    Anything unexpected while probing is swallowed for the same reason.

This script is intentionally read-only and idempotent — it logs guidance and
returns.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 1
  - NEW_SCHEMA_VERSION = 2
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (CLAUDE_DEV_SSH_PORT, LLDAP_LDAP_PORT, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import subprocess
import sys


def _loopback_only(port: str) -> bool:
    """True only when we POSITIVELY see `port` listening on loopback alone.

    Unknown, unreadable or absent → False, so an unclear reading never
    produces a warning about a problem that may not exist.
    """
    try:
        out = subprocess.run(
            ["ss", "-H", "-ltn"],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except Exception:
        return False
    locals_ = []
    for line in out.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        addr = fields[3]
        host, _, listen_port = addr.rpartition(":")
        if listen_port == port:
            locals_.append(host.strip("[]"))
    if not locals_:
        return False
    return all(h in ("127.0.0.1", "::1") for h in locals_)


def main() -> int:
    ssh_port = os.environ.get("CLAUDE_DEV_SSH_PORT", "2222")
    ldap_port = os.environ.get("LLDAP_LDAP_PORT", "3890")
    ldap_configured = bool(os.environ.get("LLDAP_ADMIN_PASSWORD"))

    print("Claude Dev v1 → v2: the pod now runs in its own network namespace (#2522).")
    print(f"  SSH is UNCHANGED: port {ssh_port} is published on the host with an")
    print("  explicit hostPort and no hostIP, so it still answers on every")
    print("  interface. Your router port-forward, LAN ssh and the Claude Code")
    print("  mobile app connection all keep working exactly as before, and the")
    print("  SSH host keys persist on /workspace so known_hosts is unaffected.")
    print("  Nothing to move or transform on disk — /workspace (git checkouts,")
    print("  ~/.claude history, gh auth, per-user homes) is untouched.")

    if ldap_configured:
        print(f"  LDAP logins now bind ldap://host.containers.internal:{ldap_port}")
        print("  instead of localhost — an isolated pod cannot reach an on-box")
        print("  sibling on 127.0.0.1. LLDAP is bound wide by design and its LAN")
        print("  half is closed at the host firewall (blockLanAccess, #2388).")
        if _loopback_only(ldap_port):
            print("")
            print(f"  WARNING — LLDAP's LDAP port {ldap_port} appears to be listening on")
            print("  the LOOPBACK ONLY. An isolated pod cannot reach it there, so LDAP")
            print("  logins will fail after this deploy. Fix the SIBLING first: the")
            print("  `auth` stack must leave LLDAP_LDAP_HOST unset (0.0.0.0 bind) and")
            print("  keep `blockLanAccess: true` on LLDAP_LDAP_PORT — re-deploy `auth`,")
            print("  then re-deploy this service. The local `dev` break-glass account")
            print("  keeps working meanwhile, so you are not locked out.")
    else:
        print("  LDAP login is not configured on this box (LLDAP_ADMIN_PASSWORD is")
        print("  empty), so only the local `dev` account is affected — i.e. nothing.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
