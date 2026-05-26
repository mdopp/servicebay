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


def derive_operator_uid(email: str) -> str:
    """
    Derive a safe LLDAP uid from the operator's email local-part.
    LLDAP user IDs are lowercase alphanumeric + `_`/`.`/`-`; strip
    anything else and lowercase the rest. Falls back to "operator" if
    the local-part sanitizes to empty.
    """
    local = (email.split("@", 1)[0] if "@" in email else email).lower()
    cleaned = "".join(ch for ch in local if ch.isalnum() or ch in {"_", ".", "-"})
    return cleaned or "operator"


def main() -> int:
    host = env("HOST", "<server-ip>")
    sb_api = env("SB_API_URL", "http://localhost:3000")
    public_domain = env("PUBLIC_DOMAIN")
    operator_email = env("OPERATOR_EMAIL")

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
        # #988 — pass the operator email so seed also pre-creates the
        # operator's LLDAP user + adds them to `admins`. No password is
        # set (LLDAP uses OPAQUE) — they finish via "Set password" in
        # the LLDAP UI on first sign-in.
        operator_payload: dict[str, object] = {}
        if operator_email:
            operator_payload = {
                "operator": {
                    "uid": derive_operator_uid(operator_email),
                    "email": operator_email,
                    "displayName": "Operator",
                },
            }
        for attempt in range(1, SEED_MAX_ATTEMPTS + 1):
            seed_status, seed_body = post_json(
                f"{sb_api}/api/system/lldap/seed",
                {
                    "host": "localhost",
                    "port": int(lldap_port),
                    "password": lldap_password,
                    **operator_payload,
                },
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
                # Confirmation that the LLDAP `admin` user is now in
                # `admins` — the gate Authelia checks before letting
                # anyone hit ldap.<domain> / nginx.<domain> / etc.
                # Without this membership, the docs' first-run flow
                # ("log in as admin at ldap.<domain>") hits a 403.
                admin_grant = (seed_body or {}).get("adminGrant") or {}
                if admin_grant.get("ok"):
                    log("✅ LLDAP `admin` user is in `admins` — Authelia admin-domain login enabled.")
                else:
                    reason = admin_grant.get("reason", "no reason returned")
                    log(f"⚠️ Could not grant LLDAP `admin` the `admins` group ({reason}). Add it manually in LLDAP's web UI or you'll get HTTP 403 from ldap.<domain>.")

                # #988 — operator user provisioning result
                op_prov = (seed_body or {}).get("operatorProvision") or {}
                if operator_email and op_prov.get("ok"):
                    op_uid = op_prov.get("uid") or derive_operator_uid(operator_email)
                    state = "created" if op_prov.get("created") else "already present"
                    log(f"✅ Operator LLDAP user `{op_uid}` ({state}) is in `admins`.")
                    # Surface the next step as a credential entry. The
                    # LLDAP URL is `http://{host}:{lldap_port}` here —
                    # post-install rendering picks up the NPM-mapped
                    # `https://ldap.{public_domain}/user/{uid}` once the
                    # subdomain is wired, but we point at LAN here for
                    # the operator's first run when SSO may not yet be
                    # fully reachable.
                    lldap_user_url = f"http://{host}:{lldap_port}/user/{op_uid}"
                    if public_domain:
                        lldap_user_url = f"https://ldap.{public_domain}/user/{op_uid}"
                    emit_credential(
                        service="Operator LLDAP user (set password to finish)",
                        url=lldap_user_url,
                        username=op_uid,
                        password="(set via LLDAP UI — click your user, then \"Set password\")",
                        importance="critical",
                        notes=(
                            "Your LLDAP user is pre-created and in the `admins` group. "
                            "LLDAP uses OPAQUE for passwords, so we can't seed one — sign in "
                            "to LLDAP's web UI as `admin` (see the credential above), open "
                            "this user, click \"Set password\", then log in to any "
                            f"{(public_domain or 'service')} subdomain as yourself."
                        ),
                    )
                elif operator_email and op_prov:
                    reason = op_prov.get("reason", "no reason returned")
                    log(f"⚠️ Could not auto-provision LLDAP user for OPERATOR_EMAIL ({reason}). Create it manually in LLDAP's web UI and add to the `admins` group.")
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

    # ── Swap Authelia's notifier from `filesystem` to `smtp` if the
    # operator configured email at install time. The mustache template
    # ships the filesystem notifier (Authelia writes notifications to
    # /data/notification.txt) as the safe default for boxes without
    # email; but that means password-reset / 2FA / OTP mails never
    # actually reach the user. Read the operator's SMTP config from
    # ServiceBay's on-disk config.json and rewrite the notifier block
    # in place, then signal Authelia to hot-reload. #987.
    rewrite_authelia_smtp_notifier(sb_api)

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


# ── Authelia SMTP notifier wiring ────────────────────────────────────
# Lives at the bottom of the file so the main() flow stays readable;
# these helpers do one job (read ServiceBay's email config, rewrite
# the notifier block on disk, signal reload) and nothing else.

# Path conventions:
#   - ServiceBay's config.json lives on host at /mnt/data/servicebay/config.json
#     (DATA_ROOT in install-fedora-coreos.sh). Post-deploy runs on the host
#     as the user that owns this script; that's root on Fedora CoreOS.
#   - Authelia's configuration.yml is at
#     /mnt/data/stacks/auth/authelia-config/configuration.yml — written by the
#     mustache rendering step before this script runs.
#   - Authelia hot-reloads SIGHUP, but with podman quadlet the cleanest
#     reload signal is `systemctl --user restart auth` (the pod) — sub-second.
SB_CONFIG_PATH = "/mnt/data/servicebay/config.json"
AUTHELIA_CONFIG_PATH = "/mnt/data/stacks/auth/authelia-config/configuration.yml"


def _sb_email_config(sb_api: str):
    """
    Returns the operator's SMTP config as a dict with keys
    {host, port, secure, user, pass, from}, or None if email isn't
    configured / can't be read.

    Tries the ServiceBay API first (the public-correct path); falls back
    to reading config.json directly off disk if the API call fails
    (post-deploy runs before user-systemd reaches `default.target` on
    some install timing paths).
    """
    # Path 1: API (auth-gated; templates have SB_API_TOKEN injected by
    # the install runner so this Just Works).
    token = env("SB_API_TOKEN")
    if token:
        try:
            req = urllib.request.Request(
                f"{sb_api}/api/settings",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                if 200 <= resp.status < 300:
                    cfg = json.loads(resp.read().decode("utf-8"))
                    em = (cfg.get("notifications") or {}).get("email") or {}
                    if em.get("host") and em.get("user") and em.get("pass") and em.get("from"):
                        return em
        except Exception:
            pass

    # Path 2: read config.json directly off disk.
    try:
        with open(SB_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        em = (cfg.get("notifications") or {}).get("email") or {}
        if em.get("host") and em.get("user") and em.get("pass") and em.get("from"):
            return em
    except Exception:
        pass

    return None


def _yaml_quote(s: str) -> str:
    """
    Single-quote a string for embedding in Authelia's YAML config.
    Authelia is strict about quoting in the notifier block — values with
    `@`, `:`, or whitespace fail to parse without quotes. Single-quotes
    require doubling internal single-quotes, no other escaping.
    """
    if s is None:
        return "''"
    return "'" + str(s).replace("'", "''") + "'"


def _smtp_notifier_block(em: dict) -> str:
    """Render the YAML for Authelia's smtp notifier, ready to drop in."""
    host = em["host"]
    port = int(em.get("port") or 587)
    secure = em.get("secure")
    # Authelia uses `disable_starttls` (default False = STARTTLS on).
    # ServiceBay's `secure: True` means "use implicit TLS" (port 465);
    # `secure: False` means STARTTLS (587). Map accordingly.
    submission_uri = f"submissions://{host}:{port}" if secure else f"submission://{host}:{port}"
    lines = [
        "notifier:",
        "  disable_startup_check: false",
        "  smtp:",
        f"    address: {_yaml_quote(submission_uri)}",
        f"    timeout: 10s",
        f"    username: {_yaml_quote(em['user'])}",
        f"    password: {_yaml_quote(em['pass'])}",
        f"    sender: {_yaml_quote(em['from'])}",
        f"    identifier: localhost",
        f"    subject: \"[Authelia] {{title}}\"",
        f"    startup_check_address: {_yaml_quote(em['user'])}",
        f"    disable_require_tls: false",
        f"    disable_html_emails: false",
        f"    tls:",
        f"      server_name: {_yaml_quote(host)}",
        f"      skip_verify: false",
        f"      minimum_version: TLS1.2",
    ]
    return "\n".join(lines) + "\n"


def rewrite_authelia_smtp_notifier(sb_api: str) -> None:
    """
    If the operator configured SMTP, rewrite Authelia's notifier block
    from `filesystem:` to `smtp:` (or no-op if SMTP isn't configured —
    a fresh install without email keeps the filesystem notifier, which
    at least logs to /data/notification.txt so the operator can see
    what Authelia would have sent).

    The rewrite is idempotent: a second run that sees the smtp block
    already present and matching the operator's current creds skips.

    Failures here are warnings, not errors — Authelia keeps working
    with whatever notifier it has; only the email-sending half of
    password-reset / 2FA / OTP flows is affected.
    """
    em = _sb_email_config(sb_api)
    if not em:
        log("ℹ️ No SMTP config found in ServiceBay settings — leaving Authelia's filesystem notifier in place. Configure email in Settings → Notifications + redeploy auth to enable Authelia email.")
        return

    try:
        with open(AUTHELIA_CONFIG_PATH, "r", encoding="utf-8") as f:
            current = f.read()
    except FileNotFoundError:
        log(f"⚠️ Authelia config not at {AUTHELIA_CONFIG_PATH} — skipping notifier rewrite.")
        return
    except Exception as e:
        log(f"⚠️ Couldn't read {AUTHELIA_CONFIG_PATH}: {e} — skipping notifier rewrite.")
        return

    new_block = _smtp_notifier_block(em)

    # Find the `notifier:` block and replace until the next top-level key.
    # Top-level keys are lines starting at column 0 with `<name>:` (the
    # next section header). We scan forward from `notifier:` for the next
    # such line and replace the slice.
    lines = current.splitlines(keepends=True)
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith("notifier:"):
            start = i
            break
    if start is None:
        log(f"⚠️ No `notifier:` block found in {AUTHELIA_CONFIG_PATH} — appending one. Authelia config may need manual review.")
        new_content = current.rstrip("\n") + "\n\n" + new_block
    else:
        end = len(lines)
        for j in range(start + 1, len(lines)):
            stripped = lines[j].rstrip("\n")
            if stripped and not stripped.startswith((" ", "\t", "#")):
                end = j
                break
        new_content = "".join(lines[:start]) + new_block + ("\n" if lines[end - 1].rstrip() else "") + "".join(lines[end:])

    if new_content == current:
        log("ℹ️ Authelia SMTP notifier already in sync with ServiceBay's email settings — no rewrite needed.")
        return

    # Atomic write (temp + rename) so a partial write can't leave Authelia
    # with malformed YAML that crashes the pod.
    tmp_path = AUTHELIA_CONFIG_PATH + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        os.replace(tmp_path, AUTHELIA_CONFIG_PATH)
    except Exception as e:
        log(f"⚠️ Failed to write updated Authelia config: {e} — leaving original in place.")
        try: os.unlink(tmp_path)
        except Exception: pass
        return

    log(f"✅ Rewrote Authelia notifier from `filesystem:` to `smtp:` ({em['host']}:{em.get('port', 587)}, user {em['user']}). Restarting auth pod to load the change…")

    # Hot-reload: simpler to restart the user-systemd auth unit than to
    # find Authelia's PID inside the pod. ServiceBay's HOST_USER is set
    # by the install runner.
    host_user = env("HOST_USER", "core")
    try:
        import subprocess
        subprocess.run(
            ["systemctl", "--user", "--machine", f"{host_user}@.host", "restart", "auth"],
            check=False, timeout=20,
        )
        log("✅ auth pod restarted — password-reset / 2FA / OTP emails should now arrive.")
    except Exception as e:
        log(f"⚠️ Couldn't restart auth pod ({e}). The new notifier config is on disk; restart manually with: systemctl --user restart auth")


if __name__ == "__main__":
    sys.exit(main())
