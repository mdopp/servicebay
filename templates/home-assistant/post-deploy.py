#!/usr/bin/env python3
"""
post-deploy hook for the `home-assistant` stack.

When ZWAVE_DEVICE is set: writes a udev rule that grants world read/write
access to the Z-Wave USB stick. This is required for rootless Podman to pass
the device into the zwave-js container — in a rootless user-namespace, the
device appears as nobody:nobody inside the container (host root UID/GID is not
mapped), so mode 0666 is the only way to make it accessible without running the
container process as root.

The rule is written to /etc/udev/rules.d/99-zwave.rules via sudo and fires on
every boot when the device is detected, so it survives reboots, re-installs,
and hardware moves to a different machine.

Idempotent: re-running with the same device is a no-op if the rule file
already contains the correct content.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

UDEV_RULE_DIR = "/etc/udev/rules.d"
UDEV_RULE_FILE = "99-zwave.rules"


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def _device_kernel_pattern(device_path: str) -> str:
    """Return a udev KERNEL glob for the given device path.

    /dev/ttyACM0 -> ttyACM*
    /dev/ttyUSB0 -> ttyUSB*
    """
    name = os.path.basename(device_path)
    return re.sub(r"\d+$", "*", name)


def ensure_udev_rule(zwave_device: str) -> None:
    pattern = _device_kernel_pattern(zwave_device)
    rule_line = f'SUBSYSTEM=="tty", KERNEL=="{pattern}", MODE="0666"\n'
    rule_path = os.path.join(UDEV_RULE_DIR, UDEV_RULE_FILE)

    # Idempotent: skip if the file already has the right content.
    try:
        if os.path.isfile(rule_path) and open(rule_path).read() == rule_line:
            log(f"   udev rule already in place ({rule_path}) — skipping.")
            _reload_udev(zwave_device, rule_path)
            return
    except OSError:
        pass

    # Write the rule file via sudo (core user on Fedora CoreOS has NOPASSWD sudo).
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
        log(f"   Run this once manually to fix device permissions permanently:")
        log(f"     echo '{rule_line.strip()}' | sudo tee {rule_path}")
        log(f"     sudo udevadm control --reload-rules")
        return

    _reload_udev(zwave_device, rule_path)


def _reload_udev(zwave_device: str, rule_path: str) -> None:
    """Reload udev rules and trigger the device so permissions apply immediately."""
    try:
        subprocess.run(
            ["sudo", "udevadm", "control", "--reload-rules"],
            check=True,
            capture_output=True,
        )
        if os.path.exists(zwave_device):
            subprocess.run(
                ["sudo", "udevadm", "trigger", zwave_device],
                check=True,
                capture_output=True,
            )
        log("   udev rules reloaded — permissions will be applied on every boot.")
    except Exception as exc:
        log(f"   ⚠️  udevadm reload failed: {exc}. Permissions will apply on next reboot.")


def main() -> int:
    zwave_device = env("ZWAVE_DEVICE")

    if zwave_device:
        log(f"Z-Wave stick configured ({zwave_device}) — ensuring host udev permissions...")
        ensure_udev_rule(zwave_device)
        log("✅ Z-Wave JS will have access to the device after each system boot.")
    else:
        log("No ZWAVE_DEVICE set — skipping udev rule (can be added later via re-deploy).")

    return 0


if __name__ == "__main__":
    sys.exit(main())
