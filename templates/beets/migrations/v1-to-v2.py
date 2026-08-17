#!/usr/bin/env python3
"""
Migration: beets v1 → v2 (#2581).

v2 is the first version of this template that ships from the ServiceBay
repo. v1 was a hand-written local template that ran the container as
PUID/PGID 1000. Under rootless podman that maps to a *sub*-UID on the
host (subuid base + 999), so everything beets wrote into its /config bind
mount — `musiclibrary.db` above all — is owned by that sub-UID.

v2 runs the container as UID 0, which under rootless podman maps to the
host user running podman. That is the only way beets can write tags into
the `core`-owned music files (as v1 could not: it would have failed on
every single file, silently, if an import had ever been triggered). The
side effect is that the new container cannot write the OLD /config
contents until they are re-owned.

`podman unshare` runs a command inside the podman user namespace, where
the invoking user is UID 0 and the sub-UIDs are addressable — so a
`chown -R 0:0` in there hands the directory back to the host podman user
without any privilege on the host.

NOTHING IS MOVED OR DELETED. The library database, the config file and
the import state stay exactly where they are; only their owner changes.
The music library is not touched at all.

Idempotent: the ownership scan short-circuits when everything already
belongs to the invoking user (fresh install, or a re-run).

Exits 0 even when the chown fails — a permissions fixup is not the kind
of half-completed data migration that justifies aborting a deploy, and
the operator gets the exact manual command in the log.
"""

from __future__ import annotations

import os
import subprocess
import sys


def log(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def config_dir() -> str:
    data_dir = os.environ.get("OLD_DATA_DIR") or os.environ.get("DATA_DIR") or "/mnt/data"
    return os.path.join(data_dir, "beets", "config")


def foreign_owned_entries(root: str, wanted_uid: int) -> list[str]:
    """Paths under `root` (inclusive) not owned by `wanted_uid`."""
    out: list[str] = []
    try:
        if os.stat(root).st_uid != wanted_uid:
            out.append(root)
    except OSError:
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        for name in list(dirnames) + list(filenames):
            full = os.path.join(dirpath, name)
            try:
                if os.lstat(full).st_uid != wanted_uid:
                    out.append(full)
            except OSError:
                continue
    return out


def main() -> int:
    path = config_dir()
    if not os.path.isdir(path):
        log(f"v1→v2: no beets config directory at {path}; nothing to re-own.")
        return 0

    wanted = os.getuid()
    foreign = foreign_owned_entries(path, wanted)
    if not foreign:
        log(f"v1→v2: {path} is already owned by the podman user (uid {wanted}); nothing to do.")
        return 0

    log(f"v1→v2: {len(foreign)} entrie(s) under {path} are owned by a container")
    log("   sub-UID left behind by the previous PUID=1000 container (e.g.")
    log(f"   {os.path.basename(foreign[0])}). The v2 container runs as UID 0 —")
    log("   the host podman user — so it must own these to write the library")
    log("   database. Re-owning them now. No file is moved or deleted.")

    try:
        result = subprocess.run(
            ["podman", "unshare", "chown", "-R", "0:0", path],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        result = None
        log(f"   ⚠️ Could not run `podman unshare chown`: {exc}")

    if result is not None and result.returncode == 0:
        remaining = foreign_owned_entries(path, wanted)
        if not remaining:
            log(f"   ✅ {path} now belongs to the podman user.")
            return 0
        log(f"   ⚠️ {len(remaining)} entrie(s) still foreign-owned after the chown.")
    elif result is not None:
        stderr = (result.stderr or "").strip()
        log(f"   ⚠️ `podman unshare chown` exited {result.returncode}: {stderr}")

    log("   beets will start, but it may not be able to write its library")
    log("   database until this is fixed. Run it by hand on the box:")
    log(f"     podman unshare chown -R 0:0 {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
