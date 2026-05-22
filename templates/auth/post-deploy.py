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


# LLDAP readiness gate (#808). LLDAP shares the `auth` pod with Authelia,
# but the pod's continuous healthcheck only probes Authelia's
# `/api/health` — Authelia reaches LLDAP over the LDAP socket, which says
# nothing about LLDAP's HTTP/GraphQL API being up. The group seed below
# talks to that HTTP API, so it must wait for it explicitly. Module-level
# so the test suite can shrink the budget.
LLDAP_READY_TIMEOUT = 5 * 60
LLDAP_READY_INTERVAL = 5
SEED_MAX_ATTEMPTS = 3


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


def wait_for_lldap(sb_api: str, port: int) -> bool:
    """Poll ServiceBay's LLDAP readiness probe until LLDAP's HTTP/GraphQL
    endpoint accepts connections. Returns True once reachable, False if
    the deadline passes first. The probe returns `reachable: true` only
    after LLDAP's SQLite schema is initialized and the API layer is up
    (a bare 401 on `/api/graphql`), so seeding straight after it is
    safe."""
    started = time.time()
    last_beat = 0.0
    while time.time() - started < LLDAP_READY_TIMEOUT:
        status, body = post_json(
            f"{sb_api}/api/system/lldap/probe",
            {"host": "localhost", "port": port},
            timeout=10,
        )
        if status == 200 and body and body.get("reachable"):
            return True
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            log(f"Waiting for LLDAP's HTTP API to come up ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(LLDAP_READY_INTERVAL)
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
        log(f"✅ LLDAP admin saved (user: admin) — open http://{host}:{lldap_port} or via NPM. Password retrievable from Settings → Integrations → Saved credentials.")
    else:
        # Even on persist failure, the password still lands in the wizard
        # banner via emit_credential below — keep the warning short and
        # don't echo the secret into journalctl.
        log(f"⚠️ Could not persist LLDAP credentials (HTTP {persist_status}). Password is still shown in the post-install credential banner.")

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

    # ── Seed `admins` + `family` groups ──────────────────────────────────
    # Wait for LLDAP's HTTP API before seeding (#808). The install
    # runner's per-template readiness probes were retired in Phase 3C, so
    # this script can no longer assume LLDAP is up by the time it runs —
    # and a single unguarded seed attempt that lands mid-boot fails
    # silently, leaving `admins`/`family` uncreated forever. Gate on the
    # readiness probe, then retry the seed itself a few times in case the
    # schema is still settling.
    if not wait_for_lldap(sb_api, int(lldap_port)):
        log(
            f"⚠️ LLDAP's HTTP API never became reachable within {LLDAP_READY_TIMEOUT // 60} min — "
            "skipping group seed. The `admins`/`family` groups were NOT created; "
            "re-run setup once LLDAP is up, or create them in LLDAP's web UI. "
            "Family members can't be group-assigned until they exist."
        )
    else:
        log("Seeding LLDAP groups...")
        for attempt in range(1, SEED_MAX_ATTEMPTS + 1):
            seed_status, seed_body = post_json(
                f"{sb_api}/api/system/lldap/seed",
                {"host": "localhost", "port": int(lldap_port), "password": lldap_password},
                timeout=15,
            )
            ok = seed_status == 200 and isinstance(seed_body, dict)
            failed = (seed_body.get("failed") or []) if ok else []
            if ok and not failed:
                created = seed_body.get("created") or []
                existing = seed_body.get("existing") or []
                if created:
                    log(f"✅ Groups created: {', '.join(str(x) for x in created)}")
                if existing:
                    log(f"ℹ️ Groups already exist: {', '.join(str(x) for x in existing)}")
                break
            # The seed endpoint is idempotent (it reports `existing` for
            # groups already present), so retrying a partial/failed run
            # is safe.
            err = (
                ", ".join(str(f.get("name", "?")) for f in failed)
                if failed
                else (seed_body or {}).get("error", f"HTTP {seed_status}")
            )
            if attempt < SEED_MAX_ATTEMPTS:
                log(f"⏳ LLDAP group seed attempt {attempt}/{SEED_MAX_ATTEMPTS} incomplete ({err}); retrying in {LLDAP_READY_INTERVAL}s...")
                time.sleep(LLDAP_READY_INTERVAL)
            else:
                log(f"⚠️ Could not fully seed LLDAP groups after {SEED_MAX_ATTEMPTS} attempts: {err}")

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
