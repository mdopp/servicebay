#!/usr/bin/env python3
"""
post-deploy hook for the `mosquitto` MQTT broker.

The broker's username and password are auto-generated `type: "secret"`
variables, and they are the only way to connect (anonymous access is off).
So the first job here is surfacing them: the operator has to type them into
every device, and they never appear anywhere else.

Also prints the two addresses that actually work, because "which host do I
enter?" is the question that eats an evening:
  - LAN devices  -> the box's LAN address
  - on-box containers -> host.containers.internal (ADR 0007 Decision 3)

The second job (#2578) is Home Assistant: if HA is installed on this box, the
MQTT integration is set up here instead of by hand, and a later password
rotation is carried over to it. See the section comment further down for why
that goes through HA's config-flow API and never through its .storage files.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


# ── Home Assistant: wire the broker up instead of leaving it to the operator ──
#
# WHY THE CONFIG-FLOW API AND NOT `.storage` (the ticket asks for this to be
# justified, #2578):
#
#   Home Assistant keeps integration entries in `<config>/.storage/
#   core.config_entries`. That file is *not* a configuration file — it is the
#   serialised form of objects a running HA holds in memory and rewrites on its
#   own schedule. An entry appended underneath a running instance is overwritten
#   at the next save at best, and a malformed one stops HA from starting at
#   worst. It is the classic way to break an HA install.
#
#   `POST /api/config/config_entries/flow` is the *same* endpoint HA's own
#   frontend posts to when a human fills in Settings → Devices & Services →
#   MQTT. HA validates the input against the integration's own schema, opens a
#   real connection to the broker before accepting it, writes the entry itself,
#   and reloads the integration. Nothing here knows the file format, so nothing
#   here can corrupt it — the worst failure is HA answering "no", which we
#   report and move on.
#
#   The flow is filled in from the form HA hands back (`data_schema`), not from
#   a payload hard-coded to one HA version: the credentials are laid over HA's
#   own defaults and suggested values. On a reconfigure that means every setting
#   the operator made (TLS, transport, keepalive, client id) is carried through
#   untouched, and on an HA whose form has different fields we still send a form
#   it accepts.

HA_API = "http://127.0.0.1:8123"
# HA's pod mounts `{{DATA_DIR}}/home-assistant/homeassistant` onto /config —
# the same path templates/home-assistant/post-deploy.py resolves.
HA_CONFIG_SUBPATH = ("home-assistant", "homeassistant")
# The long-lived admin token HA's own post-deploy mints and persists, newest
# name first. The older names are still on boxes that were onboarded before the
# renames and have not re-deployed HA since (see HA_LEGACY_LONG_LIVED_TOKEN_PATHS
# in templates/home-assistant/post-deploy.py).
HA_TOKEN_FILENAMES = (
    ".solaris-long-lived-token",
    ".solilos-long-lived-token",
    ".oscar-long-lived-token",
)
# ADR 0007 Decision 3: on-box containers address each other by this name, never
# by a LAN IP that a router hands out differently after a reinstall.
HA_BROKER_HOST = "host.containers.internal"
HA_REQUEST_TIMEOUT = 20.0
HA_READY_ATTEMPTS = 10
HA_READY_INTERVAL = 3.0
# Fields HA marks required but gives no default or suggestion for. They only
# apply to a *fresh* entry — on a reconfigure HA suggests the entry's current
# values and those win, so an operator's TLS setup is never switched off here.
# Both answers describe this broker exactly: plain TCP, no certificates.
HA_FLOW_FALLBACKS: dict[str, object] = {"set_ca_cert": "off", "set_client_cert": False}
# Where we remember which MQTT entry is ours. Deliberately beside the broker's
# data dir rather than inside it: it is ServiceBay bookkeeping, not broker state.
HA_LINK_FILENAME = ".home-assistant-link.json"


def _data_dir() -> str:
    return env("DATA_DIR", "/mnt/data")


def _ha_config_dir() -> str:
    return os.path.join(_data_dir(), *HA_CONFIG_SUBPATH)


def _ha_token() -> str:
    """HA's persisted long-lived admin token, or "" when this box has none."""
    for name in HA_TOKEN_FILENAMES:
        try:
            with open(os.path.join(_ha_config_dir(), name), encoding="utf-8") as fh:
                token = fh.read().strip()
        except OSError:
            continue
        if token:
            return token
    return ""


def _ha_request(
    token: str,
    path: str,
    payload: object | None = None,
    method: str | None = None,
) -> tuple[int, object]:
    """One call to HA's REST API. Returns (status, parsed body). Status 0 means
    HA could not be reached at all; the body is then the error text."""
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(HA_API + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=HA_REQUEST_TIMEOUT) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except (ValueError, OSError):
            return exc.code, {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return 0, str(exc)


def _ha_mqtt_entries(token: str) -> tuple[int, list]:
    """MQTT config entries as HA reports them. Retried while HA is still coming
    up — installing both services at once puts this script in front of an HA
    that is not answering yet, which is transient, not a failure."""
    status: int = 0
    body: object = ""
    for attempt in range(HA_READY_ATTEMPTS):
        if attempt:
            time.sleep(HA_READY_INTERVAL)
        status, body = _ha_request(token, "/api/config/config_entries/entry?domain=mqtt")
        if status == 200 and isinstance(body, list):
            return status, body
        if status not in (0, 502, 503):
            break
    return status, []


def _form_payload(fields: object, overrides: dict[str, object]) -> dict[str, object]:
    """Fill in the form HA just handed us.

    `fields` is HA's serialised `data_schema`. Each entry carries its own name,
    whether it is required, its default, and — on a reconfigure — the entry's
    current value as `description.suggested_value`. Filling the form from that
    is what keeps this version-agnostic and non-destructive: we answer only the
    questions HA asked, we answer them with HA's own values, and we override
    exactly the four that describe this broker."""
    payload: dict[str, object] = {}
    for field in fields if isinstance(fields, list) else []:
        if not isinstance(field, dict):
            continue
        name = field.get("name")
        if not isinstance(name, str) or not name:
            continue
        if field.get("type") == "expandable":
            # A collapsed section (HA 2026.8+ puts the advanced broker settings
            # in one). It is a required key with no default of its own, so it
            # has to be sent even when everything inside it is optional.
            nested = _form_payload(field.get("schema"), overrides)
            if nested or field.get("required"):
                payload[name] = nested
            continue
        if name in overrides:
            payload[name] = overrides[name]
            continue
        suggested = field.get("description")
        if isinstance(suggested, dict) and suggested.get("suggested_value") is not None:
            payload[name] = suggested["suggested_value"]
            continue
        if "default" in field:
            payload[name] = field["default"]
            continue
        if field.get("required") and name in HA_FLOW_FALLBACKS:
            payload[name] = HA_FLOW_FALLBACKS[name]
    return payload


def _flow_error(result: object) -> str:
    """The most specific thing HA said about why it refused the form."""
    if not isinstance(result, dict):
        return str(result)[:200]
    for key in ("errors", "reason", "message"):
        value = result.get(key)
        if value:
            return json.dumps(value) if not isinstance(value, str) else value
    return json.dumps(result)[:200]


def _submit_broker_form(token: str, start: dict, overrides: dict[str, object]) -> tuple[str, object]:
    """Answer the broker form of an already-started flow.

    Returns (outcome, detail) where outcome is "created" (detail = entry id),
    "updated", or "failed" (detail = what HA said)."""
    flow_id = start.get("flow_id")
    payload = _form_payload(start.get("data_schema"), overrides)
    status, result = _ha_request(token, f"/api/config/config_entries/flow/{flow_id}", payload)
    if status != 200 or not isinstance(result, dict):
        _abort_flow(token, flow_id)
        return "failed", _flow_error(result)
    kind = result.get("type")
    if kind == "create_entry":
        entry = result.get("result")
        entry_id = entry.get("entry_id") if isinstance(entry, dict) else None
        return "created", entry_id
    if kind == "abort" and result.get("reason") == "reconfigure_successful":
        return "updated", None
    # A form back means HA tried the broker and did not like the answer
    # (`cannot_connect`, `invalid_auth`); anything else is an abort we did not
    # ask for. Either way the flow stays open in HA's UI unless we close it.
    _abort_flow(token, flow_id)
    return "failed", _flow_error(result)


def _abort_flow(token: str, flow_id: object) -> None:
    if isinstance(flow_id, str) and flow_id:
        _ha_request(token, f"/api/config/config_entries/flow/{flow_id}", method="DELETE")


def _entry_points_at_this_broker(token: str, entry_id: str, port: int) -> bool:
    """True when HA's own diagnostics say this entry is connected to *our*
    broker: same host, same port, connection live.

    Read-only, and the values are HA's, not a guess from a file we do not own.
    MQTT's diagnostics redact the username and password, which is the point —
    we never need them: the broker accepts exactly one account, so an entry that
    is *connected* to it is by definition using the credentials below.

    That inference holds because of *when* we ask. This deploy replaced the
    broker pod, which dropped every client; HA reconnects within seconds from
    its stored credentials, and cannot if they are stale. So "connected" here is
    evidence about the credentials as they are now, not as they were. If HA has
    not finished reconnecting yet we simply get False and leave the entry alone
    — the safe direction, and the next deploy looks again."""
    status, body = _ha_request(token, f"/api/diagnostics/config_entry/{entry_id}")
    if status != 200 or not isinstance(body, dict):
        return False
    data = body.get("data")
    if not isinstance(data, dict) or data.get("connected") is not True:
        return False
    mqtt_config = data.get("mqtt_config")
    config = mqtt_config.get("data") if isinstance(mqtt_config, dict) else None
    if not isinstance(config, dict) or config.get("broker") != HA_BROKER_HOST:
        return False
    try:
        return int(config.get("port")) == port
    except (TypeError, ValueError):
        return False


def _link_path() -> str:
    return os.path.join(_data_dir(), "mosquitto", HA_LINK_FILENAME)


def _read_link() -> dict:
    try:
        with open(_link_path(), encoding="utf-8") as fh:
            link = json.load(fh)
    except (OSError, ValueError):
        return {}
    return link if isinstance(link, dict) else {}


def _write_link(entry_id: str, fingerprint: str) -> None:
    path = _link_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"entry_id": entry_id, "fingerprint": fingerprint}, fh)
    except OSError as exc:
        log(f"   ⚠️ Could not record the Home Assistant link at {path}: {exc}")
        log("      MQTT works; a later password change just won't be carried over on its own.")


def _fingerprint(broker: str, port: int, username: str, password: str) -> str:
    """A short digest of the connection settings, used only to notice that they
    changed since we last pushed them.

    Truncated on purpose: 64 bits is far more than enough to tell two settings
    apart, and short enough that the stored value is not a usable handle on the
    password it was derived from."""
    material = f"servicebay-mqtt-ha-link:v1|{broker}|{port}|{username}|{password}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def configure_home_assistant(username: str, password: str, port: int) -> str:
    """Set up (or update) HA's MQTT integration for this broker.

    Verdicts:
      "absent"    — no Home Assistant on this box; nothing was said or done
      "skipped"   — HA is here but unreachable / no admin token; operator's job
      "created"   — HA had no MQTT integration and now has one
      "updated"   — ours was there and now carries the current credentials
      "unchanged" — ours was there and already correct
      "adopted"   — the operator's own connection is to this broker and live;
                    recorded so a later rotation follows it, nothing written
      "external"  — an MQTT integration we did not create; left exactly as is
      "failed"    — HA has an MQTT integration flow but refused what we sent
    """
    if not os.path.isdir(_ha_config_dir()):
        # No Home Assistant here. The ticket is explicit that this case must be
        # silent: MQTT is worth running on its own and a note about a service
        # the operator never installed is noise.
        return "absent"

    token = _ha_token()
    if not token:
        # Happens when HA and mosquitto are installed in the same run: HA's own
        # post-deploy mints this token, and it may not have run yet.
        log("ℹ️ Home Assistant is here but ServiceBay has no admin token for it yet, so its MQTT")
        log("   integration was left alone. Deploying mosquitto again once Home Assistant has")
        log("   finished setting itself up connects it; until then: Settings → Devices & Services")
        log(f"   → MQTT, broker {HA_BROKER_HOST}, port {port}, with the credentials above.")
        return "skipped"

    status, entries = _ha_mqtt_entries(token)
    if status != 200:
        reason = ("its token is not accepted" if status in (401, 403)
                  else f"it did not answer (HTTP {status})")
        log(f"ℹ️ Home Assistant's MQTT integration was left alone — {reason}.")
        log("   Deploying mosquitto again wires it in; nothing here is broken.")
        return "skipped"

    fingerprint = _fingerprint(HA_BROKER_HOST, port, username, password)
    overrides: dict[str, object] = {
        "broker": HA_BROKER_HOST,
        "port": port,
        "username": username,
        "password": password,
    }
    link = _read_link()
    entry = entries[0] if entries else None

    if entry is None:
        start_status, start = _ha_request(
            token,
            "/api/config/config_entries/flow",
            {"handler": "mqtt", "show_advanced_options": True},
        )
        if start_status != 200 or not isinstance(start, dict) or start.get("type") != "form":
            log(f"   ⚠️ Home Assistant would not open the MQTT setup form: {_flow_error(start)}")
            return "failed"
        outcome, detail = _submit_broker_form(token, start, overrides)
        if outcome != "created":
            log(f"   ⚠️ Home Assistant refused the broker settings: {detail}")
            log("      Nothing was changed in HA. The credentials above still work by hand.")
            return "failed"
        if isinstance(detail, str) and detail:
            _write_link(detail, fingerprint)
        log("🏠 Home Assistant is now connected to this broker — no manual step needed.")
        return "created"

    entry_id = entry.get("entry_id") if isinstance(entry, dict) else None
    if not isinstance(entry_id, str):
        return "failed"

    if link.get("entry_id") != entry_id:
        # Not ours. #2578 is explicit: an existing connection is detected and
        # left alone, never duplicated and never overwritten. The one thing we
        # may do is *recognise* it — if HA's diagnostics say it is live against
        # this very broker, then it already carries these credentials, so
        # recording it changes nothing today and means the next rotation is
        # carried over instead of silently breaking it.
        if _entry_points_at_this_broker(token, entry_id, port):
            _write_link(entry_id, fingerprint)
            log("🏠 Home Assistant is already connected to this broker (you set it up yourself).")
            log("   Left exactly as it is — ServiceBay will keep its password in step from now on.")
            return "adopted"
        title = entry.get("title") if isinstance(entry, dict) else None
        log(f"🏠 Home Assistant already has an MQTT connection ({title or 'unknown broker'}) that")
        log("   ServiceBay did not create — left exactly as it is. If it should point here, edit it")
        log("   under Settings → Devices & Services → MQTT with the credentials above.")
        return "external"

    if link.get("fingerprint") == fingerprint:
        log("🏠 Home Assistant's MQTT connection is already up to date.")
        return "unchanged"

    start_status, start = _ha_request(
        token,
        "/api/config/config_entries/flow",
        {"handler": "mqtt", "entry_id": entry_id, "show_advanced_options": True},
    )
    if start_status != 200 or not isinstance(start, dict) or start.get("type") != "form":
        log(f"   ⚠️ Home Assistant would not open the MQTT reconfigure form: {_flow_error(start)}")
        return "failed"
    outcome, detail = _submit_broker_form(token, start, overrides)
    if outcome != "updated":
        log(f"   ⚠️ Home Assistant refused the new broker settings: {detail}")
        log("      Its MQTT connection is unchanged and may now be using the old password —")
        log("      update it under Settings → Devices & Services → MQTT with the credentials above.")
        return "failed"
    _write_link(entry_id, fingerprint)
    log("🏠 Home Assistant's MQTT connection was updated to the current credentials.")
    return "updated"


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
    log(f"   Home Assistant and other containers on this box:            host {HA_BROKER_HOST}, port {port}")
    log("   No TLS: use it on a network you trust, and don't reuse this password elsewhere (see the template README).")

    emit_credential(
        service="MQTT Broker (Mosquitto)",
        url=f"mqtt://{lan}:{port}",
        username=username,
        password=password,
        importance="critical",
        notes=(
            "Broker credentials. Home Assistant is connected to this broker "
            f"automatically when it is installed here (host {HA_BROKER_HOST}, port "
            f"{port}); every device that publishes here needs them typed in by hand "
            f"(host {lan}, port {port}). Anonymous access is off, so losing these "
            "means re-generating them in the wizard and re-entering them on every "
            "device."
        ),
    )

    try:
        configure_home_assistant(username, password, int(port))
    except Exception as exc:  # noqa: BLE001 — the broker is up; never fail the deploy over the wiring
        log(f"   ⚠️ Could not set up Home Assistant's MQTT integration: {exc}")
        log("      The broker itself is fine — add it by hand under Settings → Devices & Services.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
