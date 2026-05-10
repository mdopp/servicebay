#!/usr/bin/env python3
"""
post-deploy hook for the `media` stack (Audiobookshelf + Navidrome).

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

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts
under `if (isSelected('media'))`):
  - logAudiobookshelfCredentials  → `__SB_CREDENTIAL__` for ABS
  - logNavidromeCredentials       → `__SB_CREDENTIAL__` for Navidrome
  - seedAudiobookshelf            → POST localhost:<port>/init via the
                                    /api/system/media/init proxy endpoint
  - seedNavidrome                 → same, with service=navidrome

We keep using the existing /api/system/media/init endpoint rather than
talking to ABS / Navidrome directly because that endpoint already
encapsulates the right retry budget, idempotency check, and "first-run
already done" handling. The script just supplies the inputs.
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


def post_json(url: str, payload: dict[str, object], timeout: float = 10.0) -> tuple[int, dict[str, object] | None]:
    """POST JSON, return (status, parsed-body-or-None)."""
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


def seed_media(service_label: str, service_payload_name: str, port_var: str, default_port: str,
               user_var: str, default_user: str, password_var: str) -> None:
    """
    Wait for the media service to come up, then POST to ServiceBay's media-init
    proxy endpoint. The endpoint itself retries against the upstream service
    while the image is still pulling, so we just wrap it with a sensible
    overall budget here. Idempotent: re-calls report `alreadySetup`.
    """
    user = env(user_var, default_user)
    password = env(password_var)
    port = env(port_var, default_port)
    if not password:
        log(f"⚠️ {service_label}: no admin password in env ({password_var}), skipping seed.")
        return

    sb_api = env("SB_API_URL", "http://localhost:3000")
    init_url = f"{sb_api}/api/system/media/init"

    log(f"Waiting for {service_label} to start...")
    started = time.time()
    last_beat = 0.0
    deadline = 5 * 60  # 5 min — same budget the old hardcoded helper used
    while time.time() - started < deadline:
        status, body = post_json(init_url, {
            "service": service_payload_name,
            "host": "localhost",
            "port": int(port),
            "username": user,
            "password": password,
        }, timeout=15)
        if status == 200 and body and body.get("ok"):
            if body.get("alreadySetup"):
                log(f"ℹ️ {service_label} already initialized — keeping existing admin. Reset manually if the password doesn't match.")
            else:
                log(f"✅ {service_label} root user '{user}' created.")
            return
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            log(f"Still waiting for {service_label} ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(5)

    log(f"⚠️ {service_label} did not become reachable in 5 minutes. Open http://<server-ip>:{port} and create the admin user manually.")


def main() -> int:
    host = env("HOST", "<server-ip>")

    # ── Audiobookshelf ──────────────────────────────────────────────────
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

    # ── Navidrome ───────────────────────────────────────────────────────
    nd_user = env("NAVIDROME_ADMIN_USER", "admin")
    nd_password = env("NAVIDROME_ADMIN_PASSWORD")
    nd_port = env("NAVIDROME_PORT", "4533")
    if nd_password:
        log(f"✅ Navidrome admin saved (user: {nd_user}) — open http://{host}:{nd_port}. Subsonic clients (Symfonium etc.) use the same credentials. Password retrievable from Settings → Integrations → Saved credentials.")
        emit_credential(
            service="Navidrome",
            url=f"http://{host}:{nd_port}",
            username=nd_user,
            password=nd_password,
            importance="critical",
            notes="Music server. Symfonium / Subsonic clients use this too.",
        )

    # ── Audiobookshelf admin seed ──────────────────────────────────────
    seed_media(
        service_label="Audiobookshelf",
        service_payload_name="audiobookshelf",
        port_var="ABS_PORT",
        default_port="13378",
        user_var="ABS_ADMIN_USER",
        default_user="root",
        password_var="ABS_ADMIN_PASSWORD",
    )

    # ── Navidrome admin seed ───────────────────────────────────────────
    seed_media(
        service_label="Navidrome",
        service_payload_name="navidrome",
        port_var="NAVIDROME_PORT",
        default_port="4533",
        user_var="NAVIDROME_ADMIN_USER",
        default_user="admin",
        password_var="NAVIDROME_ADMIN_PASSWORD",
    )

    # ── ABS OIDC client_secret (system credential, pasted into ABS UI) ──
    abs_oidc_secret = env("ABS_OIDC_SECRET")
    public_domain = env("PUBLIC_DOMAIN")
    if abs_oidc_secret:
        url = f"https://auth.{public_domain}" if public_domain else "auth.<domain>"
        log(f"🔐 Audiobookshelf OIDC: issuer={url}, client_id=audiobookshelf, client_secret={abs_oidc_secret} — paste into ABS Settings → Authentication → OIDC.")
        emit_credential(
            service="Audiobookshelf OIDC client_secret",
            url=url,
            username="audiobookshelf",
            password=abs_oidc_secret,
            importance="system",
            notes="Paste into ABS Settings → Authentication → OIDC client_secret to enable SSO.",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
