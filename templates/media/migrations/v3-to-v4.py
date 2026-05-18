#!/usr/bin/env python3
"""
Migration: media v3 → v4 (#618).

Music server swap: Navidrome → Jellyfin. Two motivations:

  1. Quick Connect. Symfonium / Findroid / Streamyfin can pair via
     a 6-digit code shown in the app, confirmed once in the web UI
     — no shared password for mobile apps, no Subsonic basic-auth.
     Navidrome's mobile-app story was always "type the local admin
     password into every device", because Subsonic the protocol has
     no OAuth/token concept.
  2. Optionality. Jellyfin handles Music + Video + Photos + Podcasts
     under one umbrella. If the operator later wants to host Movies
     or TV, there's no second media server to deploy.

What this script does:
  - Inform the operator about the swap and the data-loss caveats
    (no automated migration of play-history, stars, playlists —
     Navidrome's SQLite schema and Jellyfin's are different beasts).
  - Move the existing Navidrome data dir aside (.bak suffix) instead
    of deleting it. Operator can drop it once they're confident.
    Idempotent: skip if .bak already exists from a previous attempt.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

After deploy:
  - Old `${DATA_DIR}/media/navidrome` is renamed to
    `${DATA_DIR}/media/navidrome.bak`. Operator deletes when ready.
  - Jellyfin starts on JELLYFIN_PORT (default 8096); the
    `music.dopp.cloud` proxy host now forwards there.
  - Symfonium users need to re-pair (delete old connection, add new
    via Quick Connect; Jellyfin backend, not Subsonic). Plays /
    favorites from Navidrome are NOT carried over.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    print("Media v3 → v4: swapping Navidrome out for Jellyfin (#618).")
    print()
    print("Why: Jellyfin's Quick Connect gives Symfonium / Findroid /")
    print("Streamyfin password-free mobile pairing (Navidrome's Subsonic")
    print("API requires shared local-admin credentials).")
    print()
    print("⚠️  Data NOT carried over:")
    print("    • Play history / last-played positions")
    print("    • Stars / favorites / ratings")
    print("    • Custom playlists")
    print("    • Per-user accounts (you re-create families in Jellyfin)")
    print()
    print("Data preserved:")
    print("    • The Music library itself (still mounted at the same path).")
    print()

    data_dir = os.environ.get("DATA_DIR", "/mnt/data/stacks")
    nd_dir = Path(data_dir) / "media" / "navidrome"
    bak = nd_dir.with_name(nd_dir.name + ".bak")

    if not nd_dir.exists():
        print(f"   {nd_dir} not found — nothing to move aside (fresh-install case).")
    elif bak.exists():
        print(f"   {bak} already exists — leaving as-is (re-run of this migration).")
    else:
        try:
            nd_dir.rename(bak)
            print(f"   Moved {nd_dir} → {bak}. Delete when you're confident.")
        except OSError as e:
            # Don't fail the deploy — the rename is a courtesy, not load-bearing.
            print(f"   (note) Could not rename Navidrome data dir: {e}. Skipping.")

    print()
    print("After this deploy:")
    print("  • Open https://music.<your-domain> — Jellyfin's web UI.")
    print("  • In Symfonium / Findroid: delete the old Navidrome backend, add")
    print("    a new one as 'Jellyfin', point at the same URL, choose 'Quick")
    print("    Connect' as the sign-in method.")
    print("  • Drop the Authelia 'navidrome' OIDC client + the old Navidrome")
    print("    proxy-host advanced_config; both are obsolete (v4 doesn't")
    print("    register either).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
