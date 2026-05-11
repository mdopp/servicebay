#!/usr/bin/env python3
"""
Migration: home-assistant v1 → v2 (#348, formalized by #352 phase 3).

What changed between v1 and v2: the Wyoming voice stack (whisper +
piper + openWakeWord) used to live as sidecar containers inside the
home-assistant Pod, sharing `${DATA_DIR}/home-assistant/{whisper,piper}`
for the model directories. v2 extracts those containers into a separate
`voice` template with its own `${DATA_DIR}/voice/{whisper,piper}` paths.

What this script does:
  - Inform the operator that voice has been extracted (we don't move
    the data here — that's the `voice` template's post-deploy.py job,
    so the migration stays idempotent regardless of install order:
    install voice now, install voice later, install voice never).
  - Exit 0. Migration scripts MUST exit 0 to let the deploy continue.

This script is intentionally read-only — it just logs guidance. The
actual data-move logic stays in `templates/voice/post-deploy.py` so
it runs exactly once (when the operator installs the voice template)
no matter how many times HA gets re-deployed.

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

    print("Home Assistant v1 → v2: voice extracted into the separate `voice` template.")
    print("  Voice models stay where they are; the `voice` template's post-deploy.py")
    print("  picks them up on first install and moves them to the new location.")
    if os.path.isdir(legacy_whisper) or os.path.isdir(legacy_piper):
        print(f"  Detected legacy voice data under {data_dir}/home-assistant/. To get voice")
        print("  back, install the `voice` template from Registry → Voice (Wyoming).")
    else:
        print("  No legacy voice data found; voice was not in use under v1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
