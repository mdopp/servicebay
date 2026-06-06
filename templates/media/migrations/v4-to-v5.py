#!/usr/bin/env python3
"""
Migration: media v4 → v5 (#1725).

Retire Audiobookshelf for FRESH installs; serve audiobooks via Jellyfin.

### Why

Audiobookshelf authenticates only via OIDC, and its OIDC client_secret
lives in ABS's preserved SQLite DB — it only converges with Authelia's
re-rendered copy if ServiceBay can log into ABS to PATCH it. That makes
ABS uniquely reinstall-brittle (it broke with `invalid_client` while
immich/vaultwarden SSO kept working — see #1717). Jellyfin already holds
the media libraries, authenticates via LDAP→LLDAP (#1718, no shared OIDC
secret), and serves audiobooks well enough with a Jellyfin-native client
(Symfonium). One robust house login, one less service to maintain.

### What this script does — NON-DESTRUCTIVE

This migration is **informational only**. It does NOT delete, move, or
touch any Audiobookshelf data:

  - v5's `template.yml` drops the `audiobookshelf` container from the pod,
    so a fresh install runs Jellyfin only.
  - On an UPGRADE the existing ABS data dirs
    (`${DATA_DIR}/media/audiobookshelf-config`, `-metadata`, plus the
    audiobooks/podcasts library paths) stay exactly where they are. The
    pod simply no longer (re)starts the ABS container. The operator can
    keep using their existing ABS (e.g. start it by hand) until they've
    migrated their listening to Jellyfin, then remove it when ready.
  - #1717's OIDC self-heal still applies to those existing ABS installs —
    `post-deploy.py` keeps the DB re-stamp so a still-running ABS keeps
    working until it's retired.

Jellyfin gains an **Audiobooks** library (content type Books) on
`/media/audiobooks`, registered idempotently by `post-deploy.py`. The
imported Hörspiele already live under `file-share/data/audiobooks/`.

Exit 0 (migrations MUST exit 0 to let the deploy continue).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    print("Media v4 → v5: retiring Audiobookshelf for fresh installs (#1725).")
    print()
    print("Audiobooks are now served by Jellyfin (content type Books) at")
    print("/media/audiobooks — Symfonium and other Jellyfin/Subsonic clients")
    print("play them with resume + speed, under the same LLDAP house login.")
    print()

    data_dir = os.environ.get("DATA_DIR", "/mnt/data/stacks")
    abs_config = Path(data_dir) / "media" / "audiobookshelf-config"

    if abs_config.exists():
        # Upgrade over an existing ABS install. Leave everything in place —
        # this is non-destructive by contract. Just tell the operator what
        # changed and how to retire ABS on their own schedule.
        print("ℹ️  Existing Audiobookshelf data detected — left UNTOUCHED.")
        print(f"    {abs_config} (and its sibling -metadata + library dirs)")
        print("    are preserved. This deploy no longer starts the ABS")
        print("    container; your data is safe on disk.")
        print()
        print("    To finish retiring Audiobookshelf when you're ready:")
        print("      1. Confirm your audiobooks appear in Jellyfin's")
        print("         'Audiobooks' library (Dashboard → Libraries).")
        print("      2. Re-point your listening app (Symfonium) at Jellyfin.")
        print("      3. Optionally delete the Authelia 'audiobookshelf' OIDC")
        print("         client + the `books.<domain>` proxy host (both are")
        print("         obsolete for v5 fresh installs).")
        print(f"      4. `rm -rf {Path(data_dir) / 'media'}/audiobookshelf-*`")
        print("         once you're confident — nothing else depends on it.")
    else:
        print("   No existing Audiobookshelf data — fresh-install case, nothing")
        print("   to migrate. Jellyfin serves audiobooks out of the box.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
