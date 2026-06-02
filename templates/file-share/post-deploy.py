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

import grp
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


# Dedicated POSIX group that owns the shared notes vault. Members of this
# group (incl. cross-stack consumers like OSCAR's Hermes, mapped in on the
# consumer side) can co-write the vault regardless of which host uid their
# userns maps them to. See #1311.
SHARE_GROUP = "file-share"


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


def _notes_dir() -> str:
    """Host-side path of the shared notes vault. Lives under the
    `shared-data` hostPath (`{{DATA_DIR}}/file-share/data`) that the pod
    mounts as /data (samba), /srv (filebrowser) and /var/syncthing/Sync
    (syncthing). Must stay in sync with the volume in template.yml."""
    base = env("DATA_DIR", "/mnt/data")
    return os.path.join(base, "file-share", "data", "notes")


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)


def _run_priv(cmd: list[str]) -> bool:
    """Run a mutating command, retrying once with sudo if the unprivileged
    attempt fails (the notes dir is normally owned by the host user the
    post-deploy runs as, so the plain attempt usually succeeds; sudo is the
    fallback when ownership has drifted). Returns True on success."""
    try:
        res = _run(cmd)
        if res.returncode == 0:
            return True
        sudo = _run(["sudo", "-n", *cmd])
        if sudo.returncode == 0:
            return True
        log(f"   ⚠️  {' '.join(cmd)} failed: {(res.stderr or sudo.stderr or '').strip()}")
        return False
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️  {' '.join(cmd)} could not run: {exc}")
        return False


def _ensure_share_group() -> int | None:
    """Ensure the dedicated `file-share` group exists and return its gid.
    Idempotent: returns the existing gid if the group is already present,
    otherwise best-effort `groupadd` (needs sudo). Returns None if the
    group can't be resolved/created — caller logs + skips ACL work then."""
    try:
        return grp.getgrnam(SHARE_GROUP).gr_gid
    except KeyError:
        pass
    # Group missing — create it (system group, host-wide). Best-effort.
    try:
        created = _run(["sudo", "-n", "groupadd", "--system", SHARE_GROUP])
        if created.returncode != 0 and "already exists" not in (created.stderr or ""):
            log(f"   ⚠️  Could not create the '{SHARE_GROUP}' group: {(created.stderr or '').strip()}")
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️  groupadd '{SHARE_GROUP}' could not run: {exc}")
    try:
        return grp.getgrnam(SHARE_GROUP).gr_gid
    except KeyError:
        return None


def provision_notes_share() -> None:
    """Replace the legacy `0777` notes hack with a real access model so the
    vault is multi-writer across services (and, once a consumer is mapped
    into the group, across stacks). Idempotent + fail-soft: every step logs
    on failure and never aborts the deploy. Re-applied each deploy so it
    survives a backup/restore that resets ownership. See #1311.

      1. dedicated `file-share` gid owns notes/ (chgrp -R)
      2. setgid (chmod 2775) so new files inherit that group
      3. default POSIX ACL g:<gid>:rwx so new files are group-rwx
         regardless of the writer's umask 0022 (the images run as root
         with no UMASK knob — the directory enforces it instead), plus the
         same ACL on existing entries.
    """
    notes = _notes_dir()
    log(f"── Provisioning shared notes vault permissions ({notes}) ──")
    if not os.path.isdir(notes):
        # DirectoryOrCreate makes the share root, but `notes/` is a
        # convention subdir — create it so the model applies from deploy 1.
        try:
            os.makedirs(notes, exist_ok=True)
        except OSError as exc:
            log(f"   ⚠️  notes dir absent and could not be created ({exc}); skipping permission provisioning.")
            return

    gid = _ensure_share_group()
    if gid is None:
        log(f"   ⚠️  '{SHARE_GROUP}' group unavailable; skipping group-own + ACL. The vault keeps its current permissions.")
        return

    # 1. group-own the tree by the shared gid.
    if _run_priv(["chgrp", "-R", str(gid), notes]):
        log(f"   group-owned notes/ by gid {gid} ({SHARE_GROUP}).")
    # 2. setgid + group-write on the dir so new files inherit the group.
    if _run_priv(["chmod", "2775", notes]):
        log("   set mode 2775 (setgid) on notes/.")
    # 3. default ACL (new files) + apply to existing entries. setfacl is
    #    only present when the fs supports ACLs (XFS here does); a missing
    #    binary or unsupported fs just logs and leaves setgid in place.
    if _run_priv(["setfacl", "-R", "-d", "-m", f"g:{gid}:rwx", notes]):
        log(f"   set default ACL g:{gid}:rwx on notes/ (new files inherit group-rwx).")
    if _run_priv(["setfacl", "-R", "-m", f"g:{gid}:rwx", notes]):
        log(f"   applied ACL g:{gid}:rwx to existing notes/ entries.")
    log("   ✅ notes vault provisioned (shared gid + setgid + default ACL). "
        "Cross-stack consumers (e.g. Hermes) must be mapped into the "
        f"'{SHARE_GROUP}' group on their pod to co-write.")


def main() -> int:
    host = env("HOST", "<server-ip>")

    # ── Shared notes-vault permission model (#1311) ────────────────────
    # Provision the multi-writer access model before anything else so the
    # vault is co-editable from this deploy on. Best-effort; never fatal.
    provision_notes_share()

    # ── Syncthing GUI host-check ───────────────────────────────────────
    # Syncthing's GUI rejects Host headers other than the bind address
    # with HTTP 403 "Host check error" — NPM forwards `sync.<PUBLIC_DOMAIN>`
    # → instant 403 until the check is disabled.
    #
    # Approach in Syncthing v2: wait for config.xml + apikey to exist (the
    # container creates them on first start, not before), then issue the
    # change via `syncthing cli config gui insecure-skip-host-check set true`
    # which writes through the live API. An XML-only edit (sed) lands the
    # attribute but Syncthing v2 doesn't honour it across restarts;
    # the CLI is the only reliable path. (#880, fixed for v2 in
    # follow-up to install-self-heal-batch.)
    syncthing_config_xml = "/var/syncthing/config/config.xml"
    apikey = ""
    for _ in range(40):  # ~60s, covers cold-cache first start
        # Read the apikey out of config.xml in a single shell — sed prints
        # the captured group when the line is present, or nothing when the
        # file doesn't yet exist / has no apikey. Empty stdout means
        # "not ready" and we sleep + retry.
        probe = subprocess.run(
            ["podman", "exec", "file-share-syncthing", "sh", "-c",
             f"sed -n 's|.*<apikey>\\(.*\\)</apikey>.*|\\1|p' {syncthing_config_xml} 2>/dev/null | head -1"],
            capture_output=True, text=True, check=False,
        )
        candidate = (probe.stdout or "").strip()
        if probe.returncode == 0 and candidate:
            apikey = candidate
            break
        time.sleep(1.5)
    if not apikey:
        log("⚠️  Syncthing config.xml + apikey not present after 60s — skipping host-check patch. The sync.<domain> URL may return 403 'Host check error'; re-run this post-deploy from Diagnose once Syncthing is up.")
    else:
        cli = subprocess.run(
            ["podman", "exec", "file-share-syncthing", "syncthing", "cli",
             "--gui-address", "http://127.0.0.1:8384",
             "--gui-apikey", apikey,
             "config", "gui", "insecure-skip-host-check", "set", "true"],
            capture_output=True, text=True, check=False,
        )
        if cli.returncode == 0:
            log("✅ Syncthing GUI host-check disabled (live API).")
        else:
            log("⚠️  Syncthing CLI returned non-zero. The sync.<domain> URL may return 403 'Host check error' — fix manually with `syncthing cli config gui insecure-skip-host-check set true`.")

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
