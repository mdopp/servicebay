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

    changed = install_auth_oidc(version)
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

    if zwave_device:
        log(f"Z-Wave stick configured ({zwave_device}) — ensuring host udev permissions...")
        ensure_udev_rule(zwave_device)
        log("✅ Z-Wave JS will have device access after each system boot.")
    else:
        log("No ZWAVE_DEVICE set — skipping udev rule.")

    log(f"Seeding Z-Wave JS WS server config (port {ZWAVEJS_WS_PORT})...")
    if ensure_zwave_external_settings():
        restart_zwave_js()
    log(f"✅ Connect Home Assistant to Z-Wave JS: ws://localhost:{ZWAVEJS_WS_PORT}")

    configure_auth_oidc()

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
