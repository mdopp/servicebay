#!/usr/bin/env python3
"""
post-deploy hook for the `honcho` template (#1004).

Two responsibilities:

  1. **Probe /health** until Honcho's FastAPI listener answers 200.
     The kube unit's pgvector container takes a few seconds to
     initialise the database on first boot, so polling the health
     endpoint before declaring success is friendlier than letting
     the operator wonder why hermes' post-deploy didn't pick it up
     on the very next deploy.

  2. **Surface HONCHO_API_KEY** as a __SB_CREDENTIAL__ marker so an
     operator who installs Honcho outside the family stack can paste
     the token into a custom Hermes deployment. When Honcho is part
     of the household stack, `templates/hermes/post-deploy.py` reads
     the same key from the wizard variables and wires it into
     hermes/config.yaml directly — no copy-paste needed.

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol.
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Pod-container name. Podman names a Pod's containers `<pod>-<container>`;
# this pod is `honcho`, the Postgres container is `honcho-postgres`.
PG_CONTAINER = "honcho-postgres"
# Postgres superuser role — the pod sets POSTGRES_USER=honcho, so `honcho`
# IS the superuser (the default `postgres` role does not exist).
PG_ROLE = "honcho"


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def jlog(level: str, tag: str, message: str, **args: object) -> None:
    sys.stdout.write(
        json.dumps(
            {
                "ts": datetime.datetime.now().astimezone().isoformat(),
                "level": level,
                "tag": tag,
                "message": message,
                "args": args,
            }
        )
        + "\n"
    )
    sys.stdout.flush()


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def _health_timeout() -> int:
    return int(os.environ.get("HONCHO_HEALTH_TIMEOUT", "120"))


def wait_for_honcho(port: str, deadline_secs: int | None = None) -> bool:
    """Poll http://127.0.0.1:<port>/health until it answers 2xx. Returns
    True when reachable, False when the deadline passes. Best-effort —
    hermes' post-deploy re-probes the same endpoint, so a missed window
    here is non-fatal; the only consequence is a delay before hermes
    flips memory.provider from holographic to honcho."""
    if deadline_secs is None:
        deadline_secs = _health_timeout()
    if deadline_secs <= 0:
        return False
    deadline = time.time() + deadline_secs
    last_status = 0
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/health")
            with urllib.request.urlopen(req, timeout=5) as resp:
                last_status = resp.status
                if 200 <= resp.status < 300:
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            pass
        time.sleep(3)
    jlog("warn", "honcho:health", "/health not 200 within deadline", last_status=last_status, deadline_secs=deadline_secs)
    return False


def _pgdata_preserved() -> bool:
    """True when a preserved Postgres data dir is on disk (a `PG_VERSION`
    marker exists). On a fresh install the pgvector image initialises the
    cluster from POSTGRES_PASSWORD on first boot, so the DB password already
    matches this install's HONCHO_POSTGRES_PASSWORD — no rekey needed. Only a
    *preserved* pgdata carries the OLD password and needs reconciliation."""
    data_dir = env("DATA_DIR", "/mnt/data/stacks")
    marker = os.path.join(data_dir, "honcho", "pgdata", "PG_VERSION")
    return os.path.isfile(marker)


def _pg_ready(deadline_secs: int = 60) -> bool:
    """Poll `pg_isready` inside the container until Postgres accepts local
    socket connections. The Postgres container comes up regardless of any
    password mismatch (POSTGRES_PASSWORD is consulted only on first cluster
    init), so this returns True even while the honcho app is crash-looping on
    the stale password — which is exactly the window we rekey in."""
    deadline = time.time() + deadline_secs
    while time.time() < deadline:
        try:
            result = subprocess.run(
                ["podman", "exec", PG_CONTAINER, "pg_isready", "-U", PG_ROLE, "-q"],
                capture_output=True, text=True, check=False, timeout=10,
            )
            if result.returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            pass
        time.sleep(2)
    return False


def rekey_postgres_password(new_password: str) -> bool:
    """Re-key the preserved Postgres role password to match this install's
    freshly-generated HONCHO_POSTGRES_PASSWORD.

    Why this exists (#2165): HONCHO_POSTGRES_PASSWORD is generated fresh on
    every install, but the pgvector image only seeds POSTGRES_PASSWORD into the
    cluster on FIRST init. On a reinstall over preserved pgdata the DB keeps the
    OLD password while both containers (honcho app + honcho-postgres) are handed
    the NEW one via env → the app's `postgresql+psycopg://honcho:<new>@…`
    connection is rejected and Honcho crash-loops. Same class as the LLDAP
    FORCE_RESET admin re-sync and the NPM/Immich in-place DB rekey.

    We hold the fix: `podman exec` reaches Postgres over its local unix socket,
    which the image trusts (`local all all trust`), so we can `ALTER ROLE` even
    though no TCP client can authenticate. Rekeying the role password loses no
    data — it is an access credential, not an encryption key; every honcho
    table is owned by the role, not the password. The password rides in via a
    psql variable (:'pw') so psql does the literal quoting — injection-safe
    whatever bytes the secret contains, and the value never lands on the host
    process table or in the SQL string.

    Idempotent: re-running sets the role password to the same value. Returns
    True iff the ALTER ROLE succeeded."""
    cmd = [
        "podman", "exec", "-i", PG_CONTAINER,
        "psql", "-U", PG_ROLE, "-d", "postgres", "-tAq",
        "-v", f"pw={new_password}",
    ]
    try:
        result = subprocess.run(
            cmd,
            input="ALTER ROLE honcho WITH PASSWORD :'pw';",
            capture_output=True, text=True, check=False, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        jlog("warn", "honcho:rekey", "psql exec failed — honcho may crash-loop on the stale password", error=str(exc))
        return False
    if result.returncode != 0:
        jlog("warn", "honcho:rekey", "ALTER ROLE failed — honcho may crash-loop on the stale password", stderr=(result.stderr or "").strip())
        return False
    return True


def reconcile_postgres_password() -> None:
    """On a reinstall over preserved pgdata, re-sync the Postgres role password
    to this install's HONCHO_POSTGRES_PASSWORD so the honcho app can connect.
    No-op on a fresh install (pgdata seeds from env on first boot)."""
    new_password = env("HONCHO_POSTGRES_PASSWORD")
    if not new_password:
        return  # nothing to reconcile against (shouldn't happen — auto-generated)
    if not _pgdata_preserved():
        jlog("info", "honcho:rekey", "Fresh pgdata — Postgres seeds the password from env; no rekey needed")
        return
    if not _pg_ready():
        jlog("warn", "honcho:rekey", "Postgres socket not ready within deadline — skipping rekey; honcho may crash-loop on the stale password until the next deploy")
        return
    if rekey_postgres_password(new_password):
        jlog("info", "honcho:rekey", "Preserved pgdata detected — re-keyed the Postgres role password to this install's HONCHO_POSTGRES_PASSWORD (existing data preserved)")
        # Bounce the app so it reconnects with the now-matching password
        # instead of waiting out its own restart backoff.
        try:
            subprocess.run(
                ["podman", "container", "restart", "honcho"],
                capture_output=True, text=True, check=False, timeout=60,
            )
        except (OSError, subprocess.SubprocessError):
            pass


def main() -> int:
    api_port = env("HONCHO_PORT", "8652")
    api_key = env("HONCHO_API_KEY")
    host = env("HOST", "<server-ip>")

    # Reconcile the Postgres role password before probing health — on a
    # reinstall over preserved pgdata the app can't connect until the DB
    # password matches this install's HONCHO_POSTGRES_PASSWORD (#2165).
    reconcile_postgres_password()

    ready = wait_for_honcho(api_port)
    if ready:
        jlog("info", "honcho:health", "Honcho is reachable", port=api_port)
    else:
        jlog("warn", "honcho:health", "Honcho health did not come up in time — hermes will retry on its next deploy/restart", port=api_port)

    if api_key:
        emit_credential(
            service="Honcho (Per-User Memory)",
            url=f"http://{host}:{api_port}",
            username="(bearer token)",
            password=api_key,
            importance="optional",
            notes="Bearer token clients (Hermes' memory plugin, or your own scripts) send as `Authorization: Bearer <key>`. When the household stack deploys hermes alongside honcho, hermes' post-deploy reads this value automatically — copy-paste only needed for external clients.",
        )

    print(f"✅ Honcho is configured: port={api_port}, ready={ready}.")
    print(f"   Hermes' memory plugin will reach Honcho at http://127.0.0.1:{api_port} on its next deploy/restart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
