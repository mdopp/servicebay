#!/usr/bin/env python3
"""
post-deploy hook for the `auth` stack (LLDAP + Authelia in one pod).

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts):
  - persistLldapCredentials  → POST /api/system/lldap/credentials so the
                                admin login surfaces in
                                Settings → Integrations after install.
  - seedLldap                → POST /api/system/lldap/seed to create the
                                `admins` + `family` groups every other
                                template's access_control rules expect.
  - LLDAP credential entry    → __SB_CREDENTIAL__ for the directory portal.
  - Authelia OIDC RS256 key   → emitted as a system credential for DR.
  - LLDAP JWT secret          → emitted as a system credential for DR.

What stays in the engine (genuinely cross-template):
  - Authelia OIDC client registration walks variables[].meta.oidcClient
    across ALL deployed templates and POSTs once to
    /api/system/authelia/oidc-clients. That can't easily live in a single
    template's script.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import sys
import time
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
    # Pin internal API token. ServiceBay's proxy.ts checks this header
    # to bypass the browser-flow CSRF + session guards (urllib doesn't
    # send an Origin header, so without this every POST got 403).
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


def wait_for_lldap(port: str, deadline_sec: int) -> bool:
    """LLDAP cold-start is fast (<30s) but image pull can stretch this to a few min.
    Probe via ServiceBay's reachability endpoint so the wait + heartbeat
    behaves identically to the old hardcoded waitForLldap helper."""
    sb_api = env("SB_API_URL", "http://localhost:3000")
    started = time.time()
    last_beat = 0.0
    while time.time() - started < deadline_sec:
        status, body = post_json(
            f"{sb_api}/api/system/lldap/probe",
            {"host": "localhost", "port": int(port)},
            timeout=10,
        )
        if status == 200 and body and body.get("reachable"):
            return True
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            log(f"Still waiting for LLDAP ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(3)
    return False


def main() -> int:
    host = env("HOST", "<server-ip>")
    sb_api = env("SB_API_URL", "http://localhost:3000")
    public_domain = env("PUBLIC_DOMAIN")

    lldap_password = env("LLDAP_ADMIN_PASSWORD")
    lldap_port = env("LLDAP_PORT", "17170")
    if not lldap_password:
        log("⚠️ LLDAP_ADMIN_PASSWORD missing — skipping persist + seed steps.")
        return 0

    # ── Persist LLDAP credentials in ServiceBay's settings store ─────────
    # Surfaces the password in Settings → Integrations → LLDAP for later
    # reference. Best-effort: a 4xx here doesn't block the install, the
    # operator just notes the password from the credential banner below.
    persist_status, _ = post_json(
        f"{sb_api}/api/system/lldap/credentials",
        {"url": f"http://localhost:{lldap_port}", "username": "admin", "password": lldap_password},
        timeout=10,
    )
    if persist_status == 200:
        log(f"🔑 LLDAP admin (user: admin, password: {lldap_password}) — open http://{host}:{lldap_port} or via NPM. Stored in Settings → Integrations.")
    else:
        log(f"⚠️ Could not persist LLDAP credentials (HTTP {persist_status}). Note now: admin / {lldap_password}")

    emit_credential(
        service="LLDAP (User Directory)",
        url=f"http://{host}:{lldap_port}",
        username="admin",
        password=lldap_password,
        importance="critical",
        notes="Manage users + groups here. Required to add family members.",
    )

    # ── LLDAP JWT secret — system credential for DR ──────────────────────
    jwt_secret = env("LLDAP_JWT_SECRET")
    if jwt_secret:
        emit_credential(
            service="LLDAP JWT secret",
            url="env: LLDAP_JWT_SECRET",
            username="—",
            password=jwt_secret,
            importance="system",
            notes="Signs LLDAP user sessions. Save for disaster recovery — without it old browser cookies become invalid after a restore.",
        )

    # ── Wait for LLDAP, seed `admins` + `family` groups ──────────────────
    log("Waiting for LLDAP to start (cold-start usually < 30s)...")
    if not wait_for_lldap(lldap_port, deadline_sec=10 * 60):
        log(f"⚠️ LLDAP did not respond in time. Open http://{host}:{lldap_port} as admin and create groups admins+family manually.")
        return 0

    log("Seeding LLDAP groups...")
    seed_status, seed_body = post_json(
        f"{sb_api}/api/system/lldap/seed",
        {"host": "localhost", "port": int(lldap_port), "password": lldap_password},
        timeout=15,
    )
    if seed_status == 200 and seed_body:
        created = seed_body.get("created") or []
        existing = seed_body.get("existing") or []
        failed = seed_body.get("failed") or []
        if created:
            log(f"✅ Groups created: {', '.join(str(x) for x in created)}")
        if existing:
            log(f"ℹ️ Groups already exist: {', '.join(str(x) for x in existing)}")
        if failed:
            names = ", ".join(str(f.get("name", "?")) for f in failed)
            log(f"⚠️ Failed: {names}")
    else:
        err = (seed_body or {}).get("error", f"HTTP {seed_status}")
        log(f"⚠️ Could not seed LLDAP groups: {err}")

    # ── Authelia portal URL — credential entry only (no admin user; auth
    # via LLDAP) ─────────────────────────────────────────────────────────
    if public_domain:
        emit_credential(
            service="Authelia (SSO portal)",
            url=f"https://auth.{public_domain}",
            username="(LLDAP-managed)",
            password="(see LLDAP)",
            importance="system",
            notes="SSO portal in front of every protected service. Identities + groups come from LLDAP — no separate Authelia password.",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
