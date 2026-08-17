#!/usr/bin/env python3
"""
beets post-deploy (#2581).

This script deliberately does NOT import anything. See README.md for why:
`beet import` rewrites the operator's music files, and on an ambiguous
album it either stalls waiting for an answer or guesses one. Triggering it
is the operator's call, so all this script does is make that call an
informed one:

  1. Inspect an EXISTING /config/config.yaml (never write it — the pod's
     `seed-config` initContainer owns the "no config yet" case) and warn
     loudly if it is configured to move or copy files, because then an
     import relocates and renames the collection.
  2. Register a health check that goes RED while the beets library is
     empty, so "running but has never been given anything to do" stops
     looking green — the #2581 complaint that a service waiting for a
     command nobody gives should not count as healthy.
  3. Print the commands that actually trigger an import.

Exit 0 unconditionally: everything here is advisory, and post-deploy
failures don't roll back a deploy anyway.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

CONTAINER = "beets-beets"
DEFAULT_PORT = "8337"


def log(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default) or default


def config_path() -> str:
    """Host path of beets' config, mirroring template.yml's /config volume."""
    return os.path.join(env("DATA_DIR", "/mnt/data"), "beets", "config", "config.yaml")


def relocating_import_settings(config_text: str) -> list[str]:
    """Return the `import:` keys in this config that make beets RELOCATE files.

    Deliberately a small line scanner rather than a YAML parse: PyYAML is not
    guaranteed on the host, and the question is narrow — is `move` or `copy`
    turned on inside the top-level `import:` block. Anything not clearly off
    counts as on, because the whole point is to err towards warning.
    """
    off = {"no", "false", "off", "0", "none"}
    found: list[str] = []
    in_import = False
    for raw in config_text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            # A new top-level key ends the import block.
            in_import = line.strip().startswith("import:")
            continue
        if not in_import:
            continue
        stripped = line.strip()
        for key in ("move", "copy"):
            prefix = key + ":"
            if stripped.startswith(prefix):
                value = stripped[len(prefix):].strip().strip("'\"").lower()
                if value and value not in off:
                    found.append(f"{key}: {value}")
    return found


def warn_about_existing_config() -> None:
    path = config_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        # The initContainer seeds a safe config when there isn't one; if it
        # is missing here the pod hasn't written its volume yet, which the
        # health check below will surface.
        log(f"   (note) No config at {path} yet — the pod seeds one on start.")
        return
    except OSError as exc:
        log(f"   (note) Could not read {path}: {exc}. Skipping the config check.")
        return

    hits = relocating_import_settings(text)
    if not hits:
        log("✅ beets config: imports write tags in place — no move/copy, "
            "so an import will not relocate or rename your files.")
        return

    log("")
    log("⚠️  BEETS CONFIG WILL RELOCATE YOUR MUSIC ON THE NEXT IMPORT")
    log(f"   {path} has under `import:`  →  {', '.join(hits)}")
    log("   With that setting, ANY `beet import` — including the quiet one in")
    log("   the README — moves every file it touches into beets' own folder")
    log("   scheme and renames it. This template never turns that on itself;")
    log("   it is carried over from an earlier install.")
    log("   If you want tags written in place instead, set `move: no` and")
    log("   `copy: no` under `import:` BEFORE running an import.")
    log("")


def register_empty_library_check(sb_api: str, port: str) -> None:
    """Health check: red while the beets library holds zero items.

    `beet web`'s /stats answers `{"items": N, "albums": M}`. A body match on a
    non-zero item count turns "beets is up but has never imported anything"
    into a visible red check instead of a green pod. Registered here rather
    than as the template's `servicebay.healthcheck` annotation on purpose:
    that annotation gates install settleWait, and a fresh install legitimately
    has an empty library — it must not block the deploy.
    """
    payload = {
        "id": "beets-library-populated",
        "name": "Beets library populated",
        "type": "http",
        "target": f"http://127.0.0.1:{port}/stats",
        "interval": 300,
        "enabled": True,
        "httpConfig": {
            "expectedStatus": 200,
            "bodyMatch": r'"items"\s*:\s*[1-9]',
            "bodyMatchType": "regex",
        },
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = env("SB_API_TOKEN")
    if token:
        headers["X-SB-Internal-Token"] = token
    req = urllib.request.Request(
        f"{sb_api}/api/health/checks", data=body, headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                log("✅ Registered health check 'beets-library-populated' — it stays")
                log("   RED until an import has actually put something in the library.")
                return
            log(f"⚠️ Health-check registration returned HTTP {resp.status}. "
                "The auto-created service:beets check still applies.")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        log(f"⚠️ Could not register the library health check: {exc}. "
            "The auto-created service:beets check still applies.")


def print_import_instructions(port: str) -> None:
    log("")
    log("🎵 beets is running. It does NOT import anything on its own — that is")
    log("   deliberate; an unattended import rewrites your music files. See the")
    log("   template README for the reasoning.")
    log(f"   Web UI (library browser, LAN only): http://<this-box>:{port}")
    log("")
    log("   Tag your library when you're ready:")
    log(f"     podman exec -it {CONTAINER} beet import /music      # asks you about anything unclear")
    log(f"     podman exec {CONTAINER} beet import -q -i /music    # only confident matches, skips the rest")
    log(f"     podman exec {CONTAINER} beet stats                  # what's in the library right now")
    log("")


def main() -> int:
    port = env("BEETS_PORT", DEFAULT_PORT)
    warn_about_existing_config()
    register_empty_library_check(env("SB_API_URL", "http://localhost:3000"), port)
    print_import_instructions(port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
