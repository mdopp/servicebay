#!/usr/bin/env python3
"""
post-deploy hook for the `media` stack (Audiobookshelf + Jellyfin).

Convention (see lib/registry.ts:getTemplatePostDeployScript):
  - Runs on the agent host after `systemctl --user start media.service`
    succeeds.
  - All wizard variables are exported as env vars (`os.environ['ABS_PORT']`
    etc.). `SB_NODE` is the node name. `HOST` is the operator's browsing
    hostname (set by the wizard from window.location).
  - stdout is relayed to the install log line by line.
  - Lines starting with `__SB_CREDENTIAL__ ` followed by JSON go into the
    SAVE-THESE-NOW banner / Bitwarden export — emit one per service.
  - Non-zero exit logs a warning but doesn't roll back the deploy.

Schema v4 swapped Navidrome for Jellyfin so Symfonium / Findroid /
Streamyfin can pair via Quick Connect (the closest practical thing to
SSO for music-app pairing — operator confirms a 6-digit code in the
web UI once, app is paired). Audiobookshelf section is unchanged.

What this does for Jellyfin:
  1. Wait for /System/Info/Public to come up (image-pull budget).
  2. Walk /Startup/* to skip the first-run wizard and seed the admin
     user from JELLYFIN_ADMIN_PASSWORD.
  3. Authenticate against /Users/AuthenticateByName to get a token.
  4. POST /QuickConnect/Enable so mobile apps can pair without
     shared passwords.
  5. Add /media/music as a "Music" virtual folder and /media/audiobooks
     as a "Books" virtual folder so both scans start immediately. #1725
     retired Audiobookshelf for fresh installs, so Jellyfin owns the
     audiobooks library now. Other subdirs (movies/, tv/) stay
     un-imported — operator adds them by hand if wanted. Lowercase
     folder names are the convention per #1018.

Best-effort throughout: each step that fails just logs a clear
breadcrumb so the operator can finish the setup manually in the
Jellyfin UI — non-zero exit only on something that breaks the
banner output.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def env(key: str, default: str = "") -> str:
    """Fetch an env var, falling back to a default. Empty string means missing."""
    val = os.environ.get(key, default)
    return val if val else default


def emit_credential(**fields: object) -> None:
    """Print a single SAVE-THESE-NOW banner entry. The wizard parses this."""
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def render_http_code(code: int) -> str:
    """Render a `request_json` status code in a way the operator can
    immediately interpret. `code == 0` is our local convention for "the
    request never reached the server" (URLError/TimeoutError/OSError);
    "returned 0" reads like a successful exit code, so spell that case
    out instead of leaving the operator to guess (#734)."""
    if code == 0:
        return "no response (connection refused / DNS / timeout)"
    return f"HTTP {code}"


REQUEST_TIMEOUT = 30.0

# Jellyfin first-run readiness gate (#809). Module-level so the test
# suite can shrink the budget.
JELLYFIN_READY_TIMEOUT = 5 * 60
JELLYFIN_READY_INTERVAL = 5

# Pod-container names. Podman names a Pod's containers `<pod>-<container>`;
# this pod is `media`, the containers are `audiobookshelf` and `jellyfin`
# (see template.yml). Used by the DB-level OIDC reconcile (#1717) and the
# Jellyfin LDAP plugin restart (#1718).
ABS_CONTAINER = "media-audiobookshelf"
JELLYFIN_CONTAINER = "media-jellyfin"

# Audiobookshelf stores its server settings — including the OIDC
# client_secret — as a single JSON row in this SQLite DB inside the
# container's /config volume. Used by the no-login DB reconcile (#1717).
ABS_DB_PATH = "/config/absdatabase.sqlite"


def request_json(
    method: str,
    url: str,
    payload: object | None = None,
    token: str | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: float = REQUEST_TIMEOUT,
) -> tuple[int, object | None]:
    """Generic HTTP helper — GET/PATCH/POST with optional Bearer auth and extra headers."""
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers: dict[str, str] = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if extra_headers:
        headers.update(extra_headers)
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


def post_json(url: str, payload: dict[str, object], timeout: float = 10.0) -> tuple[int, dict[str, object] | None]:
    """POST JSON via the ServiceBay internal API (X-SB-Internal-Token if set)."""
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("SB_API_TOKEN", "")
    if token:
        headers["X-SB-Internal-Token"] = token
    req = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method="POST",
    )
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


# ── Audiobookshelf seed (unchanged from v3) ────────────────────────────


def seed_audiobookshelf(port: str, user: str, password: str) -> None:
    """Talk to ServiceBay's media-init proxy endpoint so ABS gets its admin
    seeded. Idempotent; reports alreadySetup on second run."""
    if not password:
        log(f"⚠️ Audiobookshelf: no admin password in env (ABS_ADMIN_PASSWORD), skipping seed.")
        return

    sb_api = env("SB_API_URL", "http://localhost:3000")
    init_url = f"{sb_api}/api/system/media/init"

    log("Waiting for Audiobookshelf to start...")
    started = time.time()
    last_beat = 0.0
    deadline = 5 * 60
    while time.time() - started < deadline:
        status, body = post_json(init_url, {
            "service": "audiobookshelf",
            "host": "localhost",
            "port": int(port),
            "username": user,
            "password": password,
        }, timeout=15)
        # The proxy returns one of:
        #   { ok: true }              — admin just created
        #   { alreadySetup: true }    — service already has an admin
        #   { error: '...' }          — anything else
        # Either of the first two is a terminal success — the old check
        # required `body.get("ok") && body.get("alreadySetup")`, but the
        # proxy never returns both together, so on a re-install the
        # alreadySetup signal was missed and the post-deploy spun until
        # its 5-min deadline.
        if status == 200 and isinstance(body, dict):
            if body.get("alreadySetup"):
                log("ℹ️ Audiobookshelf already initialized — keeping existing admin. Reset manually if the password doesn't match.")
                return
            if body.get("ok"):
                log(f"✅ Audiobookshelf root user '{user}' created.")
                return
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            log(f"Still waiting for Audiobookshelf ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(5)

    log(f"⚠️ Audiobookshelf did not become reachable in 5 minutes. Open http://<server-ip>:{port} and create the admin user manually.")


# ── Jellyfin first-run + Quick Connect + Music library ───────────────


# Pseudo-device identity sent to /Users/AuthenticateByName so Jellyfin's
# auth log shows where the token came from. The Device + DeviceId pair
# also lets the operator revoke this token cleanly from
# Dashboard → API Keys if they want a clean audit trail.
JELLYFIN_AUTH_HEADER = (
    'MediaBrowser Client="ServiceBay", Device="post-deploy", '
    'DeviceId="servicebay-postdeploy", Version="1.0"'
)


def jellyfin_wait_default_user(base_url: str) -> bool:
    """Poll `GET /Startup/FirstUser` until it returns 200.

    That endpoint runs the UserManager's async init pass — which creates
    Jellyfin's default user — *before* responding. A successful GET
    therefore both confirms Jellyfin is up AND guarantees the default
    user exists. `POST /Startup/User` does NOT initialize the
    UserManager; it just calls `GetFirstUser()` and returns 404
    ("NotFound") when no user exists yet. So without this wait the admin
    seed races first-run init and Jellyfin answers 404.

    Phase 3C retired the install runner's per-template readiness probe
    that used to do this wait, so it has to live back in this script
    (#809). Returns True once ready, False if the deadline passes."""
    started = time.time()
    last_beat = 0.0
    while time.time() - started < JELLYFIN_READY_TIMEOUT:
        code, _ = request_json("GET", f"{base_url}/Startup/FirstUser", timeout=10)
        if code == 200:
            return True
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            log(f"Waiting for Jellyfin to finish first-run init ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(JELLYFIN_READY_INTERVAL)
    return False


def jellyfin_run_first_setup(base_url: str, admin_user: str, admin_password: str, tz: str) -> bool:
    """Walk the /Startup/* sequence to bypass the interactive wizard.
    Returns True on a clean walk; on any non-2xx step the function bails
    early so the operator finishes setup in the browser instead of
    leaving Jellyfin half-configured."""
    # Idempotent guard: if the public info already says wizard is done,
    # skip — this lets the post-deploy re-run without resetting admin.
    code, info = request_json("GET", f"{base_url}/System/Info/Public", timeout=10)
    if code == 200 and isinstance(info, dict) and info.get("StartupWizardCompleted"):
        log("ℹ️ Jellyfin startup wizard already completed — leaving the existing admin.")
        return True

    # Wait for Jellyfin's UserManager to finish initializing before
    # touching any /Startup/* endpoint (#809) — POST /Startup/User 404s
    # until the default user exists.
    if not jellyfin_wait_default_user(base_url):
        log(f"⚠️ Jellyfin: /Startup/FirstUser never returned 200 within {JELLYFIN_READY_TIMEOUT // 60} min — install-blocking. Open the Jellyfin web UI and finish the setup wizard manually.")
        return False

    # Locale + metadata language. German default to match the home;
    # operator can change in Settings → Server later.
    code, _ = request_json("POST", f"{base_url}/Startup/Configuration", {
        "UICulture": "de-DE",
        "MetadataCountryCode": "DE",
        "PreferredMetadataLanguage": "de",
    })
    if code not in (200, 204):
        log(f"⚠️ Jellyfin: POST /Startup/Configuration → {render_http_code(code)} — install-blocking. Open Dashboard → Server and finish the locale step before using Jellyfin.")
        return False

    # Admin user.
    code, _ = request_json("POST", f"{base_url}/Startup/User", {
        "Name": admin_user,
        "Password": admin_password,
    })
    if code not in (200, 204):
        log(f"⚠️ Jellyfin: POST /Startup/User → {render_http_code(code)} — install-blocking. Admin '{admin_user}' was not created; finish the wizard at the web UI and set the password to the one shown in the credentials banner.")
        return False

    # Remote access settings: enable HTTP access from non-LAN clients
    # (NPM proxies them in anyway), disable UPnP — Jellyfin shouldn't
    # be poking the FritzBox port-map; we own that via ServiceBay.
    code, _ = request_json("POST", f"{base_url}/Startup/RemoteAccess", {
        "EnableRemoteAccess": True,
        "EnableAutomaticPortMapping": False,
    })
    if code not in (200, 204):
        # Non-fatal — the operator can flip these in Dashboard later.
        log(f"(note) Jellyfin: POST /Startup/RemoteAccess → {render_http_code(code)} — non-blocking; flip the remote-access toggles in Dashboard if Jellyfin isn't reachable from outside the LAN.")

    code, _ = request_json("POST", f"{base_url}/Startup/Complete", {})
    if code not in (200, 204):
        log(f"⚠️ Jellyfin: POST /Startup/Complete → {render_http_code(code)} — install-blocking. Open Dashboard at the web UI and click 'Finish' on the wizard so Jellyfin leaves first-run mode.")
        return False

    log(f"✅ Jellyfin first-run wizard skipped; admin '{admin_user}' seeded.")
    return True


def jellyfin_get_token(base_url: str, admin_user: str, admin_password: str) -> str | None:
    """Authenticate as the seeded admin and return an access token. Each
    /Users/AuthenticateByName needs the X-Emby-Authorization client
    identifier — the server returns 400 without it."""
    code, body = request_json(
        "POST", f"{base_url}/Users/AuthenticateByName",
        {"Username": admin_user, "Pw": admin_password},
        extra_headers={"X-Emby-Authorization": JELLYFIN_AUTH_HEADER},
    )
    if code == 200 and isinstance(body, dict):
        return body.get("AccessToken")
    log(f"⚠️ Jellyfin authentication failed (HTTP {code}). Skipping Quick Connect + library auto-add.")
    return None


def jellyfin_enable_quick_connect(base_url: str, token: str) -> None:
    """Enable Quick Connect server-side. Mobile apps then offer a "Quick
    Connect" sign-in button that pairs without typing the password."""
    code, _ = request_json(
        "POST", f"{base_url}/QuickConnect/Enable?status=true",
        None,
        extra_headers={
            "X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"',
        },
    )
    if code in (200, 204):
        log("✅ Jellyfin Quick Connect enabled — mobile apps can pair via 6-digit code.")
    else:
        log(f"(note) Could not enable Quick Connect via API (HTTP {code}) — flip it in Dashboard → General → Quick Connect.")


def jellyfin_add_music_library(base_url: str, token: str, music_path: str) -> None:
    """Register a 'Music' collection pointing at /media/music inside the
    container (which is the mounted host {{JELLYFIN_MEDIA_PATH}}/music).
    Lowercase by convention per #1018 so the folder sits cleanly alongside
    `audiobooks/`, `podcasts/`, and `notes/` under the same data root.
    Idempotent: a 400 with `LibraryAlreadyExists` is treated as success."""
    # The path that Jellyfin sees — /media is the container-side mount
    # of JELLYFIN_MEDIA_PATH on the host. The wizard's MEDIA_PATH
    # default is /mnt/data/stacks/file-share/data so /media/music maps
    # to /mnt/data/stacks/file-share/data/music on the host.
    container_path = "/media/music"
    qs = f"?name=Music&collectionType=music&paths={container_path}&refreshLibrary=true"
    code, body = request_json(
        "POST", f"{base_url}/Library/VirtualFolders{qs}",
        None,
        extra_headers={
            "X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"',
        },
    )
    if code in (200, 204):
        log(f"✅ Added 'Music' library → {container_path} (scan started).")
    elif code == 400 and isinstance(body, dict) and "exists" in str(body).lower():
        log("ℹ️ Music library already registered — leaving as-is.")
    else:
        log(f"(note) Could not auto-add Music library (HTTP {code}). Add it manually in Dashboard → Libraries.")
    # Operator hint: tell them how to wire movies/tv/etc. The post-deploy
    # doesn't auto-add those — Jellyfin's metadata sources differ per
    # library type and we don't want to commit to a default. Lowercase
    # folder names match the file-share convention (#1018).
    log(f"   (Add movies/tv/photos libraries later from Dashboard → Libraries → Add Media Library; mount points live under /media/ inside the container — same tree as {music_path} on the host.)")


def jellyfin_add_audiobooks_library(base_url: str, token: str) -> None:
    """Register a 'Books' collection pointing at /media/audiobooks inside the
    container (the mounted host {{JELLYFIN_MEDIA_PATH}}/audiobooks). #1725:
    Audiobookshelf is retired for fresh installs, so Jellyfin now serves the
    audiobooks library — Symfonium et al. speak Jellyfin natively. Lowercase
    folder name per #1018, alongside `music/`, `podcasts/`, `notes/`.
    Idempotent: a 400 with `LibraryAlreadyExists` is treated as success, so a
    redeploy never duplicates the library."""
    # /media is the container-side mount of JELLYFIN_MEDIA_PATH; the wizard
    # default is /mnt/data/stacks/file-share/data so /media/audiobooks maps
    # to /mnt/data/stacks/file-share/data/audiobooks on the host — the same
    # tree where the imported Hörspiele already live.
    container_path = "/media/audiobooks"
    qs = f"?name=Audiobooks&collectionType=books&paths={container_path}&refreshLibrary=true"
    code, body = request_json(
        "POST", f"{base_url}/Library/VirtualFolders{qs}",
        None,
        extra_headers={
            "X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"',
        },
    )
    if code in (200, 204):
        log(f"✅ Added 'Audiobooks' library → {container_path} (scan started).")
    elif code == 400 and isinstance(body, dict) and "exists" in str(body).lower():
        log("ℹ️ Audiobooks library already registered — leaving as-is.")
    else:
        log(f"(note) Could not auto-add Audiobooks library (HTTP {code}). Add it manually in Dashboard → Libraries (content type: Books, path /media/audiobooks).")


def configure_abs_oidc(
    abs_port: str,
    abs_user: str,
    abs_password: str,
    public_domain: str,
    oidc_secret: str,
) -> bool:
    """Configure Audiobookshelf OIDC via its /api/auth-settings API.
    Tries 127.0.0.1 and [::1] because Node.js on FCoS may bind IPv6-only.
    Returns True if the settings were written successfully."""
    issuer_url = f"https://auth.{public_domain}"

    # 1. Login to get a bearer token (x-return-tokens: true puts it in the body).
    token: str | None = None
    abs_base: str | None = None
    for host in (f"http://127.0.0.1:{abs_port}", f"http://[::1]:{abs_port}"):
        code, body = request_json(
            "POST", f"{host}/login",
            {"username": abs_user, "password": abs_password},
            extra_headers={"x-return-tokens": "true"},
        )
        if code == 200 and isinstance(body, dict):
            token = (body.get("user") or {}).get("accessToken")
            if token:
                abs_base = host
                break

    if not token or not abs_base:
        log("⚠️  Could not log in to Audiobookshelf for OIDC setup — skipping auto-config.")
        return False

    # 2. Fetch endpoint URLs from Authelia's OIDC discovery document.
    #    Two probes in order so the install path doesn't depend on
    #    DNS or router-hairpin being ready yet:
    #      a) http://localhost:<AUTHELIA_PORT>/.well-known/...
    #         Authelia runs rootless+hostNetwork on this box, so its
    #         port is reachable from the post-deploy shell even
    #         before AdGuard rewrites are provisioned. This is the
    #         path that works on a fresh install.
    #      b) https://auth.<PUBLIC_DOMAIN>/.well-known/...
    #         The public URL. Works once DNS is set up; useful when
    #         the operator is re-running the seed long after install
    #         and the localhost port may have moved.
    #    Discovery values point at the *public* issuer regardless of
    #    which probe answered — clients hit those URLs from a
    #    browser, not from the host.
    # Discovery candidate order matches the `oidc_provider_reachable`
    # diagnose probe, which is known to succeed against the running
    # Authelia (#735). Two prior issues with the old order:
    #   - `localhost` resolved IPv6 first on some FCoS builds while
    #     Authelia binds IPv4-only — every probe returned code=0 and
    #     fell into the hardcoded-path branch.
    #   - The public URL was attempted before DNS/proxy was ready, so
    #     the second candidate also failed and the fallback message
    #     ran on every install.
    # Probe 127.0.0.1 first (loopback IPv4, matches the diagnose probe
    # at oidcProviderReachable.ts:49), then ::1 for IPv6-only binds,
    # then the public URL for re-runs against a settled install.
    authelia_port = env("AUTHELIA_PORT", "9091")
    discovery_candidates = [
        f"http://127.0.0.1:{authelia_port}",
        f"http://[::1]:{authelia_port}",
        issuer_url,
    ]
    disc = None
    last_codes: list[str] = []
    for candidate in discovery_candidates:
        code, body = request_json("GET", f"{candidate}/.well-known/openid-configuration")
        if code == 200 and isinstance(body, dict):
            disc = body
            log(f"ℹ️  Authelia OIDC discovery via {candidate}.")
            break
        last_codes.append(f"{candidate} → {render_http_code(code)}")
    if disc is not None:
        auth_url = disc.get("authorization_endpoint", "")
        token_url = disc.get("token_endpoint", "")
        userinfo_url = disc.get("userinfo_endpoint", "")
        jwks_url = disc.get("jwks_uri", "")
    else:
        # If we ever land here the install will still complete (the
        # hardcoded Authelia-4.x paths match the discovery doc verbatim),
        # but the diagnose probe at the same endpoint is known to work,
        # so seeing this branch on a successful install means something
        # changed about how the post-deploy reaches Authelia. Log every
        # candidate's outcome so the next operator can compare against
        # the diagnose probe instead of re-discovering this.
        log(f"ℹ️  Authelia OIDC discovery unreachable on every candidate — falling back to known Authelia 4.x paths. Candidates: {'; '.join(last_codes)}.")
        auth_url = f"{issuer_url}/api/oidc/authorization"
        token_url = f"{issuer_url}/api/oidc/token"
        userinfo_url = f"{issuer_url}/api/oidc/userinfo"
        jwks_url = f"{issuer_url}/jwks.json"

    # 3. Write auth settings. `authOpenIDSubfolderForRedirectURLs` set
    # explicitly to '' — without it ABS sends `/undefined/auth/openid/
    # callback`, which Authelia rejects as redirect_uri mismatch. See
    # templates/media/CHANGELOG.md v3 for the full story.
    code, resp = request_json(
        "PATCH", f"{abs_base}/api/auth-settings",
        {
            "authActiveAuthMethods": ["local", "openid"],
            "authOpenIDIssuerURL": issuer_url,
            "authOpenIDAuthorizationURL": auth_url,
            "authOpenIDTokenURL": token_url,
            "authOpenIDUserInfoURL": userinfo_url,
            "authOpenIDJwksURL": jwks_url,
            "authOpenIDClientID": "audiobookshelf",
            "authOpenIDClientSecret": oidc_secret,
            "authOpenIDButtonText": "Login with Authelia",
            "authOpenIDAutoLaunch": False,
            "authOpenIDAutoRegister": True,
            "authOpenIDMatchExistingBy": "email",
            "authOpenIDTokenSigningAlgorithm": "RS256",
            "authOpenIDSubfolderForRedirectURLs": "",
        },
        token=token,
    )
    if code == 200:
        log(f"✅ Audiobookshelf OIDC configured against {issuer_url}.")
        return True
    log(f"⚠️  Could not write ABS OIDC settings (HTTP {code}): {resp}.")
    return False


def _abs_sqlite(sql: str) -> tuple[int, str]:
    """Run a single SQL statement against Audiobookshelf's SQLite DB inside
    the running container as `podman exec … sqlite3`. Returns (returncode,
    stripped stdout).

    Same host-side capability the file-share / home-assistant post-deploys
    use. The advplyr/audiobookshelf image ships `sqlite3`. We pass the SQL
    on argv (no shell), and never put a secret in the SQL string — the
    re-stamp binds the new secret via `json_set(..., json(:value))` style
    quoting done in SQL with the value carried as a separate `-cmd` bind is
    not available in plain sqlite3, so the caller escapes the value with
    json_quote() server-side instead (see reconcile_abs_oidc_secret_in_db).
    """
    cmd = [
        "podman", "exec", ABS_CONTAINER,
        "sqlite3", ABS_DB_PATH, sql,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=30,
        )
        return result.returncode, (result.stdout or "").strip()
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️ sqlite3 exec against {ABS_CONTAINER} failed: {exc}")
        return 1, ""


def reconcile_abs_oidc_secret_in_db(oidc_secret: str) -> bool:
    """Re-stamp Audiobookshelf's stored OIDC client_secret to match
    Authelia's freshly-registered one, writing straight to the SQLite DB —
    no admin login required.

    Why this exists (#1717): ABS keeps its OIDC client_secret in its
    settings DB (survived DATA across a `wipe-configs` reinstall) while
    Authelia regenerates its copy from CONFIG. The two drift and the token
    exchange at /api/oidc/token fails with `invalid_client` — an endless
    login loop. The normal repair is the admin-authenticated PATCH
    /api/auth-settings in `configure_abs_oidc`, but on a wipe-configs
    reinstall the freshly-generated ABS_ADMIN_PASSWORD no longer matches
    the preserved admin row, so the admin login fails and that path never
    runs. This DB-level reconcile is the no-token fallback — same class as
    the LLDAP FORCE_RESET / NPM in-place rekey / Immich DB re-stamp (#1556).

    ABS stores its server settings as a single JSON row in the `settings`
    table keyed `server-settings`; the OIDC secret lives at
    `$.authOpenIDClientSecret`. We only touch that leaf, only when a
    `server-settings` row already exists (populated DATA) and its stored
    secret differs from the wizard's. The new value is quoted by SQLite's
    `json_quote()` so no manual escaping is needed and ABS user/library
    data is never touched. Returns True iff it wrote a change.
    """
    # Read the currently-stored secret. json_extract returns NULL (empty
    # stdout) when the row or the key is absent.
    code, current = _abs_sqlite(
        "SELECT json_extract(value, '$.authOpenIDClientSecret') "
        "FROM settings WHERE key='server-settings';"
    )
    if code != 0:
        log("   ⚠️ Could not read Audiobookshelf's stored OIDC secret from the DB — "
            "skipping DB reconcile. SSO may need a manual secret re-paste.")
        return False
    # Empty result: no server-settings row yet, or no OIDC secret stored
    # (fresh DATA). Nothing to reconcile — the API path seeds it once the
    # admin login succeeds.
    if not current:
        log("   ℹ️ No stored OIDC secret in Audiobookshelf's DB yet — nothing to "
            "reconcile (fresh data; the API path seeds it once admin login succeeds).")
        return False
    if current == oidc_secret:
        log("   ✅ Audiobookshelf's stored OIDC secret already matches Authelia — no reconcile needed.")
        return False

    # Re-stamp just the nested authOpenIDClientSecret, preserving every
    # other server-settings field. The secret is wrapped in json_quote()
    # so SQLite does the literal quoting — no manual escaping, and the
    # value never lands in a log line. `json_set` rewrites only the named
    # leaf; the rest of the settings blob is untouched.
    escaped = oidc_secret.replace("'", "''")
    code, _ = _abs_sqlite(
        "UPDATE settings SET value = "
        "json_set(value, '$.authOpenIDClientSecret', "
        f"json_extract(json_quote('{escaped}'), '$')) "
        "WHERE key='server-settings';"
    )
    if code != 0:
        log("   ⚠️ Failed to re-stamp Audiobookshelf's OIDC secret in the DB — "
            "SSO may need a manual secret re-paste from the ABS UI.")
        return False
    log("   ✅ Reconciled Audiobookshelf's stored OIDC secret to match Authelia (DB re-stamp).")
    # ABS reads server-settings into memory at startup, so the running
    # process keeps the stale secret until restart. Bounce the container
    # so the reconciled secret takes effect without operator action.
    try:
        subprocess.run(
            ["podman", "container", "restart", ABS_CONTAINER],
            capture_output=True, text=True, check=False, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️ Could not restart {ABS_CONTAINER} after the secret re-stamp ({exc}); "
            "restart the media stack so ABS picks up the reconciled OIDC secret.")
    return True


# ── Jellyfin LDAP-Authentication plugin → LLDAP (#1718) ──────────────────


# The Jellyfin LDAP-Authentication plugin reads its config from this XML
# file inside the container's /config volume, which maps to
# {DATA_DIR}/media/jellyfin-config on the host. Writing it host-side (and
# bouncing the container) is deterministic + idempotent — same pattern as
# the HA zwave external-settings seed.
JELLYFIN_LDAP_CONFIG_REL = os.path.join(
    "media", "jellyfin-config", "plugins", "configurations", "LDAP-Auth.xml",
)


def render_ldap_plugin_config(
    ldap_host: str,
    ldap_port: str,
    base_dn: str,
    bind_dn: str,
    bind_password: str,
    admin_group_dn: str,
) -> str:
    """Render the Jellyfin LDAP-Auth plugin's `LDAP-Auth.xml`.

    Mirrors how Radicale binds LLDAP (templates/radicale/template.yml):
      - server  ldap://host.containers.internal:3890
      - base    dc=dopp,dc=cloud, users under ou=people
      - bind    uid=admin,ou=people,dc=dopp,dc=cloud
      - filter  (&(objectClass=person)(uid={0}))  → here the plugin uses
                its own `{username}` token, so the search filter is
                `(uid={username})` scoped under the people OU.
      - admin   members of the LLDAP `lldap_admin` group map to Jellyfin
                admins; everyone else gets a standard Jellyfin user.

    `EnableLdapAdminFilter` + `LdapAdminBaseDn`/`LdapAdminFilter` gate who
    becomes a Jellyfin admin. `CreateUsersFromLdap` auto-provisions a
    Jellyfin account on first LDAP login. The local `admin` account stays
    a working break-glass login — this plugin adds LDAP as an *additional*
    auth provider; it does not disable Jellyfin's own user DB.
    """
    people_base = f"ou=people,{base_dn}"
    # `{username}` is the plugin's substitution token for the typed login.
    search_filter = "(&amp;(objectClass=person)(uid={username}))"
    admin_filter = f"(memberOf={admin_group_dn})"
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<PluginConfiguration xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        f"  <LdapServer>{ldap_host}</LdapServer>\n"
        "  <LdapBaseDn>" + people_base + "</LdapBaseDn>\n"
        f"  <LdapPort>{ldap_port}</LdapPort>\n"
        "  <UseSsl>false</UseSsl>\n"
        "  <UseStartTls>false</UseStartTls>\n"
        "  <SkipSslVerify>false</SkipSslVerify>\n"
        f"  <LdapBindUser>{bind_dn}</LdapBindUser>\n"
        f"  <LdapBindPassword>{bind_password}</LdapBindPassword>\n"
        f"  <LdapSearchFilter>{search_filter}</LdapSearchFilter>\n"
        "  <LdapAdminBaseDn>" + people_base + "</LdapAdminBaseDn>\n"
        f"  <LdapAdminFilter>{admin_filter}</LdapAdminFilter>\n"
        "  <EnableLdapAdminFilterMemberUid>false</EnableLdapAdminFilterMemberUid>\n"
        "  <LdapSearchAttributes>uid, cn, mail, displayName</LdapSearchAttributes>\n"
        "  <LdapUsernameAttribute>uid</LdapUsernameAttribute>\n"
        "  <LdapPasswordAttribute>userPassword</LdapPasswordAttribute>\n"
        "  <EnableAllUsers>true</EnableAllUsers>\n"
        "  <EnableAdminUsers>true</EnableAdminUsers>\n"
        "  <CreateUsersFromLdap>true</CreateUsersFromLdap>\n"
        "  <AllowPassChange>false</AllowPassChange>\n"
        "</PluginConfiguration>\n"
    )


def ensure_jellyfin_ldap_plugin(
    base_url: str,
    token: str | None,
    ldap_port: str,
    base_dn: str,
    bind_password: str,
) -> bool:
    """Install + configure the Jellyfin LDAP-Authentication plugin so the
    family signs in with their LLDAP (Authelia) credentials (#1718).

    Idempotent + self-healing: it (re)writes `LDAP-Auth.xml` on every
    deploy so a config that drifts (or was lost on a wipe-configs
    reinstall) is restored with no operator step. The local Jellyfin admin
    stays a working break-glass login — LDAP is added as an additional
    auth provider, it does not replace Jellyfin's user DB.

    The plugin binary is installed via Jellyfin's package API (needs the
    admin token); the config write does not. So even when the admin login
    failed (no token), the config is still stamped — a subsequent deploy
    with a working token completes the binary install."""
    if not bind_password:
        log("   ℹ️ Jellyfin LDAP wiring skipped — no LLDAP admin password in env "
            "(install the `auth` stack so LLDAP_ADMIN_PASSWORD is inherited).")
        return False

    # host.containers.internal is the name podman puts in every container's
    # /etc/hosts pointing at the host — Radicale binds LLDAP the same way
    # (it lives in the hostNetwork `auth` pod, unreachable on the media
    # pod's own loopback/LAN IP). #817.
    ldap_host = "host.containers.internal"
    bind_dn = f"uid=admin,ou=people,{base_dn}"
    admin_group_dn = f"cn=lldap_admin,ou=groups,{base_dn}"

    # 1. Install the plugin binary via the package API (best-effort, needs
    #    a token). Jellyfin no-ops a re-install of an already-present
    #    plugin, so this is safe to run every deploy.
    if token:
        code, _ = request_json(
            "POST", f"{base_url}/Packages/Installed/LDAP%20Authentication",
            None,
            extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
        )
        if code in (200, 204):
            log("   ✅ Jellyfin LDAP-Authentication plugin install requested.")
        else:
            log(f"   (note) Could not request LDAP plugin install via API (HTTP {code}); "
                "if LDAP login is missing, install 'LDAP Authentication' from Dashboard → Plugins → Catalog.")
    else:
        log("   (note) No Jellyfin admin token — skipping plugin-binary install this run; "
            "the LDAP config is still written and a later deploy completes the install.")

    # 2. (Re)write the plugin config on disk — the idempotent, self-healing
    #    part. Always runs (no token needed) so a drifted/lost config is
    #    restored every deploy.
    data_dir = env("DATA_DIR", "/mnt/data/stacks")
    config_path = os.path.join(data_dir, JELLYFIN_LDAP_CONFIG_REL)
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    xml = render_ldap_plugin_config(
        ldap_host, ldap_port, base_dn, bind_dn, bind_password, admin_group_dn,
    )
    try:
        with open(config_path, "w", encoding="utf-8") as fh:
            fh.write(xml)
    except OSError as exc:
        log(f"   ⚠️ Could not write Jellyfin LDAP plugin config at {config_path} ({exc}) — "
            "configure LDAP manually in Dashboard → Plugins → LDAP-Auth.")
        return False
    log(f"   ✅ Jellyfin LDAP-Auth config written → LLDAP at ldap://{ldap_host}:{ldap_port} "
        f"(base ou=people,{base_dn}; local admin kept as break-glass).")

    # 3. Bounce Jellyfin so the plugin reloads its config. Best-effort —
    #    a failed restart just means the config applies on the next stack
    #    restart, not an install-blocking error.
    try:
        subprocess.run(
            ["podman", "container", "restart", JELLYFIN_CONTAINER],
            capture_output=True, text=True, check=False, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"   ⚠️ Could not restart {JELLYFIN_CONTAINER} after writing the LDAP config ({exc}); "
            "restart the media stack so Jellyfin reloads the LDAP plugin.")
    return True


def main() -> int:
    host = env("HOST", "<server-ip>")

    # ── Audiobookshelf credential banner ──────────────────────────────
    abs_user = env("ABS_ADMIN_USER", "root")
    abs_password = env("ABS_ADMIN_PASSWORD")
    abs_port = env("ABS_PORT", "13378")
    if abs_password:
        log(f"✅ Audiobookshelf admin saved (user: {abs_user}) — open http://{host}:{abs_port}. Password retrievable from Settings → Integrations → Saved credentials.")
        emit_credential(
            service="Audiobookshelf",
            url=f"http://{host}:{abs_port}",
            username=abs_user,
            password=abs_password,
            importance="critical",
            notes="Library manager. Mobile apps use this credential too.",
        )

    # ── Jellyfin credential banner ────────────────────────────────────
    jf_user = env("JELLYFIN_ADMIN_USER", "admin")
    jf_password = env("JELLYFIN_ADMIN_PASSWORD")
    jf_port = env("JELLYFIN_PORT", "8096")
    if jf_password:
        log(f"✅ Jellyfin admin saved (user: {jf_user}) — open http://{host}:{jf_port}. Mobile apps (Symfonium, Findroid, Streamyfin) pair via Quick Connect; no shared password needed after that.")
        emit_credential(
            service="Jellyfin",
            url=f"http://{host}:{jf_port}",
            username=jf_user,
            password=jf_password,
            importance="critical",
            notes="Web UI admin. Mobile apps pair via Quick Connect (Dashboard → Quick Connect → enable on web; in-app shows 6-digit code).",
        )

    # ── Audiobookshelf admin seed ──────────────────────────────────────
    seed_audiobookshelf(abs_port, abs_user, abs_password)

    # ── Jellyfin first-run + Quick Connect + Music library ───────────
    # `jellyfin_run_first_setup` waits for the UserManager's async init
    # (via GET /Startup/FirstUser) before seeding the admin — see #809.
    if jf_password:
        jellyfin_base = f"http://127.0.0.1:{jf_port}"
        ready = jellyfin_run_first_setup(
            jellyfin_base, jf_user, jf_password, env("TZ", "Europe/Berlin"),
        )
        jf_token: str | None = None
        if ready:
            jf_token = jellyfin_get_token(jellyfin_base, jf_user, jf_password)
            if jf_token:
                jellyfin_enable_quick_connect(jellyfin_base, jf_token)
                jellyfin_add_music_library(
                    jellyfin_base, jf_token, env("JELLYFIN_MEDIA_PATH", "/mnt/data/stacks/file-share/data"),
                )
                # #1725: Audiobookshelf retired for fresh installs — Jellyfin
                # serves the audiobooks library (content type Books) so
                # Symfonium/Subsonic clients keep audiobooks under one robust
                # LLDAP-SSO'd house login.
                jellyfin_add_audiobooks_library(jellyfin_base, jf_token)

        # ── Jellyfin → LLDAP SSO (#1718) ──────────────────────────────
        # Wire the LDAP-Auth plugin against LLDAP so the family signs in
        # with their Authelia/LLDAP credentials. Idempotent + self-healing
        # on every deploy; the config write runs even without an admin
        # token (the binary install needs one, the config does not).
        log("Wiring Jellyfin → LLDAP (LDAP-Auth plugin)…")
        ensure_jellyfin_ldap_plugin(
            jellyfin_base,
            jf_token,
            env("LLDAP_LDAP_PORT", "3890"),
            env("LLDAP_BASE_DN", "dc=dopp,dc=cloud"),
            env("LLDAP_ADMIN_PASSWORD"),
        )

    # ── ABS OIDC auto-configuration ───────────────────────────────────────
    abs_oidc_secret = env("ABS_OIDC_SECRET")
    public_domain = env("PUBLIC_DOMAIN")
    abs_oidc_ok = False
    if abs_oidc_secret and public_domain:
        abs_oidc_ok = configure_abs_oidc(abs_port, abs_user, abs_password, public_domain, abs_oidc_secret)
        if not abs_oidc_ok:
            # The admin-authenticated PATCH path failed — most often
            # because ABS_ADMIN_PASSWORD drifted from the preserved admin
            # row on a wipe-configs reinstall, so the login never returned
            # a token. Fall back to the no-login DB re-stamp so the OIDC
            # client_secret converges to Authelia's with no manual step
            # (#1717). Same class as the Immich DB reconcile (#1556).
            log("   Attempting a DB-level ABS OIDC secret reconcile (no admin login required)…")
            abs_oidc_ok = reconcile_abs_oidc_secret_in_db(abs_oidc_secret)

    if not abs_oidc_ok and abs_oidc_secret:
        # Auto-config failed or prerequisites missing — surface secret for manual paste.
        auth_url = f"https://auth.{public_domain}" if public_domain else "auth.<domain>"
        log(f"🔐 Audiobookshelf OIDC: issuer={auth_url}, client_id=audiobookshelf, client_secret={abs_oidc_secret} — paste into ABS Settings → Authentication → OIDC.")
        emit_credential(
            service="Audiobookshelf OIDC client_secret",
            url=auth_url,
            username="audiobookshelf",
            password=abs_oidc_secret,
            importance="system",
            notes="Paste into ABS Settings → Authentication → OIDC client_secret to enable SSO.",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
