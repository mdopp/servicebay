#!/usr/bin/env python3
"""
Migration: voice v1 → v2 (#1809).

Whisper (STT) moves out of the kube pod into the companion
`voice-whisper.container` Quadlet that post-deploy.py installs (GPU via
CDI when registered, the previous CPU image otherwise).

No data moves: the CPU model cache stays at `${DATA_DIR}/voice/whisper`
and keeps being mounted by the CPU unit; the GPU image caches separately
under `${DATA_DIR}/voice/whisper-gpu` (different layout, linuxserver
`/config`) and downloads its model on first start. The Wyoming endpoint
stays tcp://localhost:10300, so Home Assistant pipeline config is
untouched.

This script only informs — the deploy replaces the pod (dropping its
whisper container) and the post-deploy brings up the companion unit.
Migration scripts MUST exit 0 to let the deploy continue.
"""

from __future__ import annotations

import sys


def main() -> int:
    sys.stdout.write(
        "voice v1->v2: whisper moves to the voice-whisper.container "
        "Quadlet (GPU on CDI boxes, #1809). No data is moved; the Wyoming "
        "endpoint stays tcp://localhost:10300.\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
