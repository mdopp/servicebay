#!/usr/bin/env python3
"""
Migration: media v5 → v6 (#1730 + #1731).

Two fixes shipped together (both in templates/media/):

  #1730 — finish the Audiobookshelf retirement #1725 left half-done.
  #1731 — stop the jellyfin /media mount recursively relabelling the
          shared file-share/data tree.

### #1730 — tear down the orphaned Audiobookshelf container

#1725 dropped the `audiobookshelf` container from the pod but left the
already-running `media-audiobookshelf` container alive on the host (a
plain `kube play --replace` of the new pod doesn't remove a container
that's no longer *in* the pod). It kept holding host ports 8096/13378
and `books.<domain>` kept hitting it, bypassing Jellyfin. v6 also
repoints `books.<domain>` → Jellyfin and drops the `audiobookshelf`
OIDC client (variables.json), so the lingering container must go.

This script removes the orphaned `media-audiobookshelf` container if it
exists. It is **NON-DESTRUCTIVE to data**: the on-disk ABS data dirs
(`${DATA_DIR}/media/audiobookshelf-config`, `-metadata`, and the
audiobooks/podcasts library paths under file-share/data) are left
exactly where they are. Only the container (a disposable runtime
object) is torn down. Idempotent: a no-op if the container is already
gone (fresh install, or a re-run of this migration).

### #1731 — no code action here, template.yml carries the fix

The SELinux relabel fix is the `io.podman.annotations.label/jellyfin:
"disable"` annotation in template.yml (the jellyfin /media mount no
longer recursively `lsetxattr`s the shared multi-writer tree). Nothing
to migrate on disk — this note just records why v6 is the schema bump.

Exit 0 (migrations MUST exit 0 to let the deploy continue — the
container teardown is best-effort and never blocks the new pod).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ABS_CONTAINER = "media-audiobookshelf"


def container_exists(name: str) -> bool:
    """True if a container with this exact name exists (running or stopped)."""
    try:
        result = subprocess.run(
            ["podman", "container", "exists", name],
            capture_output=True,
            timeout=30,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"   (note) Could not probe for {name}: {exc}. Skipping teardown.")
        return False


def teardown_abs_container() -> None:
    """Remove the orphaned media-audiobookshelf container (data left intact)."""
    if not container_exists(ABS_CONTAINER):
        print(f"   No `{ABS_CONTAINER}` container present — nothing to tear down.")
        return

    print(f"   Found orphaned `{ABS_CONTAINER}` container (left running by")
    print("   #1725, which only stopped shipping ABS in the pod). Removing it")
    print("   so `books.<domain>` → Jellyfin takes effect and the dead port")
    print("   13378 is freed. Its on-disk data is preserved.")
    try:
        subprocess.run(
            ["podman", "rm", "-f", "-t", "10", ABS_CONTAINER],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        print(f"   ✅ Removed `{ABS_CONTAINER}`.")
    except subprocess.CalledProcessError as exc:
        # Best-effort: don't fail the deploy. Orphan-reconcile (#1668) and
        # the operator can still clear it; the new pod deploys regardless.
        print(f"   ⚠️ Could not remove `{ABS_CONTAINER}` ({exc.stderr.strip() if exc.stderr else exc}); "
              "the new media pod still deploys. Remove it by hand with "
              f"`podman rm -f {ABS_CONTAINER}` if it lingers.")
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"   ⚠️ podman rm failed unexpectedly ({exc}); the new media pod "
              "still deploys.")


def main() -> int:
    print("Media v5 → v6: finishing Audiobookshelf retirement (#1730) +")
    print("fixing the shared-tree SELinux relabel crash (#1731).")
    print()
    print("#1730 — books.<domain> now serves Jellyfin (was the dead ABS port")
    print("13378), the `audiobookshelf` OIDC client is dropped, and the stale")
    print("ABS container is torn down. Audiobooks live in Jellyfin's")
    print("/media/audiobooks library under the LLDAP house login.")
    print()
    print("#1731 — Jellyfin's /media mount no longer recursively relabels the")
    print("shared file-share/data tree, so a root-owned stray (e.g. from")
    print("disk-import) can no longer crash-loop the media stack on restart.")
    print()

    teardown_abs_container()

    data_dir = os.environ.get("DATA_DIR", "/mnt/data/stacks")
    abs_config = Path(data_dir) / "media" / "audiobookshelf-config"
    if abs_config.exists():
        print()
        print("ℹ️  Existing Audiobookshelf DATA left UNTOUCHED (non-destructive):")
        print(f"    {abs_config} (and its sibling -metadata + library dirs).")
        print(f"    `rm -rf {Path(data_dir) / 'media'}/audiobookshelf-*` once")
        print("    you've confirmed your audiobooks play from Jellyfin.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
