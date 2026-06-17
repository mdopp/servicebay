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
import subprocess
import sys
import time
import urllib.error
import urllib.request


# The postgres container inside the immich pod. Podman names a Pod's
# containers `<pod>-<container>`; this pod is `immich`, the DB container
# is `database` (see template.yml), so the running container is
# `immich-database`. Used by the OIDC-secret DB reconcile below.
DB_CONTAINER = "immich-database"

# The immich-server container inside the same pod (container `immich-server`).
# It's a Node app that bundles `bcrypt`, so we borrow its runtime to mint a
# bcrypt hash for the admin password rekey below — exactly the trick the NPM
# in-place admin rekey uses (hash inside the service's own container, write to
# its DB). Immich hashes `users.password` with bcrypt (`$2b$`, cost 11).
SERVER_CONTAINER = "immich-immich-server"


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


def _psql(db_password: str, sql: str, set_vars: dict[str, str] | None = None) -> tuple[int, str]:
    """Run a single SQL statement inside the immich-database container
    as the postgres superuser. Returns (returncode, stripped stdout).

    Uses `podman exec -i` (the same host-side capability file-share /
    home-assistant post-deploys use) and passes the password via
    PGPASSWORD in the container env so it never lands on the host process
    table. `-tA` gives one bare value per row, no headers/alignment.
    SQL is fed via stdin so that psql variable substitution (`:'name'`)
    works — psql only interpolates variables in stdin/file mode, not in
    `-c` command-line arguments.

    `set_vars` binds psql variables (`-v name=value`); reference them in
    `sql` as `:'name'` so psql does the literal quoting. This keeps an
    arbitrary secret value out of the SQL string entirely — no manual
    escaping, injection-safe whatever bytes the secret contains."""
    cmd = [
        "podman", "exec", "-i",
        "-e", f"PGPASSWORD={db_password}",
        DB_CONTAINER,
        "psql", "-U", "postgres", "-d", "immich", "-tA",
    ]
    for name, value in (set_vars or {}).items():
        cmd.extend(["-v", f"{name}={value}"])
    try:
        result = subprocess.run(
            cmd,
            input=sql,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        return result.returncode, (result.stdout or "").strip()
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️ psql exec against {DB_CONTAINER} failed: {exc}")
        return 1, ""


def reconcile_oidc_secret_in_db(sso_secret: str, db_password: str) -> bool:
    """Re-stamp Immich's stored OIDC client secret to match Authelia's
    freshly-registered one, writing straight to the database.

    Why this exists (#1556): Immich keeps its OIDC client secret in its
    database — survived DATA across a `wipe-configs` reinstall — while
    Authelia regenerates its copy from CONFIG. The two drift apart and the
    token exchange at /api/oidc/token fails with "Failed to finish oauth".
    The normal repair is the admin-authenticated PUT /api/system-config in
    main(), but on a wipe-configs reinstall the freshly-generated
    IMMICH_ADMIN_PASSWORD no longer matches the preserved admin row, so the
    admin login fails and that path never runs. This DB-level reconcile is
    the fallback that does not need an admin token — same class as the
    LLDAP FORCE_RESET / NPM in-place rekey.

    Immich stores its system config in the `system_metadata` table as a
    single jsonb row keyed `system-config`, holding only non-default
    overrides. We only touch `oauth.clientSecret`, and only when an
    `oauth` block already exists (a populated DATA dir) and its stored
    secret differs from the wizard's. Returns True iff it wrote a change.
    """
    code, current = _psql(
        db_password,
        "SELECT value->'oauth'->>'clientSecret' FROM system_metadata "
        "WHERE key='system-config';",
    )
    if code != 0:
        log("   ⚠️ Could not read Immich's stored OIDC secret from the DB — "
            "skipping DB reconcile. SSO may need a manual secret re-paste.")
        return False
    # Empty result: no system-config row yet, or no oauth block (fresh
    # DATA). Nothing to reconcile here — the API PUT path seeds it on a
    # successful admin login.
    if not current:
        log("   ℹ️ No stored OIDC secret in Immich's DB yet — nothing to reconcile "
            "(fresh data; the API path seeds it once admin login succeeds).")
        return False
    if current == sso_secret:
        log("   ✅ Immich's stored OIDC secret already matches Authelia — no reconcile needed.")
        return False

    # Re-stamp just the nested clientSecret, preserving every other oauth
    # field the operator/Immich set. jsonb_set with create_missing=false
    # only rewrites the existing leaf. The secret rides in via a psql
    # variable (:'secret') so psql quotes it — no manual escaping.
    code, _ = _psql(
        db_password,
        "UPDATE system_metadata "
        "SET value = jsonb_set(value, '{oauth,clientSecret}', to_jsonb(:'secret'::text), false) "
        "WHERE key='system-config';",
        set_vars={"secret": sso_secret},
    )
    if code != 0:
        log("   ⚠️ Failed to re-stamp Immich's OIDC secret in the DB — "
            "SSO may need a manual secret re-paste from the Immich UI.")
        return False
    log("   ✅ Reconciled Immich's stored OIDC secret to match Authelia (DB re-stamp).")
    return True


def _bcrypt_hash(password: str) -> str:
    """Mint a bcrypt hash for `password` inside the immich-server container,
    using the same `bcrypt` module Immich verifies logins with (cost 11,
    `$2b$`). Returns the hash, or '' on any failure.

    Why in the container and not in this script: the host has no bcrypt and
    we must match Immich's exact algorithm/cost so `bcrypt.compare` at login
    accepts it. The password rides in via an env var (not argv) so it never
    lands on the host/container process table, and the tiny Node program reads
    it from `process.env` — same containment as `_psql`'s PGPASSWORD."""
    node_src = (
        "const b=require('bcrypt');"
        "process.stdout.write(b.hashSync(process.env.SB_NEW_PW,11));"
    )
    cmd = [
        "podman", "exec",
        "-e", f"SB_NEW_PW={password}",
        SERVER_CONTAINER,
        "node", "-e", node_src,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️ bcrypt hash exec against {SERVER_CONTAINER} failed: {exc}")
        return ""
    out = (result.stdout or "").strip()
    if result.returncode != 0 or not out.startswith("$2"):
        log(f"   ⚠️ Could not mint a bcrypt hash inside {SERVER_CONTAINER} "
            f"(rc={result.returncode}). Admin password rekey skipped.")
        return ""
    return out


def rekey_admin_password_in_db(admin_email: str, new_password: str, db_password: str) -> bool:
    """Re-stamp the preserved Immich admin's password hash to match the
    freshly-generated IMMICH_ADMIN_PASSWORD, writing straight to the DB.

    Why this exists (#1928): on a reinstall over preserved immich pgdata, the
    persisted `users.password` row holds the OLD admin bcrypt while this install
    handed out a NEW IMMICH_ADMIN_PASSWORD. Admin login then 401s, the
    API-authenticated OIDC config path can't run, and #1904's
    reconcileImmichApiKey can't mint the External-Library admin key. There is no
    env-driven password reset in Immich — but we DO hold the DB credentials
    (DB_PASSWORD, the same ones _psql already uses), so we rekey in place: mint a
    bcrypt hash for the new password inside immich-server and UPDATE the admin
    row. Same class as the LLDAP FORCE_RESET / NPM in-place bcrypt rekey. This is
    an ACCESS credential, not an encryption key — re-keying it loses no data; the
    admin's photos/library are owned by the user row, not the password.

    Targets the admin by email (the seeded admin's login). Returns True iff it
    wrote a fresh hash. Idempotent-safe: the caller re-attempts login after, so a
    no-write just means login keeps failing and we degrade as before — we never
    report a masked success (feedback_dont_mask_failures)."""
    # Confirm the admin row exists before touching it — a fresh DATA dir has no
    # row yet (admin-sign-up creates it via the API), and we must not invent one.
    # Immich's schema names the table `user` (singular, a reserved word); we must
    # double-quote it in SQL so postgres doesn't parse it as a keyword.
    code, found = _psql(
        db_password,
        'SELECT 1 FROM "user" WHERE email = :\'email\' LIMIT 1;',
        set_vars={"email": admin_email},
    )
    if code != 0:
        log("   ⚠️ Could not query the Immich user table — skipping admin password rekey.")
        return False
    if not found:
        log(f"   ℹ️ No Immich admin row for {admin_email} yet — nothing to rekey "
            "(fresh data; admin-sign-up seeds it via the API).")
        return False

    new_hash = _bcrypt_hash(new_password)
    if not new_hash:
        return False  # _bcrypt_hash already logged the reason

    # The hash rides in via a psql variable (:'hash') so psql quotes it — no
    # manual escaping. `$2b$...` contains only bcrypt-alphabet chars, but the
    # bound-variable form is injection-safe regardless.
    # Table is `"user"` (double-quoted reserved word) per Immich's schema.
    code, _ = _psql(
        db_password,
        'UPDATE "user" SET password = :\'hash\' WHERE email = :\'email\';',
        set_vars={"hash": new_hash, "email": admin_email},
    )
    if code != 0:
        log("   ⚠️ Failed to re-stamp the Immich admin password hash in the DB.")
        return False
    log(f"   ✅ Rekeyed the preserved Immich admin password for {admin_email} "
        "to this install's IMMICH_ADMIN_PASSWORD (DB re-stamp).")
    return True


def login_admin(base_url: str, email: str, password: str) -> tuple[int, object | None, str | None]:
    """Log in as the admin, riding through the brief post-sign-up window where
    Immich 401s while the user row propagates to the auth cache. Returns
    (last status, last body, accessToken-or-None). ~20s with 2.5s backoff."""
    code, body, token = 0, None, None
    for attempt in range(8):
        code, body = request_json(
            "POST",
            f"{base_url}/api/auth/login",
            {"email": email, "password": password},
        )
        token = body.get("accessToken") if isinstance(body, dict) else None
        if code == 201 and token:
            return code, body, token
        if attempt == 0:
            log(f"   admin login attempt 1 returned HTTP {code} — retrying for ~20s while Immich settles...")
        time.sleep(2.5)
    return code, body, token


def main() -> int:
    port = env("IMMICH_PORT", "2283")
    public_domain = env("PUBLIC_DOMAIN")
    sso_enabled = env("IMMICH_SSO_ENABLED") == "true"
    sso_secret = env("IMMICH_SSO_SECRET")
    admin_name = env("IMMICH_ADMIN_NAME", "Admin")
    # IMMICH_ADMIN_EMAIL defaults to empty in variables.json — operators
    # who blow through the configure step never fill it in, and the
    # seed step then skipped silently. Fall back to OPERATOR_EMAIL (the
    # canonical email ServiceBay already collects for notifications)
    # so a typical install gets a real address without prompting twice.
    admin_email = env("IMMICH_ADMIN_EMAIL") or env("OPERATOR_EMAIL")
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
        log("⚠️  No admin email available (IMMICH_ADMIN_EMAIL + OPERATOR_EMAIL both blank) "
            "or IMMICH_ADMIN_PASSWORD missing — skipping admin seed and OIDC config. "
            "Fill in Settings → Notifications → email so future installs auto-seed, "
            "then re-run from Diagnose → post_deploy_failed.")
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
    # `admin-sign-up` returns 200/201 the instant the row is written, but
    # Immich's auth path occasionally rejects the immediate follow-up login
    # with HTTP 401 while the user row is still propagating to the auth
    # cache. Short retry loop rides through that.
    #
    # A persistent 401 after retries means something different: the admin
    # row pre-dates this install and was created with a different password
    # (preserved data dir + freshly-generated IMMICH_ADMIN_PASSWORD that
    # never made it into savedSecrets). We DO hold the DB credentials
    # (DB_PASSWORD), so we now auto-rekey the admin password hash in place
    # (#1928, rekey_admin_password_in_db below) and retry login — same class
    # as LLDAP FORCE_RESET / NPM in-place rekey. Only if that still can't
    # produce a token do we degrade: skip OIDC, surface what the operator
    # needs, exit zero (Immich stays reachable via Authelia forward-auth).
    db_password = env("DB_PASSWORD")
    code, body, token = login_admin(base_url, admin_email, admin_password)
    if (code != 201 or not token) and db_password:
        log("   Admin login still rejected after retries — the preserved pgdata holds "
            "a different admin password. Attempting an in-place DB rekey (#1928)…")
        if rekey_admin_password_in_db(admin_email, admin_password, db_password):
            # Hash is updated; log in once more so the API-authenticated OIDC
            # path (and #1904's API-key mint) can run on this same install.
            code, body, token = login_admin(base_url, admin_email, admin_password)
            if code == 201 and token:
                log("   ✅ Admin login succeeded after the DB rekey — the preserved "
                    "Immich admin now accepts this install's password.")
    if code != 201 or not token:
        log(
            f"ℹ️  Immich admin login returns HTTP {code} — the admin row pre-dates this install "
            "and holds a different password than the wizard's value (preserved DATA + a freshly "
            "generated IMMICH_ADMIN_PASSWORD). The API-authenticated OIDC config path can't run."
        )
        # This is exactly the wipe-configs case #1556 fixes: the admin
        # login can't happen, but Immich's stored OIDC client secret
        # (survived DATA) has drifted from Authelia's freshly-regenerated
        # one (CONFIG). Reconcile it directly in the DB — no admin token
        # needed — so SSO works without a manual re-paste. The rest of the
        # OAuth config (issuer URL, auth method, etc.) already survived in
        # the same DATA, so only the secret can have gone stale.
        if sso_enabled and sso_secret and db_password:
            log("   Attempting a DB-level OIDC secret reconcile (no admin login required)…")
            reconcile_oidc_secret_in_db(sso_secret, db_password)
        elif sso_enabled and not db_password:
            log("   ⚠️ DB_PASSWORD unavailable — cannot DB-reconcile the OIDC secret. "
                "SSO may need a manual secret re-paste from the Immich UI.")
        log(
            "   The service stays reachable via Authelia forward-auth. If SSO still fails, reset "
            "Immich's admin from the Immich UI (forgot-password flow) or DROP the user table in "
            "the immich-database container and re-run this post-deploy from Diagnose."
        )
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
        # Immich 2.x added three required oauth fields that older
        # immich-server builds tolerated being absent. PATCH/PUT now
        # 400s with `should not be empty` / `must be a string` if
        # any of them are missing.
        #   - tokenEndpointAuthMethod: how Immich authenticates to the
        #     OIDC provider when redeeming the auth code. Authelia
        #     accepts both `client_secret_post` and `client_secret_basic`;
        #     `client_secret_post` is the safer default for first-time
        #     setups (won't trip basic-auth parsing on proxies).
        #   - profileSigningAlgorithm: signing algo Immich expects on
        #     the userinfo JWT response. Authelia does NOT sign
        #     `/api/oidc/userinfo` by default (the response is plain
        #     JSON, not a JWS). Earlier code set `RS256` here on the
        #     theory that "the field has to be a non-empty string" —
        #     that was wrong. Immich's openid-client@6.x then expects
        #     a JWT in the response and throws
        #     `OAUTH_JWT_USERINFO_EXPECTED` when it gets JSON
        #     ("Failed to finish oauth" 500). `none` tells Immich
        #     userinfo is unsigned JSON and the callback completes.
        #     If a future operator wants signed userinfo, they
        #     additionally need `userinfo_signed_response_alg` on
        #     the Authelia client registration — at which point
        #     they can flip this back to `RS256`.
        #   - roleClaim: optional claim name that maps to Immich admin
        #     role. Empty string opts out of role-based assignment —
        #     operators promote to admin manually for now.
        "tokenEndpointAuthMethod": "client_secret_post",
        "profileSigningAlgorithm": "none",
        "roleClaim": "",
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
