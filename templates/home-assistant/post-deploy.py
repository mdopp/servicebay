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

  2. **Z-Wave JS WS port** — configures the Z-Wave JS UI Home Assistant
     WebSocket server to port 3001 (NPM's admin UI occupies port 3000 on the
     same hostNetwork pod, so 3000 is always taken). Waits for Z-Wave JS UI to
     be up on port 8091, then PATCHes gateway.wsServer + gateway.wsServerPort
     via the REST API. Idempotent — skips if already correct.

Idempotent overall: safe to re-run on every deploy.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

UDEV_RULE_DIR = "/etc/udev/rules.d"
UDEV_RULE_FILE = "99-zwave.rules"

ZWAVEJS_API = "http://127.0.0.1:8091"
ZWAVEJS_WS_PORT = 3001
ZWAVEJS_READY_TIMEOUT = 60.0
ZWAVEJS_READY_INTERVAL = 2.0
REQUEST_TIMEOUT = 10.0


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

def _request(method: str, url: str, payload: object | None = None) -> tuple[int, object | None]:
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:  # pylint: disable=broad-except
            return e.code, None
    except Exception:  # pylint: disable=broad-except
        return 0, None


def _wait_zwavejs_ready() -> bool:
    deadline = time.time() + ZWAVEJS_READY_TIMEOUT
    while time.time() < deadline:
        code, _ = _request("GET", f"{ZWAVEJS_API}/api/health")
        if code == 200:
            return True
        time.sleep(ZWAVEJS_READY_INTERVAL)
    return False


def configure_ws_port() -> None:
    log(f"   Waiting for Z-Wave JS UI (port 8091)...")
    if not _wait_zwavejs_ready():
        log("   ⚠️  Z-Wave JS UI not ready in time.")
        log(f"   Set WS port manually: Settings → Home Assistant → WS Server Port → {ZWAVEJS_WS_PORT}")
        return

    code, data = _request("GET", f"{ZWAVEJS_API}/api/settings")
    if code != 200 or not isinstance(data, dict):
        log(f"   ⚠️  GET /api/settings failed (HTTP {code}). Set WS port manually.")
        return

    # The settings object may be top-level or wrapped in a "settings" key.
    settings = data.get("settings", data)
    gateway = settings.get("gateway", {})

    if gateway.get("wsServer") is True and gateway.get("wsServerPort") == ZWAVEJS_WS_PORT:
        log(f"   Z-Wave JS WS server already on port {ZWAVEJS_WS_PORT} — skipping.")
        return

    gateway["wsServer"] = True
    gateway["wsServerPort"] = ZWAVEJS_WS_PORT
    settings["gateway"] = gateway

    post_body = {"settings": settings} if "settings" in data else settings
    code2, _ = _request("POST", f"{ZWAVEJS_API}/api/settings", post_body)
    if code2 in (200, 201, 204):
        log(f"   ✅ Z-Wave JS WS server set to port {ZWAVEJS_WS_PORT}.")
    else:
        log(f"   ⚠️  POST /api/settings failed (HTTP {code2}). Set WS port manually.")


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    zwave_device = env("ZWAVE_DEVICE")

    if zwave_device:
        log(f"Z-Wave stick configured ({zwave_device}) — ensuring host udev permissions...")
        ensure_udev_rule(zwave_device)
        log("✅ Z-Wave JS will have device access after each system boot.")

        log(f"Configuring Z-Wave JS WS server port ({ZWAVEJS_WS_PORT})...")
        configure_ws_port()
        log(f"✅ Connect Home Assistant to Z-Wave JS: ws://localhost:{ZWAVEJS_WS_PORT}")
    else:
        log("No ZWAVE_DEVICE set — skipping udev rule and WS port config.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
