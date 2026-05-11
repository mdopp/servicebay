#!/usr/bin/env python3
"""
post-deploy hook for the `adguard` stack.

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts):
  - logAdguardCredentials  → `__SB_CREDENTIAL__` for AdGuard admin

AdGuard's first-start config is pre-seeded by the wizard's mustache step
(AdGuardHome.yaml.mustache lives in this directory). The bcrypt password
hash is computed server-side via /api/system/keys/bcrypt and baked into
that config. So this script has nothing to seed — it just surfaces the
credential the operator needs for their first login.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sys
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
    user = env("ADGUARD_ADMIN_USER", "admin")
    password = env("ADGUARD_ADMIN_PASSWORD")
    port = env("ADGUARD_ADMIN_PORT", "8083")

    if not password:
        log("⚠️ ADGUARD_ADMIN_PASSWORD missing — first-login won't work; reset via the AdGuard Home setup wizard at http://<server-ip>:" + port)
        return 0

    log(f"✅ AdGuard admin saved (user: {user}) — open http://{host}:{port}. Password retrievable from Settings → Integrations → Saved credentials.")
    emit_credential(
        service="AdGuard Home",
        url=f"http://{host}:{port}",
        username=user,
        password=password,
        importance="critical",
        notes="DNS console. Add custom rewrites + manage blocklists.",
    )

    # Persist the admin credentials into ServiceBay's config so the
    # provisioner can pick them up later for DNS rewrites + the
    # FritzBox-DNS hand-off probe. Mirrors what nginx + lldap post-
    # deploys do. The endpoint also triggers provisionPortalRouting()
    # in the background, which installs the wildcard rewrites
    # (`*.<lan>`, `*.<public>`) the operator expects to land
    # automatically after install. See #341 + the AdGuard-rewrites
    # follow-up.
    sb_api = env("SB_API_URL", "http://localhost:3000")
    persist_status, _ = post_json(
        f"{sb_api}/api/system/adguard/credentials",
        {
            "adminUrl": f"http://localhost:{port}",
            "username": user,
            "password": password,
        },
        timeout=10,
    )
    if persist_status == 200:
        log("ServiceBay registered AdGuard credentials — wildcard DNS rewrites will be provisioned.")
    else:
        log(f"⚠️ Could not register AdGuard credentials with ServiceBay (HTTP {persist_status}). Wildcard rewrites won't auto-install; add them manually in AdGuard if subdomains don't resolve.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
