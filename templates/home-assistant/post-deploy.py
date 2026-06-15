#!/usr/bin/env python3
"""
post-deploy hook for the `home-assistant` stack.

Responsibilities:

  1. **udev rule** — when ZWAVE_DEVICE is set, writes
     /etc/udev/rules.d/99-zwave.rules via sudo so the Z-Wave USB stick is
     accessible to the rootless Podman container on every boot. In a rootless
     user-namespace, host root (UID 0) maps to nobody inside the container, so
     the device appears as crw-rw---- nobody:nobody and is inaccessible without
     mode 0666. The rule fires on every device detection event, survives
     reboots and re-installs on any machine.

  2. **Z-Wave JS WS port** — seeds the JSON file pointed at by the
     `ZWAVE_EXTERNAL_SETTINGS` env var (declared in template.yml) so
     zwave-js-ui binds its HA WebSocket server on port 3001. Port 3000 is
     unavailable on the host because NPM uses hostNetwork and its internal
     admin backend binds 127.0.0.1:3000 — even though the host nginx in the
     same container only exposes 80/443/81 externally. The external-settings
     file is read by zwave-js-ui on every boot; we only write it when it's
     missing AND the operator has not already configured a serverPort via
     the UI (stored in settings.json under `zwave.serverPort`).

  3. **auth_oidc custom component** — downloads the pinned release tarball
     of the `auth_oidc` HA custom component (#493) and drops it into
     `<config>/custom_components/auth_oidc/`. HA Core has no native OIDC
     provider, so this is the bridge. Idempotent via a `.sb_installed_version`
     stamp; only re-downloads + extracts when HA_OIDC_AUTH_VERSION changes.

Idempotent overall: safe to re-run on every deploy.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

UDEV_RULE_DIR = "/etc/udev/rules.d"
UDEV_RULE_FILE = "99-zwave.rules"

ZWAVEJS_WS_PORT = 3001
ZWAVEJS_WS_HOST = "0.0.0.0"
ZWAVE_CONTAINER_NAME = "home-assistant-zwave-js"
REQUEST_TIMEOUT = 10.0

# auth_oidc install
HA_API = "http://127.0.0.1:8123"
HA_OIDC_REPO = "christiaangoossens/hass-oidc-auth"
HA_READY_TIMEOUT = 180.0
HA_READY_INTERVAL = 3.0
HA_CONTAINER_NAME = "home-assistant-homeassistant"


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ── Z-Wave device re-detection (#1511) ─────────────────────────────────────────
#
# ZWAVE_DEVICE (the USB stick's /dev/tty* path) lives in ServiceBay's config,
# which a `wipe-configs` reinstall wipes — while the kept zwave-js node DB +
# network keys in <DATA_DIR>/home-assistant/zwave-js are stranded because the
# fresh install never re-collected the device path. When ZWAVE_DEVICE is unset
# we mirror the installer's "auto-pick when there's exactly one USB-serial
# device" rule (src/app/api/system/devices/route.ts) right here on the box, so
# the udev rule + zwave-js wiring re-establish themselves with no operator step.

ZWAVE_BY_ID_DIR = "/dev/serial/by-id"


def _detect_single_usb_serial_device() -> str | None:
    """Resolve the canonical /dev/tty* path of the sole USB-serial stick on
    the host, or None when there are zero or more than one. Mirrors the
    installer endpoint: read /dev/serial/by-id symlinks, resolve to their
    /dev/tty* targets, dedupe (a multi-radio stick has several by-id
    symlinks pointing at one tty), and only auto-pick when exactly one
    distinct device remains — guessing between two sticks would be worse
    than leaving it unset."""
    try:
        entries = os.listdir(ZWAVE_BY_ID_DIR)
    except OSError:
        return None
    resolved: set[str] = set()
    for name in entries:
        link = os.path.join(ZWAVE_BY_ID_DIR, name)
        try:
            target = os.path.realpath(link)
        except OSError:
            continue
        if os.path.exists(target):
            resolved.add(target)
    if len(resolved) == 1:
        return next(iter(resolved))
    return None


# ── udev ──────────────────────────────────────────────────────────────────────

def _device_kernel_pattern(device_path: str) -> str:
    name = os.path.basename(device_path)
    return re.sub(r"\d+$", "*", name)


def ensure_udev_rule(zwave_device: str) -> None:
    pattern = _device_kernel_pattern(zwave_device)
    rule_line = f'SUBSYSTEM=="tty", KERNEL=="{pattern}", MODE="0666"\n'
    rule_path = os.path.join(UDEV_RULE_DIR, UDEV_RULE_FILE)

    try:
        if os.path.isfile(rule_path) and open(rule_path).read() == rule_line:
            log(f"   udev rule already in place ({rule_path}) — skipping.")
            _reload_udev(zwave_device)
            return
    except OSError:
        pass

    try:
        result = subprocess.run(
            ["sudo", "tee", rule_path],
            input=rule_line,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip())
        log(f"   wrote {rule_path}: {rule_line.strip()}")
    except Exception as exc:
        log(f"   ⚠️  could not write {rule_path}: {exc}")
        log(f"   Run manually: echo '{rule_line.strip()}' | sudo tee {rule_path}")
        log(f"                 sudo udevadm control --reload-rules")
        return

    _reload_udev(zwave_device)


def _reload_udev(zwave_device: str) -> None:
    try:
        subprocess.run(["sudo", "udevadm", "control", "--reload-rules"], check=True, capture_output=True)
        if os.path.exists(zwave_device):
            subprocess.run(["sudo", "udevadm", "trigger", zwave_device], check=True, capture_output=True)
        log("   udev rules reloaded — permissions applied on every boot.")
    except Exception as exc:
        log(f"   ⚠️  udevadm reload failed: {exc}. Permissions will apply on next reboot.")


# ── Z-Wave JS WS port ──────────────────────────────────────────────────────────

def _zwave_store_dir() -> str:
    """Host-side path of the zwave-js container's /usr/src/app/store
    mount. Must stay in sync with the volume declaration in
    template.yml."""
    base = env("DATA_DIR", "/mnt/data")
    return os.path.join(base, "home-assistant", "zwave-js")


def _zwave_external_settings_path() -> str:
    # Filename must match the ZWAVE_EXTERNAL_SETTINGS env var in template.yml.
    return os.path.join(_zwave_store_dir(), "sb-external-settings.json")


def _zwave_ui_has_serverport() -> bool:
    """True iff settings.json (written by zwave-js-ui when the operator
    saves anything in Settings → Home Assistant) already pins a
    serverPort. We honour that and leave the external-settings file
    unwritten — external settings would otherwise silently override
    the operator's choice on every boot."""
    in_store = os.path.join(_zwave_store_dir(), "settings.json")
    try:
        with open(in_store, encoding="utf-8") as fh:
            stored = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return False
    return bool(stored.get("zwave", {}).get("serverPort"))


def ensure_zwave_external_settings() -> bool:
    """Seed the JSON file zwave-js-ui reads via ZWAVE_EXTERNAL_SETTINGS.
    Returns True iff a file was just written (caller restarts the
    zwave-js container so the new values take effect immediately —
    without that, the operator would only see the change on the next
    reboot)."""
    path = _zwave_external_settings_path()
    if os.path.isfile(path):
        log(f"   {os.path.basename(path)} already in place — leaving untouched.")
        return False
    if _zwave_ui_has_serverport():
        log("   Existing UI-configured serverPort found in settings.json — not overriding.")
        return False

    desired = {
        "serverEnabled": True,
        "serverPort": ZWAVEJS_WS_PORT,
        "serverHost": ZWAVEJS_WS_HOST,
    }
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(desired, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        log(f"   ⚠️ Could not write {path}: {exc}. Z-Wave JS will need WS server enabled in the UI.")
        return False
    log(f"   wrote {path}: serverEnabled=true, serverPort={ZWAVEJS_WS_PORT}, serverHost={ZWAVEJS_WS_HOST}")
    return True


def _zwave_settings_path() -> str:
    """zwave-js-ui's operator store. It holds `zwave.port` (the serial
    device), `zwave.enableSoftReset`, and the network securityKeys. zwave-js-ui
    reads + rewrites this on boot, so we merge into it rather than clobber it."""
    return os.path.join(_zwave_store_dir(), "settings.json")


def ensure_zwave_port_settings(zwave_device: str) -> bool:
    """Write the serial port + soft-reset policy into zwave-js-ui's
    settings.json so the driver inits without a manual web-UI step (#1594).

    Two gaps this closes, both verified live on an Aeotec Gen5 (USB 0658:0200):

      1. The serial port was never configured — sb-external-settings.json only
         carries the HA WebSocket server, never `zwave.port` — so the driver
         logged "no port configured" and the stick sat unused even though the
         privileged container had the device node. We set `zwave.port` to the
         device path the container sees (the value mounted at `mountPath:
         {{ZWAVE_DEVICE}}` in template.yml — privileged containers get the raw
         /dev/ttyACMx, not the /dev/serial/by-id symlink).

      2. `enableSoftReset: true` (zwave-js-ui's default) breaks 500-series /
         Gen5 controllers with "Serial API did not respond after soft-reset".
         We default it to false; the working live config had it false.

    We MERGE into the existing settings.json (zwave-js-ui owns it and rewrites
    it on boot) and only fill in fields the operator hasn't already set — an
    operator-chosen port/soft-reset in the UI is never overridden. Returns True
    iff the file was changed (caller restarts zwave-js so it takes effect)."""
    path = _zwave_settings_path()
    try:
        with open(path, encoding="utf-8") as fh:
            settings = json.load(fh)
    except (OSError, json.JSONDecodeError):
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    zwave = settings.get("zwave")
    if not isinstance(zwave, dict):
        zwave = {}

    changed = False
    if not zwave.get("port"):
        zwave["port"] = zwave_device
        log(f"   set zwave.port = {zwave_device} in settings.json.")
        changed = True
    else:
        log(f"   zwave.port already set ({zwave['port']}) — leaving untouched.")
    # enableSoftReset must be explicitly false for 500-series; only stamp it
    # when the operator hasn't set the key at all (don't fight a UI choice).
    if "enableSoftReset" not in zwave:
        zwave["enableSoftReset"] = False
        log("   set zwave.enableSoftReset = false (500-series / Gen5 controllers).")
        changed = True

    if not changed:
        return False
    settings["zwave"] = zwave
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        log(f"   ⚠️ Could not write {path}: {exc}. Set the Z-Wave port via the zwave-js-ui Settings tab.")
        return False
    return True


def restart_zwave_js() -> None:
    try:
        result = subprocess.run(
            ["podman", "container", "restart", ZWAVE_CONTAINER_NAME],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            log(f"   restarted {ZWAVE_CONTAINER_NAME} so the new settings take effect.")
            return
        stderr = result.stderr.strip()
        # First-deploy race: post-deploy ran before podman play kube
        # finished spawning the pod's containers. The container will
        # come up shortly and pick the env-var + file up on its first
        # boot, so no restart is needed — only flag genuine restart
        # failures.
        if "no such container" in stderr.lower() or "no container with name" in stderr.lower():
            log(f"   {ZWAVE_CONTAINER_NAME} not running yet — settings will apply when the pod brings it up.")
            return
        log(f"   ⚠️ podman restart {ZWAVE_CONTAINER_NAME} exited {result.returncode}: {stderr}")
        log("   New WS settings will load on next pod restart.")
    except (subprocess.SubprocessError, OSError) as exc:
        log(f"   ⚠️ Could not restart zwave-js: {exc}. Settings will apply on next pod restart.")


# ── auth_oidc custom component (#493) ────────────────────────────────────────

def _wait_ha_ready(timeout: float | None = None) -> bool:
    """Poll HA's root until it answers. HA returns HTTP 200 with the
    frontend HTML once the core is up; we don't care which auth state
    it's in, just that the HTTP layer answers. Returns False on
    timeout.

    The timeout + sleep interval are read from module constants at
    call time (not as default-arg values), so tests can monkey-patch
    `HA_READY_TIMEOUT` / `HA_READY_INTERVAL` to drop the loop into
    millisecond budgets."""
    budget = timeout if timeout is not None else HA_READY_TIMEOUT
    deadline = time.time() + budget
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{HA_API}/", timeout=5) as resp:
                if resp.status < 500:
                    return True
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(HA_READY_INTERVAL)
    return False


def _ha_config_dir() -> str:
    """Resolve the host-side path of HA's /config volume. The
    `home-assistant` pod mounts `{{DATA_DIR}}/home-assistant/homeassistant`
    onto `/config`; DATA_DIR is passed through to the post-deploy env."""
    base = env("DATA_DIR", "/mnt/data")
    return os.path.join(base, "home-assistant", "homeassistant")


# ── auth_oidc configuration.yaml self-heal (#1687) ───────────────────────────
#
# A HA backup-restore replaces ServiceBay's base configuration.yaml with the
# snapshot's own, which carries the user's content but NOT ServiceBay's
# `auth_oidc:` SSO block — so the "Sign in with Authelia" button disappears
# and SSO breaks. The trusted_proxies (`http:`) self-heal lives in TS
# (serviceLifecycle's runHomeAssistantHook), but auth_oidc needs the rendered
# HA_OIDC_SECRET / group / domain values, which only exist here in the
# post-deploy env. We re-append the block when the file has no `auth_oidc:`
# key — coexisting with the restored user config rather than overwriting it.


def _build_auth_oidc_block() -> str | None:
    """Render the auth_oidc YAML block from post-deploy env. Returns None
    when the OIDC secret is unset (manual / opted-out setup) so we never
    write a half-filled block."""
    secret = env("HA_OIDC_SECRET")
    domain = env("PUBLIC_DOMAIN")
    if not secret or not domain:
        return None
    admin_group = env("HA_OIDC_ADMIN_GROUP", "admins")
    user_group = env("HA_OIDC_USER_GROUP", "family")
    return "\n".join([
        "",
        "# Re-added by ServiceBay: OIDC SSO via the auth_oidc custom component.",
        "# ServiceBay re-appends this block on every deploy when the",
        "# `auth_oidc:` key is missing (e.g. after a HA backup-restore).",
        "auth_oidc:",
        "  client_id: homeassistant",
        f"  client_secret: {secret}",
        f"  discovery_url: https://auth.{domain}/.well-known/openid-configuration",
        "  features:",
        "    automatic_user_linking: true",
        "    automatic_person_creation: true",
        "  roles:",
        f'    admin: "{admin_group}"',
        f'    user:  "{user_group}"',
    ])


def ensure_auth_oidc_config_block() -> bool:
    """Append ServiceBay's auth_oidc block to configuration.yaml when it's
    absent (and the file already exists — first-install seeding is owned by
    the mustache deploy). Idempotent: a subsequent deploy finds the
    `auth_oidc:` key and leaves the file alone. Returns True iff the block
    was just appended (caller restarts HA so the route registers)."""
    cfg = os.path.join(_ha_config_dir(), "configuration.yaml")
    try:
        with open(cfg, encoding="utf-8") as fh:
            content = fh.read()
    except OSError:
        # No file yet → first-install path; the mustache deploy seeds it.
        return False
    if re.search(r"(?m)^auth_oidc:", content):
        log("   configuration.yaml already has auth_oidc: — leaving it alone.")
        return False
    block = _build_auth_oidc_block()
    if block is None:
        log("   HA_OIDC_SECRET / PUBLIC_DOMAIN unset — skipping auth_oidc re-seed.")
        return False
    try:
        with open(cfg, "a", encoding="utf-8") as fh:
            fh.write(block + "\n")
    except OSError as exc:
        log(f"   ⚠️ Could not re-add auth_oidc block to {cfg}: {exc}")
        return False
    log("   Re-added auth_oidc block to configuration.yaml (likely after a backup-restore).")
    return True


# ── HA onboarding + long-lived access token (OSCAR / #934) ───────────────────
#
# HA's `/api/onboarding` flow is browser-driven in the UI but the underlying
# REST endpoints accept headless POSTs. We drive them once on a fresh install
# so downstream templates (hermes, oscar-household) can authenticate with a
# real long-lived token instead of the random placeholder that `assemble`
# generates. Idempotent: if onboarding is already done OR the token file is
# already present, the steps are skipped.

HA_LONG_LIVED_TOKEN_PATH = "/.solaris-long-lived-token"  # joined with HA config dir
# Pre-rename names, newest-first. Already-onboarded boxes have a valid token at
# one of these legacy paths; we migrate it on disk so the deploy doesn't have to
# re-mint (and so downstream post-deploys that look for the new name keep working
# without creds). Two-hop chain: .oscar (OSCAR→Solilos #1769) → .solilos
# (Solilos→Solaris solbay#408) → .solaris.
HA_LEGACY_LONG_LIVED_TOKEN_PATHS = [
    "/.solilos-long-lived-token",
    "/.oscar-long-lived-token",
]
HA_CONTAINER_NAME = "home-assistant-homeassistant"
HA_CLIENT_ID = "http://127.0.0.1:8123/"


def _onboarding_state() -> dict[str, bool] | None:
    """Returns {step_name: done} for HA's onboarding steps, or None if the
    endpoint can't be reached. The `/api/onboarding` endpoint is public
    (no auth needed) by design."""
    try:
        with urllib.request.urlopen(f"{HA_API}/api/onboarding", timeout=10) as resp:
            steps = json.loads(resp.read())
        return {s["step"]: s["done"] for s in steps}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def _onboard_admin_user(username: str, password: str) -> str | None:
    """Create the HA admin user via /api/onboarding/users and exchange the
    returned auth_code for an access token. Returns the access_token, or
    None on failure. Pre-onboarding endpoint - no auth header needed."""
    body = json.dumps({
        "client_id": HA_CLIENT_ID,
        "name": "Solilos Admin",
        "username": username,
        "password": password,
        "language": "en",
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{HA_API}/api/onboarding/users",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            auth_code = json.loads(resp.read()).get("auth_code")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as e:
        log(f"   ⚠️ HA onboarding/users POST failed: {e}")
        return None
    if not auth_code:
        log("   ⚠️ HA onboarding/users returned no auth_code")
        return None
    # Exchange auth_code -> access_token via /auth/token (form-urlencoded).
    form = urllib.parse.urlencode({
        "client_id": HA_CLIENT_ID,
        "grant_type": "authorization_code",
        "code": auth_code,
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{HA_API}/auth/token",
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()).get("access_token")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as e:
        log(f"   ⚠️ HA /auth/token exchange failed: {e}")
        return None


def _complete_remaining_onboarding_steps(access_token: str) -> None:
    """Complete core_config + analytics + integration onboarding steps so
    HA stops treating itself as freshly-installed. Best-effort - a failure
    here only means HA's UI nags the operator on first login."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    for step, body in (
        ("core_config", b"{}"),
        ("analytics", b"{}"),
        ("integration", json.dumps({"client_id": HA_CLIENT_ID}).encode("utf-8")),
    ):
        try:
            req = urllib.request.Request(
                f"{HA_API}/api/onboarding/{step}",
                data=body,
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10):
                pass
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            log(f"   ⚠️ HA onboarding/{step} POST failed: {e}")


def _mint_long_lived_token(access_token: str) -> str | None:
    """HA's long-lived access token API is WebSocket-only. Run a tiny
    websockets client inside HA's own container - it ships the
    `websockets` library as a dependency, so we don't need anything
    extra on the host. Returns the token string, or None on failure."""
    script = (
        "import asyncio, json, os, sys, websockets\n"
        "async def main():\n"
        "    async with websockets.connect('ws://127.0.0.1:8123/api/websocket') as ws:\n"
        "        await ws.recv()  # auth_required hello\n"
        "        await ws.send(json.dumps({'type': 'auth', 'access_token': os.environ['ACCESS']}))\n"
        "        a = json.loads(await ws.recv())\n"
        "        if a.get('type') != 'auth_ok':\n"
        "            sys.stderr.write('auth fail: ' + json.dumps(a)); sys.exit(1)\n"
        "        await ws.send(json.dumps({'id': 1, 'type': 'auth/long_lived_access_token', 'client_name': 'solilos-hermes', 'lifespan': 3650}))\n"
        "        r = json.loads(await ws.recv())\n"
        "        if not r.get('success'):\n"
        "            sys.stderr.write('mint fail: ' + json.dumps(r)); sys.exit(1)\n"
        "        print(r['result'])\n"
        "asyncio.run(main())\n"
    )
    try:
        result = subprocess.run(
            ["podman", "exec", "-e", f"ACCESS={access_token}", HA_CONTAINER_NAME, "python3", "-c", script],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (subprocess.SubprocessError, OSError) as e:
        log(f"   ⚠️ HA long-lived token podman exec failed: {e}")
        return None
    if result.returncode != 0:
        log(f"   ⚠️ HA long-lived token mint exited {result.returncode}: {result.stderr.strip()}")
        return None
    token = result.stdout.strip()
    return token or None


def _token_authenticates(token: str) -> bool:
    """True iff `token` is accepted by HA's authenticated API. After a
    wipe-configs reinstall the persisted token file may survive in HA's
    kept config dir but the matching refresh-token row in HA's auth store
    could be gone (or the file is stale from an earlier HA instance) — a
    401 there is exactly the #1505 symptom. We probe /api/ (the lightest
    authenticated endpoint) and treat 401/403 as 'must re-mint'."""
    if not token:
        return False
    try:
        req = urllib.request.Request(
            f"{HA_API}/api/",
            headers={"Authorization": f"Bearer {token}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        return e.code == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        # Network blip ≠ bad token; don't churn the token on a transient.
        # Returning True keeps an existing token in place; the health check
        # will catch a genuinely-dead one on its own schedule.
        return True


def _login_existing_admin(username: str, password: str) -> str | None:
    """Authenticate an already-existing HA admin via the login_flow API and
    exchange the result for an access token. Used to re-mint a long-lived
    token after a wipe-configs reinstall, where HA's user already exists
    (so onboarding/users would 409) but ServiceBay lost the token. Returns
    the short-lived access_token, or None on failure."""
    start = json.dumps({
        "client_id": HA_CLIENT_ID,
        "handler": ["homeassistant", None],
        "redirect_uri": HA_CLIENT_ID,
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{HA_API}/auth/login_flow",
            data=start,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            flow_id = json.loads(resp.read()).get("flow_id")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as e:
        log(f"   ⚠️ HA /auth/login_flow start failed: {e}")
        return None
    if not flow_id:
        log("   ⚠️ HA /auth/login_flow returned no flow_id")
        return None

    step = json.dumps({
        "client_id": HA_CLIENT_ID,
        "username": username,
        "password": password,
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{HA_API}/auth/login_flow/{urllib.parse.quote(flow_id)}",
            data=step,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as e:
        log(f"   ⚠️ HA /auth/login_flow step failed: {e}")
        return None
    auth_code = result.get("result")
    if result.get("type") != "create_entry" or not auth_code:
        log("   ⚠️ HA login_flow did not yield an auth code "
            "(wrong OSCAR_HA_ADMIN_PASSWORD, or the admin user differs?).")
        return None

    form = urllib.parse.urlencode({
        "client_id": HA_CLIENT_ID,
        "grant_type": "authorization_code",
        "code": auth_code,
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{HA_API}/auth/token",
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()).get("access_token")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as e:
        log(f"   ⚠️ HA /auth/token exchange (login) failed: {e}")
        return None


def _mint_and_persist_from_access_token(access_token: str, username: str) -> bool:
    """Mint a fresh long-lived token from a short-lived access token and
    persist it. Shared tail of both the fresh-onboarding and the
    re-mint-after-wipe paths. Returns True on success."""
    long_lived = _mint_long_lived_token(access_token)
    if not long_lived:
        return False
    path = _persist_long_lived_token(long_lived)
    if path:
        log(f"✅ HA long-lived token (re)provisioned for '{username}' at {path}.")
        return True
    return False


def _persist_long_lived_token(token: str) -> str | None:
    """Write the long-lived token under HA's config dir so downstream
    post-deploys (hermes, oscar-household) can pick it up via a fixed
    path. Returns the full path on success, None on failure."""
    target = os.path.join(_ha_config_dir(), HA_LONG_LIVED_TOKEN_PATH.lstrip("/"))
    try:
        with open(target, "w", encoding="utf-8") as f:
            f.write(token + "\n")
        os.chmod(target, 0o644)
    except OSError as e:
        log(f"   ⚠️ Could not persist HA long-lived token at {target}: {e}")
        return None
    return target


def report_kept_data_state() -> None:
    """Distinguish the two #1512 cases out loud so the post-deploy log says
    which one happened, instead of leaving the operator guessing why HA
    looks bare after a wipe-configs reinstall:

      (1) kept-data present → integration reconciliation (token + Z-Wave,
          handled below) re-establishes wiring against the existing data.
      (2) no kept data → a genuinely fresh first install; nothing to
          reconcile (and, on a reinstall, a data-keep regression worth a
          loud warning since service data should never be lost).

    Read-only; never aborts the deploy."""
    config_dir = _ha_config_dir()
    # HA writes .storage/ + configuration.yaml as soon as it has ever run.
    ha_has_data = os.path.isfile(os.path.join(config_dir, "configuration.yaml")) or os.path.isdir(
        os.path.join(config_dir, ".storage")
    )
    zwave_dir = _zwave_store_dir()
    # zwave-js-ui persists its node DB + network keys under store/; the
    # presence of settings.json (or any .jsonl node cache) means a mesh
    # was previously built and its keys are kept.
    zwave_has_data = os.path.isdir(zwave_dir) and any(
        os.path.exists(os.path.join(zwave_dir, f)) for f in ("settings.json", "nodes.json")
    )
    if ha_has_data:
        log(f"Home Assistant kept-data found at {config_dir} — reconciling integrations against it (#1512).")
        if zwave_has_data:
            log(f"   Z-Wave node DB / keys kept at {zwave_dir} — re-wiring against the existing mesh.")
    else:
        log(f"No existing Home Assistant data at {config_dir} — treating as a fresh first install.")


# ── orphaned config-entry helper detection (#1686) ───────────────────────────
#
# A HA backup-restore brings back `core.entity_registry` stubs for UI-created
# helpers (platform integration/template/utility_meter/derivative/threshold/
# group) but NOT always their backing rows in `core.config_entries` — the
# entities then sit `unavailable` and dashboards (Energy, areas) break
# silently. We can't reliably re-create a config entry from a registry stub
# (the entry holds option data the stub doesn't), so we DETECT + REPORT: scan
# the registry for helper-platform entities whose `config_entry_id` has no
# matching config entry and surface a worklist for the operator. Read-only;
# never mutates HA state or aborts the deploy.

# Helper platforms that are normally backed by a UI config entry. A registry
# stub on one of these with a dangling config_entry_id is an orphan.
HELPER_PLATFORMS = frozenset({
    "integration", "template", "utility_meter", "derivative", "threshold", "group",
})


def _load_storage_json(name: str) -> dict | None:
    """Load <config>/.storage/<name> and return its `data` object, or None
    when the file is missing/unreadable/malformed."""
    path = os.path.join(_ha_config_dir(), ".storage", name)
    try:
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    data = blob.get("data")
    return data if isinstance(data, dict) else None


def find_orphaned_helpers() -> list[dict[str, str]]:
    """Return the helper entities whose backing config entry didn't restore.

    Each item is {entity_id, platform, config_entry_id}. Returns [] when the
    registry can't be read (fresh install / no restore) or nothing is
    orphaned. Pure: takes no args, reads only HA's .storage files."""
    registry = _load_storage_json("core.entity_registry")
    if not registry:
        return []
    entries = _load_storage_json("core.config_entries") or {}
    known_entry_ids = {
        e.get("entry_id")
        for e in entries.get("entries", [])
        if isinstance(e, dict) and e.get("entry_id")
    }
    orphans: list[dict[str, str]] = []
    for ent in registry.get("entities", []):
        if not isinstance(ent, dict):
            continue
        platform = ent.get("platform")
        if platform not in HELPER_PLATFORMS:
            continue
        ce_id = ent.get("config_entry_id")
        # A helper entity always references a config entry; if it points at
        # one that's not in core.config_entries, the backing entry didn't
        # restore. (A None config_entry_id on a helper platform is the same
        # broken state — the entry it needed is simply gone.)
        if ce_id is None or ce_id not in known_entry_ids:
            orphans.append({
                "entity_id": ent.get("entity_id", "<unknown>"),
                "platform": str(platform),
                "config_entry_id": str(ce_id) if ce_id is not None else "<missing>",
            })
    return orphans


def report_orphaned_helpers() -> None:
    """Log a worklist of helpers whose backing config entry didn't restore
    (#1686) so the operator knows exactly which to re-create, instead of
    discovering broken Energy/area dashboards later. Best-effort; read-only."""
    try:
        orphans = find_orphaned_helpers()
    except Exception as exc:  # never let a report abort the deploy
        log(f"   ⚠️ Orphaned-helper scan failed: {exc}")
        return
    if not orphans:
        return
    log(f"⚠️ {len(orphans)} Home Assistant helper(s) did not fully restore — their "
        "backing config entry is missing, so they will show as `unavailable`:")
    for o in orphans:
        log(f"     • {o['entity_id']} (platform: {o['platform']})")
    log("   Re-create each from Settings → Devices & Services → Helpers "
        "(the entity history is preserved; only the helper definition needs re-adding).")


def configure_oscar_ha_onboarding() -> None:
    """When OSCAR_HA_ADMIN_USERNAME and OSCAR_HA_ADMIN_PASSWORD are set,
    walk HA's onboarding API on a fresh install and mint a long-lived
    access token for hermes/oscar-household. No-op when:
      - either variable is blank (operator opted out / manual setup)
      - the onboarding user step is already done (idempotent re-run)
      - the long-lived token file is already present (already done)"""
    username = env("OSCAR_HA_ADMIN_USERNAME")
    password = env("OSCAR_HA_ADMIN_PASSWORD")
    if not username or not password:
        log("OSCAR_HA_ADMIN_USERNAME / _PASSWORD not set — skipping auto-onboarding.")
        return
    token_file = os.path.join(_ha_config_dir(), HA_LONG_LIVED_TOKEN_PATH.lstrip("/"))

    # One-time migration for the rename chain (OSCAR→Solilos #1769,
    # Solilos→Solaris solbay#408). A box onboarded before a rename has a *valid*
    # token at one of the legacy paths. If the new file is absent but a legacy
    # one is present, move it across so the existing token is reused (no re-mint,
    # works without admin creds) and downstream post-deploys that read the new
    # name keep authenticating. Newest-first so a two-hop box picks .solilos.
    if not os.path.exists(token_file):
        for legacy_path in HA_LEGACY_LONG_LIVED_TOKEN_PATHS:
            legacy_token_file = os.path.join(_ha_config_dir(), legacy_path.lstrip("/"))
            if os.path.exists(legacy_token_file):
                try:
                    os.rename(legacy_token_file, token_file)
                    log(f"   Migrated legacy HA token {legacy_token_file} → {token_file} (rename chain).")
                except OSError as e:
                    log(f"   ⚠️ Could not migrate legacy HA token to {token_file}: {e}")
                break

    # Reconcile an existing token first (#1505). A wipe-configs reinstall can
    # leave a token file behind in HA's kept config dir whose refresh-token
    # row no longer exists in HA's auth store → a 401 on every authenticated
    # call. Validate it; only short-circuit when it actually authenticates.
    if os.path.exists(token_file):
        try:
            with open(token_file, encoding="utf-8") as f:
                existing = f.read().strip()
        except OSError:
            existing = ""
        if _token_authenticates(existing):
            log(f"✅ HA long-lived token at {token_file} still authenticates — nothing to reconcile.")
            return
        log("   Persisted HA long-lived token no longer authenticates (wipe-configs reinstall) — re-provisioning.")

    state = _onboarding_state()
    if state is None:
        log("   ⚠️ Could not reach HA /api/onboarding — skipping auto-onboarding.")
        return

    if state.get("user") is True:
        # HA's data was kept (user already onboarded) but ServiceBay lost the
        # token. Re-mint by logging in as the existing admin instead of
        # creating a second user — the LLDAP-FORCE_RESET-style self-heal for
        # the HA token (#1505). Onboarding steps are already done; skip them.
        log("Re-provisioning HA long-lived token from kept data (existing admin, no new user)...")
        access_token = _login_existing_admin(username, password)
        if not access_token:
            log("   HA admin already exists but auto-login failed — mint a long-lived token via the "
                "HA UI (Settings → Security → Long-lived access tokens) or set OSCAR_HA_ADMIN_USERNAME='' to silence this.")
            return
        _mint_and_persist_from_access_token(access_token, username)
        return

    log("Auto-onboarding HA admin user for OSCAR (no operator browser step required)...")
    access_token = _onboard_admin_user(username, password)
    if not access_token:
        return
    _complete_remaining_onboarding_steps(access_token)
    if _mint_and_persist_from_access_token(access_token, username):
        log(f"✅ HA admin '{username}' created + long-lived token persisted.")


def _strip_first_component(member_path: str) -> str | None:
    """Tarballs from GitHub release tags are wrapped in a top-level
    directory like `hass-oidc-auth-0.6.0/`. We unwrap that prefix and
    then keep only entries under `custom_components/auth_oidc/`."""
    parts = member_path.split("/")
    if len(parts) < 2:
        return None
    rest = parts[1:]
    if len(rest) < 2 or rest[0] != "custom_components" or rest[1] != "auth_oidc":
        return None
    return "/".join(rest[2:])  # path inside auth_oidc/


def _extract_auth_oidc(tar_path: str, target_dir: str) -> None:
    """Extract only the `custom_components/auth_oidc/` subtree from
    the release tarball into `target_dir`. Replaces the directory
    atomically so a half-extracted tree on disk never confuses HA."""
    staging = tempfile.mkdtemp(prefix="sb_auth_oidc_")
    try:
        with tarfile.open(tar_path, "r:gz") as tf:
            for member in tf.getmembers():
                if not (member.isfile() or member.isdir()):
                    continue
                rel = _strip_first_component(member.name)
                if rel is None:
                    continue
                out_path = os.path.join(staging, rel) if rel else staging
                if member.isdir():
                    os.makedirs(out_path, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(out_path) or staging, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:
                    continue
                with open(out_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        # Atomic swap: replace target_dir with the staging tree.
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)
        shutil.move(staging, target_dir)
    finally:
        if os.path.isdir(staging):
            shutil.rmtree(staging, ignore_errors=True)


def install_auth_oidc(version: str) -> bool:
    """Idempotent install. Skips when `.sb_installed_version` already
    matches. Returns True iff the on-disk component was added or
    upgraded (the caller restarts HA only when something changed)."""
    config_dir = _ha_config_dir()
    target = os.path.join(config_dir, "custom_components", "auth_oidc")
    stamp = os.path.join(target, ".sb_installed_version")

    try:
        if os.path.isfile(stamp):
            with open(stamp, encoding="utf-8") as fh:
                current = fh.read().strip()
            if current == version:
                log(f"   auth_oidc {version} already installed — skipping.")
                return False
            log(f"   Upgrading auth_oidc: {current} → {version}.")
        else:
            log(f"   Installing auth_oidc {version}.")
    except OSError as exc:
        log(f"   ⚠️ Could not read existing version stamp: {exc}. Proceeding with install.")

    url = f"https://github.com/{HA_OIDC_REPO}/archive/refs/tags/{version}.tar.gz"
    log(f"   Downloading {url}")
    tar_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
            tar_path = tmp.name
        urllib.request.urlretrieve(url, tar_path)  # noqa: S310 (pinned URL)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        _extract_auth_oidc(tar_path, target)
    except (urllib.error.URLError, OSError, tarfile.TarError) as exc:
        log(f"   ⚠️ auth_oidc install failed: {exc}")
        log(f"   Manual recovery: download {url} and unpack `custom_components/auth_oidc/` into {target}.")
        return False
    finally:
        if tar_path and os.path.isfile(tar_path):
            try:
                os.unlink(tar_path)
            except OSError:
                pass

    try:
        with open(stamp, "w", encoding="utf-8") as fh:
            fh.write(version + "\n")
    except OSError as exc:
        log(f"   ⚠️ Could not write version stamp ({exc}). Future runs will re-download.")

    log(f"   ✅ auth_oidc {version} installed at {target}")
    return True


def restart_home_assistant() -> bool:
    """Restart just the HA container so the new custom component is
    loaded. Z-Wave JS / Matter Server stay up — they're independent
    containers in the same pod."""
    try:
        result = subprocess.run(
            ["podman", "container", "restart", HA_CONTAINER_NAME],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            log(f"   Restarted {HA_CONTAINER_NAME}.")
            return True
        log(f"   ⚠️ `podman container restart {HA_CONTAINER_NAME}` exited {result.returncode}: {result.stderr.strip()}")
        return False
    except (subprocess.SubprocessError, OSError) as exc:
        log(f"   ⚠️ Could not restart HA: {exc}")
        return False


def verify_oidc_endpoint(timeout: float = 90.0) -> bool:
    """After the restart, poll HA's `/auth/oidc/welcome` until it
    answers. The integration registers the path on startup; a 404
    means the component didn't load (manifest mismatch, HA version
    drift). We accept 200, 302 (redirect to Authelia), and 401 — all
    of which prove the route exists."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"{HA_API}/auth/oidc/welcome", method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status in (200, 302, 401):
                    log(f"   ✅ /auth/oidc/welcome answered HTTP {resp.status}.")
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code in (200, 302, 401):
                log(f"   ✅ /auth/oidc/welcome answered HTTP {exc.code}.")
                return True
            if exc.code == 404:
                # Integration not loaded yet — keep polling.
                pass
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(3)
    return False


def configure_auth_oidc() -> None:
    version = env("HA_OIDC_AUTH_VERSION", "v1.1.0").strip()
    if not version:
        log("⚠️  HA_OIDC_AUTH_VERSION is empty — skipping auth_oidc install.")
        return

    log(f"Configuring Home Assistant OIDC via auth_oidc {version}...")
    log("   Waiting for Home Assistant to come up...")
    if not _wait_ha_ready():
        log(f"   ⚠️ HA did not respond within {HA_READY_TIMEOUT}s. Skipping auth_oidc install — re-run the deploy once HA is up.")
        return  # noqa: RET502 — explicit early-out for the unreachable path

    # Self-heal the auth_oidc config block first (#1687): a backup-restore
    # can leave configuration.yaml without it. If we re-add it, force the
    # restart path below so HA reloads and re-registers /auth/oidc/*.
    oidc_block_readded = ensure_auth_oidc_config_block()

    changed = install_auth_oidc(version) or oidc_block_readded
    if not changed:
        # Already at the pinned version — but configuration.yaml might
        # have been edited between deploys, so still verify the
        # endpoint responds rather than declaring victory blindly.
        if verify_oidc_endpoint(timeout=30.0):
            log("   ✅ OIDC endpoint already serving — no restart needed.")
        else:
            log("   ⚠️ OIDC endpoint is not responding even though the component is installed. Check Home Assistant logs.")
        return

    if not restart_home_assistant():
        log("   Manual recovery: `podman container restart home-assistant-homeassistant` once you have shell access.")
        return

    log("   Waiting for HA to restart and the OIDC route to register...")
    if verify_oidc_endpoint():
        log("✅ Home Assistant OIDC is live. The login screen now shows a `Sign in with Authelia` button.")
    else:
        log("⚠️ Home Assistant restarted but /auth/oidc/welcome did not answer in time.")
        log("   Check `podman logs home-assistant-homeassistant` for auth_oidc errors (manifest mismatch / HA major-version drift).")


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    zwave_device = env("ZWAVE_DEVICE")

    if not zwave_device:
        # ZWAVE_DEVICE is lost on a wipe-configs reinstall (#1511). Re-detect
        # the stick on the box so the kept node DB + keys re-attach without an
        # operator browser step. Only auto-picks an unambiguous single stick.
        detected = _detect_single_usb_serial_device()
        if detected:
            zwave_device = detected
            log(f"ZWAVE_DEVICE unset but a single USB-serial stick is present — re-detected {detected}.")

    zwave_settings_changed = False
    if zwave_device:
        log(f"Z-Wave stick configured ({zwave_device}) — ensuring host udev permissions...")
        ensure_udev_rule(zwave_device)
        log("✅ Z-Wave JS will have device access after each system boot.")
        # Auto-configure the serial port + soft-reset policy so the driver
        # inits with no manual web-UI step (#1594). Without this, zwave-js-ui
        # logs "no port configured" and the stick sits unused.
        if ensure_zwave_port_settings(zwave_device):
            zwave_settings_changed = True
    else:
        log("No ZWAVE_DEVICE set and no single USB-serial stick detected — skipping udev rule + port config.")

    log(f"Seeding Z-Wave JS WS server config (port {ZWAVEJS_WS_PORT})...")
    if ensure_zwave_external_settings():
        zwave_settings_changed = True
    if zwave_settings_changed:
        restart_zwave_js()
    log(f"✅ Connect Home Assistant to Z-Wave JS: ws://localhost:{ZWAVEJS_WS_PORT}")

    configure_auth_oidc()

    # wipe-configs reconciliation: HA's data is kept but the config that
    # wired it (token, ZWAVE_DEVICE, integrations) lives in ServiceBay's
    # wiped config. Report which case we're in (#1512), then re-provision
    # the HA long-lived token from the kept data (#1505).
    report_kept_data_state()
    # Surface helpers whose backing config entry didn't restore (#1686) so the
    # operator gets an explicit worklist instead of silently-broken dashboards.
    report_orphaned_helpers()
    if _wait_ha_ready():
        configure_oscar_ha_onboarding()
    else:
        log("⚠️ HA did not become reachable in time — skipping OSCAR onboarding.")

    # ── Health check ─────────────────────────────────────────────────────────
    # Worked example for docs/TEMPLATE_AUTHORING.md § Health checks.
    # The auto-created service:home-assistant check catches "systemd thinks
    # HA is down". The HTTP check below catches "HA's API is unreachable
    # despite the process running" — login-loop after a bad core upgrade,
    # YAML config-reload error that wedged the API, etc. Best-effort: a
    # non-200 here doesn't block the install.
    sb_api = env("SB_API_URL", "http://localhost:3000")
    sb_token = env("SB_API_TOKEN")
    body = json.dumps({
        "id": "home-assistant-api",
        "name": "Home Assistant API",
        "type": "http",
        "target": f"{HA_API}/",
        "interval": 60,
        "enabled": True,
        "httpConfig": {"expectedStatus": 200},
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if sb_token:
        headers["X-SB-Internal-Token"] = sb_token
    try:
        req = urllib.request.Request(f"{sb_api}/api/health/checks", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                log(f"✅ Registered HTTP health check 'home-assistant-api' against {HA_API}/")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        log(f"⚠️ Could not register HTTP health check: {e}. The auto-created service:home-assistant check still applies.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
