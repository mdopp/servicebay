#!/usr/bin/env python3
"""
Migration: home-assistant v1 → v2 (#348; voice retired by #1876).

What changed between v1 and v2: the Wyoming voice stack (whisper +
piper + openWakeWord) used to live as sidecar containers inside the
home-assistant Pod, sharing `${DATA_DIR}/home-assistant/{whisper,piper}`
for the model directories. ServiceBay no longer ships a voice stack
(#1876) — the voice pipeline is owned externally now. HA keeps
running unchanged.

What this script does:
  - Inform the operator that voice is no longer part of HA. We do not
    touch the legacy model directories — they are unused by HA and the
    operator can remove them at their leisure.
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

This script is intentionally read-only — it just logs guidance.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 1
  - NEW_SCHEMA_VERSION = 2
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (PUBLIC_DOMAIN, HOME_ASSISTANT_SUBDOMAIN, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    data_dir = os.environ.get("DATA_DIR") or os.environ.get("NEW_DATA_DIR") or "/mnt/data"
    legacy_whisper = os.path.join(data_dir, "home-assistant", "whisper")
    legacy_piper = os.path.join(data_dir, "home-assistant", "piper")

    print("Home Assistant v1 → v2: voice is no longer part of the HA stack (#1876).")
    print("  HA keeps running unchanged; ServiceBay ships no voice containers.")
    if os.path.isdir(legacy_whisper) or os.path.isdir(legacy_piper):
        print(f"  Detected legacy voice model data under {data_dir}/home-assistant/.")
        print("  It is unused by HA and can be removed by the operator at any time.")
    else:
        print("  No legacy voice data found; voice was not in use under v1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
