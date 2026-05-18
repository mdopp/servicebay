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
  5. Add /media/Music as a "Music" virtual folder so the library scan
     starts immediately. Other subdirs (Movies/, TV/, Audiobooks/)
     stay un-imported — operator adds them by hand if wanted.

Best-effort throughout: each step that fails just logs a clear
breadcrumb so the operator can finish the setup manually in the
Jellyfin UI — non-zero exit only on something that breaks the
banner output.
"""

from __future__ import annotations

import json
import os
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


REQUEST_TIMEOUT = 30.0


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
        if status == 200 and body and body.get("ok"):
            if body.get("alreadySetup"):
                log("ℹ️ Audiobookshelf already initialized — keeping existing admin. Reset manually if the password doesn't match.")
            else:
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


# Jellyfin's readiness is now declared in servicebay.readiness on this
# template's template.yml (#613). The install runner blocks on
# /Startup/FirstUser → 200 *before* invoking this script, replacing the
# previous in-script jellyfin_wait_ready + jellyfin_wait_default_user
# helpers (both polled the same surface from inside post-deploy.py).


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

    # Locale + metadata language. German default to match the home;
    # operator can change in Settings → Server later.
    code, _ = request_json("POST", f"{base_url}/Startup/Configuration", {
        "UICulture": "de-DE",
        "MetadataCountryCode": "DE",
        "PreferredMetadataLanguage": "de",
    })
    if code not in (200, 204):
        log(f"⚠️ Jellyfin: POST /Startup/Configuration returned {code} — finish setup at the web UI.")
        return False

    # Admin user.
    code, _ = request_json("POST", f"{base_url}/Startup/User", {
        "Name": admin_user,
        "Password": admin_password,
    })
    if code not in (200, 204):
        log(f"⚠️ Jellyfin: POST /Startup/User returned {code} — finish setup at the web UI.")
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
        log(f"(note) Jellyfin: POST /Startup/RemoteAccess returned {code} — flip the remote-access toggles in Dashboard if needed.")

    code, _ = request_json("POST", f"{base_url}/Startup/Complete", {})
    if code not in (200, 204):
        log(f"⚠️ Jellyfin: POST /Startup/Complete returned {code} — finish setup at the web UI.")
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
    """Register a 'Music' collection pointing at /media/Music inside the
    container (which is the mounted host {{JELLYFIN_MEDIA_PATH}}/Music).
    Idempotent: a 400 with `LibraryAlreadyExists` is treated as success."""
    # The path that Jellyfin sees — /media is the container-side mount
    # of JELLYFIN_MEDIA_PATH on the host. The wizard's MEDIA_PATH
    # default is /mnt/data/stacks/file-share/data so /media/Music maps
    # to /mnt/data/stacks/file-share/data/Music on the host.
    container_path = "/media/Music"
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
    # Operator hint: tell them how to wire Movies/TV/etc. The post-deploy
    # doesn't auto-add those — Jellyfin's metadata sources differ per
    # library type and we don't want to commit to a default.
    log(f"   (Add Movies/TV/Photos libraries later from Dashboard → Libraries → Add Media Library; mount points live under /media/ inside the container — same tree as {music_path} on the host.)")


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
    authelia_port = env("AUTHELIA_PORT", "9091")
    discovery_candidates = [
        f"http://localhost:{authelia_port}",
        issuer_url,
    ]
    disc = None
    for candidate in discovery_candidates:
        code, body = request_json("GET", f"{candidate}/.well-known/openid-configuration")
        if code == 200 and isinstance(body, dict):
            disc = body
            log(f"ℹ️  Authelia OIDC discovery via {candidate}.")
            break
    if disc is not None:
        auth_url = disc.get("authorization_endpoint", "")
        token_url = disc.get("token_endpoint", "")
        userinfo_url = disc.get("userinfo_endpoint", "")
        jwks_url = disc.get("jwks_uri", "")
    else:
        log("ℹ️  Authelia OIDC discovery unreachable on every candidate — falling back to known Authelia 4.x paths.")
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
    # The install runner's readiness probe (servicebay.readiness, #613)
    # already blocked on /Startup/FirstUser → 200, so the UserManager has
    # finished its async init pass and the default user exists. No
    # in-script wait needed.
    if jf_password:
        jellyfin_base = f"http://127.0.0.1:{jf_port}"
        ready = jellyfin_run_first_setup(
            jellyfin_base, jf_user, jf_password, env("TZ", "Europe/Berlin"),
        )
        if ready:
            token = jellyfin_get_token(jellyfin_base, jf_user, jf_password)
            if token:
                jellyfin_enable_quick_connect(jellyfin_base, token)
                jellyfin_add_music_library(
                    jellyfin_base, token, env("JELLYFIN_MEDIA_PATH", "/mnt/data/stacks/file-share/data"),
                )

    # ── ABS OIDC auto-configuration ───────────────────────────────────────
    abs_oidc_secret = env("ABS_OIDC_SECRET")
    public_domain = env("PUBLIC_DOMAIN")
    abs_oidc_ok = False
    if abs_oidc_secret and public_domain:
        abs_oidc_ok = configure_abs_oidc(abs_port, abs_user, abs_password, public_domain, abs_oidc_secret)

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
