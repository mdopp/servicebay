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


def main() -> int:
    host = env("HOST", "<server-ip>")

    # ── Syncthing GUI host-check ───────────────────────────────────────
    # Syncthing's GUI defaults to allowing the bind address only as a
    # Host: header. NPM forwards `sync.<PUBLIC_DOMAIN>` and Syncthing
    # rejects with HTTP 403 `Host check error`. STGUIHOSTCHECK isn't a
    # real env var; only the config.xml `<insecureSkipHostcheck>` child
    # element disables the check. We patch it idempotently here so a
    # fresh install or a re-deploy lands the right config without
    # waiting for the operator to do it manually. (#880)
    syncthing_config_xml = "/var/syncthing/config/config.xml"
    patch_syncthing_cmd = (
        "podman exec file-share-syncthing sh -c "
        "'grep -q insecureSkipHostcheck " + syncthing_config_xml + " || "
        "sed -i \"s|<address>127.0.0.1:8384</address>|<address>127.0.0.1:8384</address>"
        "\\n        <insecureSkipHostcheck>true</insecureSkipHostcheck>|\" "
        + syncthing_config_xml + "'"
    )
    rc = os.system(patch_syncthing_cmd)
    if rc == 0:
        # Syncthing reloads config.xml on SIGHUP but not on a plain file
        # write; restart the container to pick up the new setting. The
        # subsequent Samba/FileBrowser steps don't depend on Syncthing
        # so a short window where Syncthing is restarting is harmless.
        os.system("podman restart file-share-syncthing > /dev/null 2>&1 || true")
        log("✅ Syncthing GUI host-check disabled (config.xml patched).")
    else:
        log("⚠️  Syncthing config patch returned a non-zero exit. The sync.<domain> URL may return 403 'Host check error' — fix manually in /var/syncthing/config/config.xml.")

    # ── Samba ──────────────────────────────────────────────────────────
    share_user = env("SHARE_USER", "samba")
    share_password = env("SHARE_PASSWORD")
    if share_password:
        log(f"✅ Samba share saved (user: {share_user}) — mount via \\\\{host}\\data on Windows or smb://{host}/data on macOS. Password retrievable from Settings → Integrations → Saved credentials.")
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

    # The install runner's readiness probes (servicebay.readiness in this
    # template's template.yml, #613) already blocked on FileBrowser's
    # HTTP port answering — by the time we get here the binary has
    # loaded its SQLite DB. The retry loop below remains because the
    # init endpoint's `podman exec` can still race with FB binding its
    # listener even after the HTTP probe answered.
    deadline = time.time() + 3 * 60  # 3 min total budget — covers slow pulls
    last_beat = 0.0
    started = time.time()
    seeded = False
    last_status = 0
    last_error = ""
    while time.time() < deadline:
        # 60s per attempt: the init endpoint round-trips a `podman
        # exec` through the agent (SSH) and into filebrowser's
        # SQLite. With cold caches that can creep past urllib's old
        # 15s, surfacing as bogus status=0 even when the seed eventually
        # would have worked. The 3-min outer budget is unchanged.
        status, body = post_json(init_url, {"username": fb_user, "node": env("SB_NODE", "Local")}, timeout=60)
        last_status = status
        if status == 200 and body and body.get("ok"):
            action = body.get("action", "ready")
            log(f"✅ FileBrowser admin: {fb_user} ({action}) — log in via Authelia at https://files.<your-domain> to manage shares.")
            seeded = True
            break
        # Capture the actual error from each attempt so the heartbeat
        # below isn't a black box. status=0 means urllib couldn't even
        # connect (timeout / refused / DNS); 4xx-5xx means ServiceBay
        # rejected it; body.error is what the route handler returned.
        if status == 0:
            last_error = "no response (connect failed or timeout)"
        elif body and isinstance(body, dict) and body.get("error"):
            last_error = f"HTTP {status}: {body['error']}"
        else:
            last_error = f"HTTP {status}"
        elapsed = time.time() - started
        if elapsed - last_beat >= 30:
            log(f"Still waiting for FileBrowser to accept the admin seed ({int(elapsed)}s elapsed, last response: {last_error})...")
            last_beat = elapsed
        time.sleep(5)
    if not seeded:
        log(f"⚠️ Could not pre-seed FileBrowser admin after 3 minutes. Last response: {last_error or 'unknown'}.")
        log(f"   Endpoint: {init_url}")
        log(f"   SB_API_URL={sb_api}  SB_API_TOKEN={'set' if os.environ.get('SB_API_TOKEN') else 'MISSING'}")
        log("   Manual recovery: `podman exec file-share-filebrowser filebrowser users add <user> _ --perm.admin --database /database/filebrowser.db`")
        # Non-zero exit so the post-deploy run record + diagnose probe
        # (post_deploy_failed) surface this. Otherwise the failure
        # silently disappears with the install log scroll. See #317.
        return 1

    # ── Samba ↔ LLDAP first-sync (#494) ────────────────────────────────
    # Trigger the API endpoint that adds tdbsam accounts for every
    # LLDAP user. Best-effort: a failure here just means the operator
    # has to click "Sync" in Settings → Integrations → File Share to
    # populate accounts. Without this step the operator opens the UI
    # to an empty list on first install and has to click Sync
    # themselves; with it, the per-user accounts are ready for a
    # password-set right after deploy.
    samba_sync_url = f"{sb_api}/api/system/file-share/samba/users"
    # 90s budget: the endpoint does up to 20s of LLDAP GraphQL (auth +
    # query, both 10s timeouts) followed by a podman exec per user. On
    # a freshly-installed stack LLDAP is often still warming up — a
    # 30s outer cap routinely tripped before the GraphQL response
    # landed and the wizard surfaced a misleading "HTTP 0" line.
    sync_status, sync_body = post_json(samba_sync_url, {}, timeout=90)
    if sync_status == 200 and sync_body and sync_body.get("ok"):
        users = sync_body.get("users") or []
        added = sync_body.get("added") or []
        log(f"✅ Samba ↔ LLDAP sync complete — {len(users)} user(s) in directory, {len(added)} new account(s) added with random initial passwords (set them via Settings → Integrations → File Share before first mount).")
    elif sync_status == 503:
        log(f"ℹ️  Samba sync skipped: LLDAP not reachable yet. Open Settings → Integrations → File Share once LLDAP is up to populate accounts.")
    elif sync_status == 404:
        log(f"ℹ️  Samba sync skipped: file-share-samba container not running yet. Try again once the pod is healthy.")
    else:
        log(f"⚠️  Samba ↔ LLDAP sync returned HTTP {sync_status}. Open Settings → Integrations → File Share to populate accounts manually.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
