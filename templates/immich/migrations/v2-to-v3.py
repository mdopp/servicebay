#!/usr/bin/env python3
"""
Migration: immich v2 → v3 (#1904).

What changed between v2 and v3:
  - immich-server gains a NEW read-only mount of the file-share data
    root (`{{DATA_DIR}}/file-share/data` → `/mnt/photos`, readOnly) so
    Immich can index the disk-import photo areas via per-user External
    Libraries (`/mnt/photos/<user>/photos`) plus a shared one
    (`/mnt/photos/photos`). Decision A of #1904 — keyless: photos are
    copied into the file-share like every other category and Immich
    indexes them in place (read-only in Immich, no double storage).
  - `file-share` is added to servicebay.dependencies so its data root
    exists before immich mounts it.

No on-disk data moves — the upload, model-cache and pgdata volumes keep
their paths under `${DATA_DIR}/immich/`. The new mount is a hostPath with
type DirectoryOrCreate, so the redeploy creates the directory if file-share
hasn't populated it yet (the External Libraries simply index nothing until
photos land).

What this script does:
  - Inform the operator about the new read-only photo-area mount and the
    file-share dependency, and that no data is moved or deleted.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    data_dir = os.environ.get("DATA_DIR", "${DATA_DIR}")
    print("Immich v2 → v3: adding a READ-ONLY mount of the file-share data root (#1904).")
    print(f"  {data_dir}/file-share/data → /mnt/photos (readOnly) inside immich-server,")
    print("  so disk-import photos are indexed via per-user External Libraries")
    print("  (/mnt/photos/<user>/photos) + a shared one (/mnt/photos/photos).")
    print("  No data is moved or deleted; the photo areas are read-only in Immich")
    print("  (curation/deletion happens on the filesystem). file-share is now an")
    print("  install-time dependency so its data root exists before Immich mounts it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
