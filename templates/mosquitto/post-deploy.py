#!/usr/bin/env python3
"""
post-deploy hook for the `mosquitto` MQTT broker.

The broker's username and password are auto-generated `type: "secret"`
variables, and they are the only way to connect (anonymous access is off).
So the one job here is surfacing them: the operator has to type them into
Home Assistant and into every device, and they never appear anywhere else.

Also prints the two addresses that actually work, because "which host do I
enter?" is the question that eats an evening:
  - LAN devices  -> the box's LAN address
  - on-box containers -> host.containers.internal (ADR 0007 Decision 3)

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sys


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def main() -> int:
    username = env("MQTT_USERNAME")
    password = env("MQTT_PASSWORD")
    port = env("MQTT_PORT", "1883")

    if not username or not password:
        # The initContainer refuses to start the broker in this state, so say
        # why rather than leaving the operator to read pod logs.
        log(
            "MQTT_USERNAME/MQTT_PASSWORD missing — the broker will not start. "
            "Anonymous access is deliberately off; re-run the wizard with both set."
        )
        return 0

    # LAN_IP is best-effort server-side context; HOST is whatever the operator
    # is browsing ServiceBay through. Either is a usable device-side address.
    lan = env("LAN_IP") or env("HOST", "<box-lan-ip>")

    log(f"📡 MQTT broker is up on port {port}. Anonymous access is OFF — every client needs the credentials below.")
    log(f"   Devices on the LAN (locks, plugs, sensors, Zigbee bridges): host {lan}, port {port}")
    log(f"   Home Assistant and other containers on this box:            host host.containers.internal, port {port}")
    log("   No TLS: use it on a network you trust, and don't reuse this password elsewhere (see the template README).")

    emit_credential(
        service="MQTT Broker (Mosquitto)",
        url=f"mqtt://{lan}:{port}",
        username=username,
        password=password,
        importance="critical",
        notes=(
            "Broker credentials. Enter them in Home Assistant's MQTT integration "
            f"(host host.containers.internal, port {port}) and in every device that "
            f"publishes here (host {lan}, port {port}). Anonymous access is off, so "
            "losing these means re-generating them in the wizard and re-entering them "
            "on every device."
        ),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
