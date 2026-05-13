#!/usr/bin/env python3
"""
post-deploy hook for the `immich` stack (#410).

What this does:
  1. Wait for Immich server to report ready on http://127.0.0.1:IMMICH_PORT.
  2. Idempotently seed the initial admin account via /api/auth/admin-sign-up.
     If the admin already exists (returning installs, re-runs after success),
     the endpoint returns 400 — we log and continue.
  3. Log in as that admin and PUT /api/system-config to enable OAuth pointed
     at https://auth.<PUBLIC_DOMAIN> with the same client secret the wizard
     pushed into Authelia's clients[] via `clientSecretVar: IMMICH_SSO_SECRET`.
  4. Emit `__SB_CREDENTIAL__` for the seeded admin so the operator can sign
     in once and immediately switch to SSO from the settings UI.

Without this script, the operator hits Immich's first-run sign-up screen
themselves and SSO has to be wired up by hand. See lib/registry.ts:
getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request


READY_TIMEOUT = 180.0
READY_INTERVAL = 2.0
REQUEST_TIMEOUT = 30.0


def env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    return val if val else default


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def emit_credential(**fields: object) -> None:
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def request_json(method: str, url: str, payload: object | None = None, token: str | None = None, timeout: float = REQUEST_TIMEOUT) -> tuple[int, object | None]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw) if raw else None
            except json.JSONDecodeError:
                return resp.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # pylint: disable=broad-except
            return e.code, None
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, None


def wait_ready(base_url: str) -> bool:
    """Poll Immich's /api/server-info until it returns 200, then return True."""
    started = time.time()
    while time.time() - started < READY_TIMEOUT:
        code, _ = request_json("GET", f"{base_url}/api/server-info")
        if code == 200:
            return True
        time.sleep(READY_INTERVAL)
    return False


def main() -> int:
    port = env("IMMICH_PORT", "2283")
    base_url = f"http://127.0.0.1:{port}"
    public_domain = env("PUBLIC_DOMAIN")
    sso_enabled = env("IMMICH_SSO_ENABLED") == "true"
    sso_secret = env("IMMICH_SSO_SECRET")
    admin_name = env("IMMICH_ADMIN_NAME", "Admin")
    admin_email = env("IMMICH_ADMIN_EMAIL")
    admin_password = env("IMMICH_ADMIN_PASSWORD")
    subdomain = env("IMMICH_SUBDOMAIN", "photos")
    public_url = f"https://{subdomain}.{public_domain}" if public_domain else base_url

    log(f"Waiting up to {int(READY_TIMEOUT)}s for Immich at {base_url}…")
    if not wait_ready(base_url):
        log(f"❌ Immich did not become ready within {int(READY_TIMEOUT)}s — skipping seed/OIDC config.")
        return 1
    log("✅ Immich is ready.")

    if not admin_email or not admin_password:
        log("⚠️  IMMICH_ADMIN_EMAIL / IMMICH_ADMIN_PASSWORD not set — skipping admin seed and OIDC config. Re-run the wizard to regenerate them.")
        return 0

    # 1. Seed admin (idempotent — 400 means an admin already exists).
    code, body = request_json(
        "POST",
        f"{base_url}/api/auth/admin-sign-up",
        {"name": admin_name, "email": admin_email, "password": admin_password},
    )
    if code in (200, 201):
        log(f"✅ Created Immich admin {admin_email}.")
        emit_credential(
            service="Immich",
            url=public_url,
            username=admin_email,
            password=admin_password,
            importance="critical",
            notes="Initial admin password — rotate after first sign-in or switch to SSO.",
        )
    elif code == 400:
        log("ℹ️  Immich admin already exists — leaving it alone.")
    else:
        log(f"⚠️  Immich admin sign-up returned HTTP {code}: {body}. Continuing.")

    # 2. Log in to fetch a token for the system-config call.
    code, body = request_json(
        "POST",
        f"{base_url}/api/auth/login",
        {"email": admin_email, "password": admin_password},
    )
    token = body.get("accessToken") if isinstance(body, dict) else None
    if code != 201 or not token:
        log(f"⚠️  Could not log in as admin (HTTP {code}). Skipping OIDC config.")
        return 0

    # 3. Configure OAuth. Read-modify-write so we don't clobber any
    #    fields Immich expects to be present in the system config.
    if not sso_enabled:
        log("ℹ️  IMMICH_SSO_ENABLED=false — skipping OAuth configuration.")
        return 0
    if not sso_secret or not public_domain:
        log("⚠️  Missing IMMICH_SSO_SECRET or PUBLIC_DOMAIN — skipping OAuth configuration.")
        return 0

    code, current = request_json("GET", f"{base_url}/api/system-config", token=token)
    if code != 200 or not isinstance(current, dict):
        log(f"⚠️  Could not read /api/system-config (HTTP {code}). Skipping OAuth update.")
        return 0

    current["oauth"] = {
        "enabled": True,
        "issuerUrl": f"https://auth.{public_domain}",
        "clientId": "immich",
        "clientSecret": sso_secret,
        "scope": "openid profile email",
        "buttonText": "Login with Authelia",
        "autoRegister": True,
        # Keep the password field visible so the operator can still log in
        # locally if SSO breaks; flip to True later via the Immich UI.
        "autoLaunch": False,
        "signingAlgorithm": "RS256",
        "mobileOverrideEnabled": False,
        "mobileRedirectUri": "",
        "storageLabelClaim": "preferred_username",
        "storageQuotaClaim": "immich_quota",
    }

    code, body = request_json("PUT", f"{base_url}/api/system-config", current, token=token)
    if code in (200, 201):
        log(f"✅ Immich OIDC configured against https://auth.{public_domain}.")
    else:
        log(f"⚠️  Could not write OIDC config (HTTP {code}): {body}.")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
