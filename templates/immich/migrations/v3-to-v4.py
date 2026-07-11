#!/usr/bin/env python3
"""
Migration: immich v3 → v4 — pgvecto.rs → VectorChord.

What changed between v3 and v4:
  - The database container image moves from the deprecated
    `docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0` to immich's own
    `ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0`.
    That image bundles VectorChord (`vchord`) + pgvector + pgvecto.rs and
    sets `shared_preload_libraries` internally, so the template no longer
    passes any postgres `args` (a partial override would drop the preload
    — the #410 trap).
  - immich-server gains `DB_VECTOR_EXTENSION=vectorchord`.

Why: immich v3 removed support for the pgvecto.rs extension. A pinned old
DB image + auto-updating `immich-server:release` drifted apart, and the
microservices worker crash-looped with "No vector extension found.
Available extensions: vchord, vector". On the new image, immich migrates
the existing pgvecto.rs `vectors` data to VectorChord automatically on
startup (reindex takes seconds-to-minutes by library size).

No on-disk data moves — pgdata keeps its path under `${DATA_DIR}/immich/`;
the same directory is read by the new image in place.

What this script does (idempotent — probe only, never mutates):
  - If the old pgvecto.rs `vectors` extension is present and VectorChord
    isn't yet in place, print a LOUD reminder to back up pgdata first
    (immich rewrites the vector column during the in-place migration).
  - Otherwise (fresh install, or already migrated) just inform.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

Do NOT downgrade immich below 1.133.0 after this migration.

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import subprocess
import sys


DB_CONTAINER = "immich-database"


def _psql(sql: str) -> str | None:
    """Run a scalar query in the immich DB; return stdout or None if the
    container/DB isn't reachable (fresh install — nothing to migrate)."""
    try:
        out = subprocess.run(
            ["podman", "exec", DB_CONTAINER, "psql", "-U", "postgres",
             "-d", "immich", "-tA", "-c", sql],
            capture_output=True, text=True, timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def main() -> int:
    data_dir = os.environ.get("DATA_DIR", "${DATA_DIR}")
    print("Immich v3 → v4: migrating the vector search backend "
          "pgvecto.rs → VectorChord.")
    print(f"  DB image → ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0")
    print("  immich-server gains DB_VECTOR_EXTENSION=vectorchord; immich migrates")
    print("  the existing `vectors` data to VectorChord on its next startup.")

    exts = _psql("SELECT string_agg(extname, ',') FROM pg_extension;")
    if exts is None:
        print("  Postgres not reachable yet (fresh install) — nothing to back up.")
    elif "vectors" in exts and "vchord" not in exts:
        print("")
        print("  ⚠  BACK UP FIRST. immich rewrites the vector column in place during")
        print(f"     the migration. Recommended before redeploy:")
        print(f"       podman exec {DB_CONTAINER} pg_dump -U postgres -Fc -d immich \\")
        print(f"         -f /var/lib/postgresql/data/immich-pre-vectorchord.dump")
        print(f"     then copy it off pgdata (e.g. to {data_dir}/immich/).")
        print("  The new DB image bundles pgvecto.rs too, so an old backup can still")
        print("  be restored if needed. Do NOT downgrade immich below 1.133.0 after.")
    else:
        print("  Already on VectorChord (or no legacy vectors data) — nothing to do.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
