#!/usr/bin/env python3
"""
post-deploy hook for the `honcho` template (#1004).

Two responsibilities:

  1. **Probe /health** until Honcho's FastAPI listener answers 200.
     The kube unit's pgvector container takes a few seconds to
     initialise the database on first boot, so polling the health
     endpoint before declaring success is friendlier than letting
     the operator wonder why hermes' post-deploy didn't pick it up
     on the very next deploy.

  2. **Surface HONCHO_API_KEY** as a __SB_CREDENTIAL__ marker so an
     operator who installs Honcho outside the family stack can paste
     the token into a custom Hermes deployment. When Honcho is part
     of the household stack, `templates/hermes/post-deploy.py` reads
     the same key from the wizard variables and wires it into
     hermes/config.yaml directly — no copy-paste needed.

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol.
"""

from __future__ import annotations

import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def jlog(level: str, tag: str, message: str, **args: object) -> None:
    sys.stdout.write(
        json.dumps(
            {
                "ts": datetime.datetime.now().astimezone().isoformat(),
                "level": level,
                "tag": tag,
                "message": message,
                "args": args,
            }
        )
        + "\n"
    )
    sys.stdout.flush()


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def _health_timeout() -> int:
    return int(os.environ.get("HONCHO_HEALTH_TIMEOUT", "120"))


def wait_for_honcho(port: str, deadline_secs: int | None = None) -> bool:
    """Poll http://127.0.0.1:<port>/health until it answers 2xx. Returns
    True when reachable, False when the deadline passes. Best-effort —
    hermes' post-deploy re-probes the same endpoint, so a missed window
    here is non-fatal; the only consequence is a delay before hermes
    flips memory.provider from holographic to honcho."""
    if deadline_secs is None:
        deadline_secs = _health_timeout()
    if deadline_secs <= 0:
        return False
    deadline = time.time() + deadline_secs
    last_status = 0
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/health")
            with urllib.request.urlopen(req, timeout=5) as resp:
                last_status = resp.status
                if 200 <= resp.status < 300:
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            pass
        time.sleep(3)
    jlog("warn", "honcho:health", "/health not 200 within deadline", last_status=last_status, deadline_secs=deadline_secs)
    return False


def main() -> int:
    api_port = env("HONCHO_PORT", "8652")
    api_key = env("HONCHO_API_KEY")
    host = env("HOST", "<server-ip>")

    ready = wait_for_honcho(api_port)
    if ready:
        jlog("info", "honcho:health", "Honcho is reachable", port=api_port)
    else:
        jlog("warn", "honcho:health", "Honcho health did not come up in time — hermes will retry on its next deploy/restart", port=api_port)

    if api_key:
        emit_credential(
            service="Honcho (Per-User Memory)",
            url=f"http://{host}:{api_port}",
            username="(bearer token)",
            password=api_key,
            importance="optional",
            notes="Bearer token clients (Hermes' memory plugin, or your own scripts) send as `Authorization: Bearer <key>`. When the household stack deploys hermes alongside honcho, hermes' post-deploy reads this value automatically — copy-paste only needed for external clients.",
        )

    print(f"✅ Honcho is configured: port={api_port}, ready={ready}.")
    print(f"   Hermes' memory plugin will reach Honcho at http://127.0.0.1:{api_port} on its next deploy/restart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
