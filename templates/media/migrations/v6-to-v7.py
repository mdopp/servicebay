#!/usr/bin/env python3
"""
Migration: media v6 → v7 (#2561) — remove the retired `books.<domain>` alias.

### Why this migration exists at all

v7 deletes `ABS_SUBDOMAIN` from `variables.json`. That alone is enough to
stop a *future* deploy from creating the route: ServiceBay derives proxy
hosts structurally from the template's `type: "subdomain"` variable
declarations (`buildProxyHosts` in the engine), so a variable that is no
longer declared can no longer produce a host.

What it does NOT do is remove the host that already exists. The nginx
capability handler only ever CREATES on `feature.installed`; it deletes
on `feature.uninstalled`. Nothing prunes a host whose declaring variable
vanished. And the `dangling_proxy` diagnose probe won't catch this one
either — it flags routes whose forward target is dead, and this alias
forwards to a very much alive Jellyfin. So without this script the alias
would sit there forever on every upgraded box, serving Jellyfin from a
second name nobody decided to keep. That is exactly the orphan class
#2541 was about, which is why the removal is done here rather than left
to the operator.

### What it removes, and how it identifies it

The alias is found by shape, not by name, because the operator may have
changed `ABS_SUBDOMAIN` away from its `books` default before v7 dropped
the declaration (once dropped, its value is no longer in this script's
env). A host is the retired alias when all of:

  * it sits under `PUBLIC_DOMAIN`,
  * it forwards to `JELLYFIN_PORT`, and
  * it is NOT `MEDIA_SUBDOMAIN.PUBLIC_DOMAIN` (the keeper).

Only `ABS_SUBDOMAIN` ever pointed a second hostname at Jellyfin's port,
so this matches the alias whatever it was renamed to. The trade-off is
deliberate and stated in CHANGELOG v7: an operator who hand-created their
own extra Jellyfin alias loses it here and has to re-add it. Every removal
is printed with the domain, so it is never silent.

### Contract

Best-effort, exit 0 always — same posture as the v5→v6 container teardown.
A leftover proxy host is not worth aborting a deploy over; if the API call
fails, the script prints the exact manual step instead. Idempotent: a
second run finds nothing to remove and says so (fresh installs included).
Reads/writes nothing on disk.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SB_API_DEFAULT = "http://localhost:5888"


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def _request(url: str, method: str, timeout: float = 15.0) -> tuple[int, object | None]:
    """Call the local ServiceBay API with the internal token. Returns
    (status, parsed-json). Status 0 means the call never landed."""
    headers = {"Accept": "application/json"}
    token = os.environ.get("SB_API_TOKEN", "")
    if token:
        headers["X-SB-Internal-Token"] = token
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(body) if body else None
            except json.JSONDecodeError:
                return resp.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # pylint: disable=broad-except
            return e.code, None
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, None


def find_retired_aliases(
    sb_api: str, node: str, public_domain: str, jellyfin_port: int, keeper: str,
) -> list[str] | None:
    """Domains that are a second name on Jellyfin's port. None = couldn't ask."""
    query = f"?node={urllib.parse.quote(node)}" if node else ""
    status, payload = _request(f"{sb_api}/api/system/nginx/proxy-hosts{query}", "GET")
    if status != 200 or not isinstance(payload, dict):
        return None
    hosts = payload.get("hosts")
    if not isinstance(hosts, list):
        return None
    aliases: list[str] = []
    for host in hosts:
        if not isinstance(host, dict):
            continue
        domain = host.get("domain")
        if not isinstance(domain, str) or not domain.endswith(f".{public_domain}"):
            continue
        if domain == keeper:
            continue
        if host.get("forwardPort") != jellyfin_port:
            continue
        aliases.append(domain)
    return aliases


def remove_alias(sb_api: str, node: str, domain: str) -> bool:
    node_q = f"&node={urllib.parse.quote(node)}" if node else ""
    url = f"{sb_api}/api/system/nginx/proxy-hosts?domain={urllib.parse.quote(domain)}{node_q}"
    status, _ = _request(url, "DELETE")
    # 404 = already gone; the end state is what we care about.
    return status in (200, 404)


def main() -> int:
    log("Media v6 → v7: retiring the `books.<domain>` alias (#2561).")
    log("")
    log("Jellyfin is reached at `media.<domain>`. The `books.<domain>` name was")
    log("kept alive as a transitional courtesy when Audiobookshelf was retired")
    log("(#1725/#1730) and pointed at Jellyfin's own port; a second hostname on")
    log("the same port serves nobody, so it goes away now.")
    log("")

    public_domain = env("PUBLIC_DOMAIN")
    media_subdomain = env("MEDIA_SUBDOMAIN", "media")
    port_raw = env("JELLYFIN_PORT", "8096")
    sb_api = env("SB_API_URL", SB_API_DEFAULT)
    node = env("SB_NODE")

    if not public_domain:
        log("   No PUBLIC_DOMAIN set — this install has no public routes, so")
        log("   there is no `books` alias to remove. Nothing to do.")
        return 0
    try:
        jellyfin_port = int(port_raw)
    except ValueError:
        log(f"   JELLYFIN_PORT is not a number ({port_raw!r}); skipping alias cleanup.")
        return 0

    keeper = f"{media_subdomain}.{public_domain}"
    aliases = find_retired_aliases(sb_api, node, public_domain, jellyfin_port, keeper)

    if aliases is None:
        log("   ⚠️ Could not read the proxy routes from ServiceBay, so the old")
        log("   alias (if present) was left alone. Remove it by hand in")
        log(f"   Settings → Routes: any host under {public_domain} that forwards")
        log(f"   to port {jellyfin_port} and is not {keeper}.")
        return 0

    if not aliases:
        log(f"   No second hostname on Jellyfin's port {jellyfin_port} — nothing to")
        log(f"   remove. {keeper} is the only route to Jellyfin.")
        return 0

    for domain in aliases:
        log(f"   Removing retired alias {domain} (forwards to Jellyfin on")
        log(f"   {jellyfin_port}; {keeper} keeps serving it).")
        if remove_alias(sb_api, node, domain):
            log(f"   ✅ {domain} removed.")
        else:
            log(f"   ⚠️ Could not remove {domain}; the deploy continues. Delete it")
            log("   in Settings → Routes when convenient.")

    log("")
    log("👉 Anyone who saved a `books.` address in Symfonium, Findroid or")
    log(f"   Streamyfin must switch that app to https://{keeper}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
