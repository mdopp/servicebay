#!/usr/bin/env python3
"""
post-deploy hook for the `nginx` stack (Nginx Proxy Manager).

What this replaces (was hardcoded in src/lib/stackInstall/credentialsManifest.ts):
  - NPM admin entry in the SAVE-THESE-NOW banner → __SB_CREDENTIAL__

What stays in the engine (intentionally):
  - bootstrapNpmAdmin in postInstall.ts handles NPM's special first-init
    quirk (the image ships with admin@example.com/changeme as fallback;
    INITIAL_ADMIN_EMAIL/PASSWORD env vars get applied a few seconds AFTER
    the API reports up). The function returns a tri-state result that
    drives a wizard-side credential-prompt UI when the auto-bootstrap
    fails, which a script can't cleanly express. So the NPM bootstrap
    + the cross-template proxy-route aggregation continue to live in
    runPostInstall — this script only owns the banner entry.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sqlite3
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


# SQLite header magic — the first 16 bytes of every valid sqlite3 file are
# "SQLite format 3\0". Checked before we touch the file so a half-written /
# corrupt / non-sqlite path is never opened-and-mutated. #1679.
SQLITE_HEADER = b"SQLite format 3\x00"


def ensure_sqlite_wal(db_path: str, label: str, busy_timeout_ms: int = 30000) -> bool:
    """Switch a SQLite DB to WAL journal mode (idempotent, host-side).

    Why (#1679): NPM (and Authelia) ship their SQLite DB in the default
    `journal_mode=delete` rollback journal, where a writer takes an EXCLUSIVE
    lock that blocks every concurrent reader. On this box's degraded 1-of-2
    RAID1, one slow-fsync write holds that lock past the short busy_timeout and
    concurrent admin-API calls fail `database is locked` (NPM POST /api/tokens
    → 500). WAL lets readers run concurrently with a single writer, so a slow
    write degrades latency, not correctness. NPM/knex doesn't expose a
    journal_mode knob, so we flip it on disk once after deploy — WAL is recorded
    in the DB header, so it persists and the app adopts it on its next open.
    Re-running is a no-op (already `wal`).

    Runs on the host (post-deploy runs as root on FCoS) against the bind-mounted
    DB file — no dependency on a `sqlite3` CLI in the container image. Fail-soft
    by contract: a missing file, an invalid sqlite header, or a transient lock
    is logged and skipped, never raised.

    Returns True iff the DB is in WAL mode after the call.
    """
    if not os.path.isfile(db_path):
        log(f"ℹ️ {label} SQLite DB not present yet at {db_path} — skipping WAL switch (will apply on next deploy).")
        return False

    try:
        with open(db_path, "rb") as fh:
            header = fh.read(16)
    except OSError as e:
        log(f"⚠️ Could not read {label} SQLite DB at {db_path} ({e}) — skipping WAL switch.")
        return False
    if header != SQLITE_HEADER:
        log(f"⚠️ {db_path} is not a valid SQLite database (bad header) — skipping {label} WAL switch.")
        return False

    try:
        conn = sqlite3.connect(db_path, timeout=10)
        try:
            conn.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)};")
            mode = conn.execute("PRAGMA journal_mode=WAL;").fetchone()
            current = (mode[0] if mode else "").lower()
        finally:
            conn.close()
    except sqlite3.Error as e:
        log(f"⚠️ Could not switch {label} SQLite DB to WAL ({e}) — leaving journal mode as-is; will retry on next deploy.")
        return False

    if current == "wal":
        log(f"✅ {label} SQLite DB is in WAL mode (busy_timeout {busy_timeout_ms}ms) — concurrent reads no longer block on the writer.")
        return True
    log(f"⚠️ {label} SQLite DB did not switch to WAL (journal_mode={current or 'unknown'}) — likely a live lock; will retry on next deploy.")
    return False


def npm_db_path() -> str:
    """Host path of NPM's SQLite DB. Must track the `npm-data` hostPath mount in
    template.yml (`{{DATA_DIR}}/nginx-proxy-manager/data` ← /data)."""
    base = env("DATA_DIR", "/mnt/data")
    return os.path.join(base, "nginx-proxy-manager", "data", "database.sqlite")


def main() -> int:
    host = env("HOST", "<server-ip>")
    admin_port = env("NGINX_ADMIN_PORT", "81")
    email = env("NGINX_ADMIN_EMAIL", "admin@servicebay.local")
    password = env("NGINX_ADMIN_PASSWORD")

    # ── NPM SQLite → WAL (#1679) ──────────────────────────────────────────
    # Runs regardless of whether a fresh admin password was generated — a
    # returning install (no new password) still needs the concurrency fix.
    ensure_sqlite_wal(npm_db_path(), "NPM")

    if not password:
        # No password generated — bootstrapNpmAdmin will skip too. Nothing
        # to put in the credential banner.
        return 0

    emit_credential(
        service="Nginx Proxy Manager",
        url=f"http://{host}:{admin_port}",
        username=email,
        password=password,
        importance="critical",
        notes="Reverse-proxy admin. Needed for SSL cert renewal + access lists.",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
