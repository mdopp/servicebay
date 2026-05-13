#!/usr/bin/env python3
"""
post-deploy hook for the `immich` stack (#410).

What this does:
  1. Wait for Immich's /api/server/ping to answer 200 on the loopback
     (127.0.0.1 or [::1]; NestJS on FCoS binds IPv6-only).
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


# Single end-to-end budget covering everything between deploy and
# "API answers 200": image pull (~2 GB for immich-server alone),
# pod start, postgres initdb, immich server migrations, NestJS boot.
# Healthy fast machines exit within seconds; cold first-boot on slow
# storage can take many minutes. 15 min is comfortably generous.
#
# Earlier shapes of this script had a separate wait_pod_running()
# polling `podman pod inspect <pod> --format '{{.State}}'` for the
# string "running" before the API probe. That check is fragile: the
# pod sits in "Degraded" while containers come up one by one, the
# format-string value depends on podman version, and the loop is
# silent. We dropped it — the API probe below is the only signal that
# actually answers "can the post-deploy talk to immich?", and an HTTP
# 200 on /api/server/ping already implies the pod and database are
# alive. See PR adding this comment for the failure mode it fixed.
READY_TIMEOUT = 900.0
READY_INTERVAL = 2.0
REQUEST_TIMEOUT = 30.0
# Heartbeat cadence for the silent poll loop. Keeps the wizard's
# /api/services NDJSON stream warm so undici doesn't fire its 5-min
# bodyTimeout mid-wait and the runner doesn't see a phantom
# "(terminated)" failure on healthy installs. 60 s gives one visible
# progress line per minute, plus the route emits its own
# `{type:"ping"}` every 30 s as a belt-and-braces stream keepalive.
HEARTBEAT_INTERVAL = 60.0


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


def wait_ready(port: str) -> tuple[bool, str]:
    """Poll Immich's /api/server/ping until it returns 200. Returns
    (success, base_url).

    Probes the host-published LAN_IP first when known, then 127.0.0.1
    and [::1] — every reachable variant is tried each iteration so
    we don't get stuck if one address answers but the others don't.
    Rootless podman + `hostNetwork: true` (immich's setup) typically
    keeps loopback reachable; LAN_IP is kept around as a belt-and-
    braces fallback.

    NB on the endpoint: earlier shapes of this script hit
    `/api/server/ping`, which doesn't exist in Immich v2.x. Every
    probe returned 404, the loop never matched a 200, and the runner
    eventually saw the SSH agent drop with "Agent disconnected". The
    bootstrap log lists the real routes — `/api/server/ping` is the
    cheapest unauthenticated readiness signal.

    Carries the whole 'is immich up?' budget; covers image pull + pod
    start + DB init + migrations. Emits a heartbeat line every
    HEARTBEAT_INTERVAL seconds so the operator sees progress and the
    install runner's NDJSON stream stays warm."""
    lan_ip = env("LAN_IP")
    candidates: list[str] = []
    if lan_ip:
        candidates.append(f"http://{lan_ip}:{port}")
    candidates.extend([f"http://127.0.0.1:{port}", f"http://[::1]:{port}"])

    started = time.time()
    last_heartbeat = started
    while time.time() - started < READY_TIMEOUT:
        for url in candidates:
            code, _ = request_json("GET", f"{url}/api/server/ping")
            if code == 200:
                return True, url
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            elapsed = int(now - started)
            log(f"   …still waiting for /api/server/ping on {', '.join(candidates)} ({elapsed}s/{int(READY_TIMEOUT)}s)")
            last_heartbeat = now
        time.sleep(READY_INTERVAL)
    return False, candidates[0]


def main() -> int:
    port = env("IMMICH_PORT", "2283")
    public_domain = env("PUBLIC_DOMAIN")
    sso_enabled = env("IMMICH_SSO_ENABLED") == "true"
    sso_secret = env("IMMICH_SSO_SECRET")
    admin_name = env("IMMICH_ADMIN_NAME", "Admin")
    admin_email = env("IMMICH_ADMIN_EMAIL")
    admin_password = env("IMMICH_ADMIN_PASSWORD")
    subdomain = env("IMMICH_SUBDOMAIN", "photos")
    public_url = f"https://{subdomain}.{public_domain}" if public_domain else f"http://127.0.0.1:{port}"

    log(f"Waiting up to {int(READY_TIMEOUT)}s for Immich API on 127.0.0.1 / [::1] (covers image pull + DB init + migrations)…")
    ready, base_url = wait_ready(port)
    if not ready:
        log(f"❌ Immich /api/server/ping did not respond on 127.0.0.1 or [::1] within {int(READY_TIMEOUT)}s — skipping seed/OIDC config.")
        log("   Re-run this post-deploy from Diagnose → post_deploy_failed → 'Re-run post-install' once /api/server/ping returns 200.")
        return 1
    log(f"✅ Immich is ready at {base_url}.")

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
