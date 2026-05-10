#!/usr/bin/env python3
"""
post-deploy hook for the `file-share` stack (Syncthing + Samba + FileBrowser).

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts):
  - logFileShareCredentials       → `__SB_CREDENTIAL__` for Samba
  - seedFileBrowserAdmin          → /api/system/filebrowser/init via SB_API_URL

Notes:
  - Syncthing emits its own GUI URL on the host port; nothing to seed there
    (device pairing is interactive). We just include a credential entry so
    the operator knows where the GUI lives.
  - FileBrowser proxy-auth mode auto-creates a non-admin user record on the
    first SSO request. The init endpoint pre-promotes a chosen LLDAP user
    to FB admin so there's a working admin from the first login.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def post_json(url: str, payload: dict[str, object], timeout: float = 10.0) -> tuple[int, dict[str, object] | None]:
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("SB_API_TOKEN", "")
    if token:
        headers["X-SB-Internal-Token"] = token
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(data) if data else None
            except json.JSONDecodeError:
                return resp.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # pylint: disable=broad-except
            return e.code, None
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, None


def wait_pod_running(pod_name: str, deadline_sec: float = 60.0) -> bool:
    """Poll `podman pod inspect` until the pod reports Running state, or the
    deadline expires. Replaces fixed sleep grace-periods — readiness arrives
    in 1–3s on warm machines and up to ~30s on slow disks / image-extract.
    Returns True iff the pod transitioned to Running before the deadline.
    Best-effort: any subprocess failure is treated as 'not ready yet'."""
    started = time.time()
    while time.time() - started < deadline_sec:
        try:
            r = subprocess.run(
                ["podman", "pod", "inspect", pod_name, "--format", "{{.State}}"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip().lower() == "running":
                return True
        except Exception:  # pylint: disable=broad-except
            pass
        time.sleep(1)
    return False


def main() -> int:
    host = env("HOST", "<server-ip>")

    # ── Samba ──────────────────────────────────────────────────────────
    share_user = env("SHARE_USER", "samba")
    share_password = env("SHARE_PASSWORD")
    if share_password:
        log(f"🔑 Samba share (user: {share_user}, password: {share_password}) — mount via \\\\{host}\\data on Windows or smb://{host}/data on macOS. Note now, only shown once.")
        emit_credential(
            service="Samba (file-share)",
            url=f"\\\\{host}\\data",
            username=share_user,
            password=share_password,
            importance="critical",
            notes="Windows network drive. Type once per PC when mounting.",
        )

    # ── FileBrowser admin pre-promotion ────────────────────────────────
    # Proxy-auth: FB auto-creates accounts on first SSO request, but they
    # default to non-admin. Pre-promote one LLDAP user (default `admin`)
    # to FB admin via the existing init endpoint, which exec's into the
    # running container. Idempotent — repeat calls upgrade-permission
    # rather than recreate.
    fb_user = env("FILEBROWSER_ADMIN_USER", "admin")
    sb_api = env("SB_API_URL", "http://localhost:3000")
    init_url = f"{sb_api}/api/system/filebrowser/init"

    # Wait for the pod itself to report Running before the first init
    # attempt. Replaces the previous `time.sleep(8)` blind wait —
    # Running typically arrives in 1–3s on a warm machine but can
    # stretch to 30s+ on slow disks or when the image is still
    # extracting. Either way, polling stops dead air for fast machines
    # while still giving slow ones the time they need. Best-effort:
    # any error in the probe falls through to the existing retry
    # loop below, which handles the "container exists but FB not
    # listening yet" case via /api/system/filebrowser/init's own retries.
    wait_pod_running("file-share", deadline_sec=60.0)
    deadline = time.time() + 3 * 60  # 3 min total budget — covers slow pulls
    last_beat = 0.0
    started = time.time()
    seeded = False
    while time.time() < deadline:
        status, body = post_json(init_url, {"username": fb_user, "node": env("SB_NODE", "Local")}, timeout=15)
        if status == 200 and body and body.get("ok"):
            action = body.get("action", "ready")
            log(f"✅ FileBrowser admin: {fb_user} ({action}) — log in via Authelia at https://files.<your-domain> to manage shares.")
            seeded = True
            break
        elapsed = time.time() - started
        if elapsed - last_beat >= 30:
            log(f"Still waiting for FileBrowser to accept the admin seed ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(5)
    if not seeded:
        log("⚠️ Could not pre-seed FileBrowser admin after 3 minutes. Run `podman exec file-share-filebrowser filebrowser users add <user> _ --perm.admin --database /database/filebrowser.db` once the pod is up.")
        # Non-zero exit so the post-deploy run record + diagnose probe
        # (post_deploy_failed) surface this. Otherwise the failure
        # silently disappears with the install log scroll. See #317.
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
