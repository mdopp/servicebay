#!/usr/bin/env python3
"""
post-deploy hook for the `voice` stack.

Two responsibilities:

  1. **Data migration from the old in-HA-pod voice setup.** Whisper
     models and Piper voices used to live under
     `${DATA_DIR}/home-assistant/whisper` and `…/piper`. The split in
     #348 moves them to `${DATA_DIR}/voice/whisper` and `…/piper`.
     On first install we detect leftover content under the old paths
     and move it to the new location so the operator doesn't have
     to re-download multi-gigabyte models.

  2. **Surface the endpoint cheat-sheet** so the operator sees the
     three Wyoming URLs they need to paste into HA's voice-assistant
     UI.

Idempotent: a second run sees the new paths already populated and
the old paths absent, and does nothing.

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol.
"""

from __future__ import annotations

import os
import shutil
import sys


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def migrate_dir(old_path: str, new_path: str, label: str) -> None:
    """Move old_path → new_path if old exists and new is empty/missing.

    Treats a non-empty destination as "already migrated" — never
    overwrites. Best-effort: a failure logs but doesn't abort the
    rest of the post-deploy. The voice pod will still come up with
    an empty data dir and re-download on first request.
    """
    if not os.path.isdir(old_path):
        return
    if os.path.isdir(new_path) and any(os.scandir(new_path)):
        # Both exist and the new one is already populated — leave
        # everything alone. The operator can clean up the old path
        # manually once they're satisfied the new one works.
        log(f"   {label}: new path is already populated; leaving the legacy {old_path} as-is.")
        return
    try:
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        if os.path.exists(new_path):
            # New path exists but is empty — remove the empty dir
            # before move so shutil.move treats this as a rename.
            os.rmdir(new_path)
        shutil.move(old_path, new_path)
        log(f"   {label}: moved {old_path} → {new_path}.")
    except Exception as e:  # pylint: disable=broad-except
        log(f"   ⚠️ {label}: could not migrate {old_path} → {new_path}: {e}. The voice pod will re-download models on first request.")


def main() -> int:
    data_dir = env("DATA_DIR", "/mnt/data")

    # Migrate the legacy in-HA-pod voice data.
    legacy_whisper = os.path.join(data_dir, "home-assistant", "whisper")
    legacy_piper = os.path.join(data_dir, "home-assistant", "piper")
    new_whisper = os.path.join(data_dir, "voice", "whisper")
    new_piper = os.path.join(data_dir, "voice", "piper")
    if os.path.isdir(legacy_whisper) or os.path.isdir(legacy_piper):
        log("Migrating voice data from the legacy in-HA-pod paths (#348)...")
        migrate_dir(legacy_whisper, new_whisper, "Faster Whisper models")
        migrate_dir(legacy_piper, new_piper, "Piper voices")

    log("✅ Voice pipeline endpoints — paste these into Home Assistant → Settings → Voice Assistants:")
    log("   • Speech-to-text (Wyoming): tcp://localhost:10300")
    log("   • Text-to-speech   (Wyoming): tcp://localhost:10200")
    log("   • Wake word        (Wyoming): tcp://localhost:10400")

    return 0


if __name__ == "__main__":
    sys.exit(main())
