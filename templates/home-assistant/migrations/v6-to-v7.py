#!/usr/bin/env python3
"""
Migration: home-assistant v6 → v7 (#2416).

What changed between v6 and v7: every admin/control port this pod exposes
except Home Assistant's own 8123 is now bound to the host **loopback**.
The pod runs `hostNetwork: true`, so before v7 each of them answered on
every host interface:

  - **8091** — the Z-Wave JS UI admin panel (include/exclude nodes, read
    the network security keys). Now bound via `HOST=127.0.0.1` on the
    zwave-js container.
  - **3001** — the raw Z-Wave JS server protocol, which carries no
    authentication at all: anything that can open the socket can actuate
    every paired device, door locks included. Now bound via `serverHost`
    in zwave-js-ui's settings — that is the one piece of on-disk state
    this script has to fix, see below.
  - **5580** — python-matter-server's control websocket, likewise
    unauthenticated. Now bound via `--listen-address 127.0.0.1` on the
    matter-server container, and declared in `servicebay.ports` for the
    first time (it was invisible to the network map before).

The pod-level rebinds are structural: `podman play kube` recreates the pod
from the v7 manifest, which carries the new env var / args. Nothing moves
on disk — HA's `/config`, the zwave-js store and the matter-server data
directory are untouched.

The existing `zwave.<domain>` NPM host is retargeted AUTOMATICALLY by
ServiceBay's core reconcile — this migration does NOT touch the proxy
itself (#2364). On every deploy the install runner runs `ensureProxyHosts`,
which walks the stack variables through `buildProxyHosts`:
ZWAVE_JS_SUBDOMAIN's new `loopbackOnly: true` makes it emit
`forwardHost: 127.0.0.1`, and the proxy-hosts endpoint's existing-host
branch (`reconcileProxyHostUpstream` / `decideUpstreamReconcile`) re-points
the live host's forward target from the old LAN IP (now closed) to
`127.0.0.1:8091`. That reconcile PUTs ONLY the forward target, so exposure
(internal), the Authelia forward-auth advanced_config and the bound cert
survive, and it is idempotent.

Everything that legitimately talks to these ports keeps working:
  - nginx runs on `hostNetwork`, so `127.0.0.1` IS the loopback the
    Z-Wave UI listens on.
  - Home Assistant is a container in THIS pod, so it shares the host
    netns; its `zwave_js` config entry connects to `ws://localhost:3001`
    and its `matter` entry to `ws://localhost:5580/ws`. Both are loopback
    already — no HA-side reconfiguration, no re-pairing.
  - `post-deploy.py` and this script run in the HOST netns (ADR 0007),
    so their localhost probes are unaffected.
  - Matter commissioning and device traffic are unaffected:
    `--listen-address` binds only the websocket API server, never the
    CHIP/Matter stack (that knob is `--primary-interface`).

WHY THIS HOP IS NOT PURELY INFORMATIONAL. Port 3001's bind address is not
in the pod manifest — it lives in zwave-js-ui's on-disk settings, seeded
by `post-deploy.py` as `sb-external-settings.json`. That seeder writes the
file only when it is MISSING, so on every v6 install the file already
exists carrying `"serverHost": "0.0.0.0"` and would keep the port
LAN-reachable forever. This script rewrites that value in place so an
install predating the fix is closed by the deploy itself, with no manual
edit and no redeploy dance.

What this script does:
  - Re-pin `serverHost` to 127.0.0.1 in whichever settings file governs
    the WS server: `sb-external-settings.json` when ServiceBay seeded it,
    otherwise zwave-js-ui's own `settings.json` (the install shape where
    the operator pinned `zwave.serverPort` in the UI). Both are JSON
    objects; only that one key is touched.
  - Leave a DELIBERATE non-wildcard `serverHost` alone and warn instead —
    an operator who pinned a specific address made a choice, and silently
    overriding it would break their setup. Everything else (absent,
    `0.0.0.0`, `::`) is rewritten.
  - Print what changed and exit 0. Migration scripts MUST exit 0 to let
    the deploy continue; a non-zero exit aborts it before the new yaml
    lands. A settings file we cannot read/write is reported loudly but is
    not fatal — the pod-level 8091/5580 binds still land, and the next
    deploy's post-deploy retries the 3001 pin.

Idempotent by contract: re-running finds `serverHost` already 127.0.0.1
and reports "already pinned" without writing.

Environment available (set by ServiceManager.runMigrationScript):
  - OLD_SCHEMA_VERSION = 6
  - NEW_SCHEMA_VERSION = 7
  - OLD_DATA_DIR, NEW_DATA_DIR (defaults to DATA_DIR for both)
  - Every wizard variable (DATA_DIR, ZWAVE_DEVICE, PUBLIC_DOMAIN, …)
  - SB_NODE, SB_API_URL, SB_API_TOKEN (for callbacks into ServiceBay)

See docs/TEMPLATE_AUTHORING.md (Migrations section) for the contract.
"""

from __future__ import annotations

import json
import os
import sys

# Must stay in sync with post-deploy.py's ZWAVEJS_WS_* constants.
ZWAVEJS_WS_PORT = 3001
ZWAVEJS_WS_HOST = "127.0.0.1"
WILDCARD_HOSTS = ("", "0.0.0.0", "::", "[::]", "*")


def _store_dir() -> str:
    """Host-side path of the zwave-js container's /usr/src/app/store mount.
    Must stay in sync with the volume declaration in template.yml and with
    post-deploy.py's `_zwave_store_dir`."""
    base = os.environ.get("DATA_DIR") or "/mnt/data"
    return os.path.join(base, "home-assistant", "zwave-js")


def _load(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  ⚠️ Could not read {path}: {exc} — leaving it untouched.")
        return None
    return data if isinstance(data, dict) else None


def _save(path: str, data: dict) -> bool:
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        print(f"  ⚠️ Could not rewrite {path}: {exc}")
        print(f"     Port {ZWAVEJS_WS_PORT} stays LAN-reachable until this is fixed;")
        print("     post-deploy retries the pin on the next deploy.")
        return False
    return True


def _pin(container: dict, label: str) -> bool:
    """Pin `serverHost` inside `container` (mutated in place). Returns True
    iff the caller should write the file back out."""
    host = container.get("serverHost")
    if host == ZWAVEJS_WS_HOST:
        print(f"  {label}: serverHost already pinned to {ZWAVEJS_WS_HOST} — nothing to do.")
        return False
    if host is not None and str(host).strip() not in WILDCARD_HOSTS:
        print(f"  ⚠️ {label}: serverHost is pinned to {host!r}, not a wildcard — leaving it alone.")
        print(f"     Set it to {ZWAVEJS_WS_HOST} yourself to keep port {ZWAVEJS_WS_PORT} off the LAN.")
        return False
    container["serverHost"] = ZWAVEJS_WS_HOST
    print(f"  {label}: serverHost {host!r} → {ZWAVEJS_WS_HOST}")
    return True


def migrate_zwave_ws_bind() -> None:
    """Close port 3001 on the LAN for an install seeded under v6."""
    external = os.path.join(_store_dir(), "sb-external-settings.json")
    settings = os.path.join(_store_dir(), "settings.json")

    data = _load(external)
    if data is not None:
        if _pin(data, "sb-external-settings.json"):
            _save(external, data)
        return

    data = _load(settings)
    if data is not None and isinstance(data.get("zwave"), dict):
        if _pin(data["zwave"], "settings.json (zwave)"):
            _save(settings, data)
        return

    print("  No zwave-js settings file on disk yet — post-deploy seeds it with")
    print(f"  serverHost={ZWAVEJS_WS_HOST} later in this same deploy.")


def main() -> int:
    print("Home Assistant v6 → v7: admin/control ports moved to the loopback (#2416).")
    print("  8091 (Z-Wave JS UI) and 5580 (Matter websocket) rebind when podman")
    print("  recreates the pod from the v7 manifest — no action needed.")
    print("  zwave.<domain> is retargeted to 127.0.0.1:8091 automatically by the")
    print("  core reconcile (#2364) — no manual proxy edit; exposure, forward-auth")
    print("  config and the cert are preserved.")
    print(f"  Port {ZWAVEJS_WS_PORT} (raw Z-Wave control websocket) is stored on disk, so:")
    migrate_zwave_ws_bind()
    print("  Home Assistant already reaches all three over localhost — nothing to")
    print("  re-pair. Nothing moves on disk; /config, the zwave-js store and the")
    print("  matter-server data directory are untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
