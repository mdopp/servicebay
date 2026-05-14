"""
Smoke tests for every templates/<name>/post-deploy.py script.

Each script is loaded as a module via importlib (the scripts aren't a
Python package), urllib.request is monkey-patched to fake ServiceBay's
HTTP responses, and main() is called with a controlled os.environ.

Assertions cover:
  - script returns 0 on the happy path
  - expected `__SB_CREDENTIAL__ {json}` markers are emitted
  - missing-required-env paths return early without hanging or crashing

The vitest suite runs this file via subprocess in
tests/backend/post_deploy_runtime.test.ts, so a single `npm test`
exercises both worlds.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATES_DIR = REPO_ROOT / "templates"


def load_script(name: str):
    """Import templates/<name>/post-deploy.py as a fresh module."""
    path = TEMPLATES_DIR / name / "post-deploy.py"
    spec = importlib.util.spec_from_file_location(f"_post_deploy_{name.replace('-', '_')}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_credentials(stdout: str) -> list[dict[str, Any]]:
    """Pull out each __SB_CREDENTIAL__ {json} marker into a dict."""
    out = []
    for line in stdout.splitlines():
        prefix = "__SB_CREDENTIAL__ "
        if line.startswith(prefix):
            out.append(json.loads(line[len(prefix):]))
    return out


@contextlib.contextmanager
def run_with_env(env: dict[str, str]):
    """Run the wrapped block with os.environ set to exactly `env` plus
    a baseline PATH (so subprocess invocations inside the script work
    if any). Restores the original env on exit."""
    saved = os.environ.copy()
    try:
        os.environ.clear()
        os.environ["PATH"] = saved.get("PATH", "/usr/bin:/bin")
        os.environ.update(env)
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


def fake_urlopen_factory(responses: dict[str, dict[str, Any]]):
    """Return a function that mimics urllib.request.urlopen by looking up
    the request URL in `responses`. Each entry: { status, body }.
    Unmatched URLs raise URLError (treated as 'unreachable' by scripts)."""
    import urllib.error

    class FakeResponse:
        def __init__(self, status: int, body: dict[str, Any] | None):
            self.status = status
            self._body = json.dumps(body or {}).encode("utf-8")

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _fake(req, *_a, **_kw):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        for prefix, resp in responses.items():
            if prefix in url:
                return FakeResponse(resp["status"], resp.get("body"))
        raise urllib.error.URLError(f"unmocked URL: {url}")

    return _fake


def capture_main(module) -> tuple[int, str]:
    """Call module.main() with stdout captured. Returns (exit_code, stdout)."""
    buf = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = buf
    try:
        rc = module.main()
    finally:
        sys.stdout = old_stdout
    return rc, buf.getvalue()


class AdguardScript(unittest.TestCase):
    def test_emits_credential_when_password_set(self):
        m = load_script("adguard")
        env = {
            "HOST": "192.168.1.10",
            "ADGUARD_ADMIN_USER": "admin",
            "ADGUARD_ADMIN_PASSWORD": "s3cret",
            "ADGUARD_ADMIN_PORT": "8083",
            "SB_API_URL": "http://sb.test",
        }
        # Mock the credentials-persist POST so the script doesn't try
        # urllib against a real localhost (would block 10s+ in CI).
        responses = {
            "/api/system/adguard/credentials": {"status": 200, "body": {"ok": True}},
        }
        import urllib.request
        with run_with_env(env), mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        self.assertEqual(len(creds), 1)
        self.assertEqual(creds[0]["service"], "AdGuard Home")
        self.assertEqual(creds[0]["username"], "admin")
        self.assertEqual(creds[0]["password"], "s3cret")
        self.assertEqual(creds[0]["url"], "http://192.168.1.10:8083")
        # Password must NOT leak into the user-visible log line — it
        # only travels via the __SB_CREDENTIAL__ JSON marker, which
        # ServiceBay stores encrypted (#321).
        # Strip credential markers before checking, since the JSON line
        # legitimately contains the password.
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("s3cret", log_only)
        # Confirm the credentials-persist call was made (status 200
        # → success log line).
        self.assertIn("ServiceBay registered AdGuard credentials", out)

    def test_no_password_skips_credential_silently(self):
        m = load_script("adguard")
        with run_with_env({"HOST": "h", "ADGUARD_ADMIN_PORT": "8083"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])
        self.assertIn("ADGUARD_ADMIN_PASSWORD missing", out)


class NginxScript(unittest.TestCase):
    def test_emits_credential_when_password_set(self):
        m = load_script("nginx")
        env = {
            "HOST": "h",
            "NGINX_ADMIN_PORT": "81",
            "NGINX_ADMIN_EMAIL": "admin@example.com",
            "NGINX_ADMIN_PASSWORD": "p4ssw0rd",
        }
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        self.assertEqual(len(creds), 1)
        self.assertEqual(creds[0]["service"], "Nginx Proxy Manager")
        self.assertEqual(creds[0]["username"], "admin@example.com")
        self.assertEqual(creds[0]["password"], "p4ssw0rd")

    def test_no_password_returns_zero_and_emits_nothing(self):
        m = load_script("nginx")
        with run_with_env({}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])


class VaultwardenScript(unittest.TestCase):
    def test_sso_enabled_message(self):
        m = load_script("vaultwarden")
        env = {
            "VAULTWARDEN_SSO_SECRET": "sso-secret",
            "VAULTWARDEN_SSO_ENABLED": "true",
            "PUBLIC_DOMAIN": "example.com",
        }
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("Vaultwarden SSO is ENABLED", out)
        self.assertIn("https://auth.example.com", out)

    def test_sso_disabled_message(self):
        m = load_script("vaultwarden")
        env = {
            "VAULTWARDEN_SSO_SECRET": "sso-secret",
            "VAULTWARDEN_SSO_ENABLED": "false",
        }
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("Vaultwarden SSO is DISABLED", out)

    def test_no_secret_returns_zero_silently(self):
        m = load_script("vaultwarden")
        with run_with_env({}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        # No secret → no log lines about SSO state
        self.assertNotIn("Vaultwarden SSO", out)


class AuthScript(unittest.TestCase):
    def test_no_lldap_password_returns_early(self):
        m = load_script("auth")
        with run_with_env({"HOST": "h"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("LLDAP_ADMIN_PASSWORD missing", out)
        # No credential markers when env is incomplete
        self.assertEqual(parse_credentials(out), [])

    def test_happy_path_with_mocked_http(self):
        m = load_script("auth")
        # Mock both the credential-persist endpoint and the lldap probe.
        # The script also calls /api/system/lldap/seed at the end — mock
        # that too.
        responses = {
            "/api/system/lldap/credentials": {"status": 200, "body": {"ok": True}},
            "/api/system/lldap/probe":       {"status": 200, "body": {"reachable": True}},
            "/api/system/lldap/seed":        {"status": 200, "body": {"created": ["admins", "family"]}},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "LLDAP_ADMIN_PASSWORD": "lldap-pass",
            "LLDAP_PORT": "17170",
            "LLDAP_JWT_SECRET": "jwt-secret",
        }
        import urllib.request
        with run_with_env(env), mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        services = {c["service"] for c in creds}
        self.assertIn("LLDAP (User Directory)", services)
        self.assertIn("LLDAP JWT secret", services)
        # The LLDAP admin password and JWT secret must travel only via
        # __SB_CREDENTIAL__ markers, not user-visible log lines (#321).
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("lldap-pass", log_only)
        self.assertNotIn("jwt-secret", log_only)


class FileShareScript(unittest.TestCase):
    def test_samba_credential_emitted_when_password_set(self):
        m = load_script("file-share")
        # FileBrowser seed runs unconditionally — give it a mocked ok-on-
        # first-try response so the loop terminates immediately and the
        # 3-min budget never matters.
        responses = {
            "/api/system/filebrowser/init": {"status": 200, "body": {"ok": True, "action": "promoted"}},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "SHARE_USER": "smb",
            "SHARE_PASSWORD": "shar3",
            "FILEBROWSER_ADMIN_USER": "admin",
            "SB_NODE": "Local",
        }
        # The script calls wait_pod_running() which invokes subprocess.run
        # against `podman pod inspect`; mock it to fast-return Running so
        # the 60s readiness loop exits on the first iteration. Also patch
        # time.sleep to a no-op (file-share keeps a few sleeps in the
        # FB seed retry loop). See #254.
        import urllib.request
        import subprocess as subprocess_mod
        import time as time_mod

        class _FakeCompletedProcess:
            returncode = 0
            stdout = "Running"
            stderr = ""

        with run_with_env(env), \
             mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
             mock.patch.object(time_mod, "sleep", lambda _s: None), \
             mock.patch.object(subprocess_mod, "run", lambda *a, **kw: _FakeCompletedProcess()):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        services = {c["service"] for c in creds}
        self.assertIn("Samba (file-share)", services)
        self.assertIn("FileBrowser admin", out)
        # The Samba password must NOT leak into the user-visible log
        # line (#321). It still ships in the __SB_CREDENTIAL__ marker
        # for the wizard banner + encrypted store.
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("shar3", log_only)

    def test_returns_nonzero_when_seed_times_out(self):
        """If /api/system/filebrowser/init never accepts the seed within
        the 3-minute budget, the script must exit non-zero so the
        post-deploy run record + diagnose probe surface the failure
        (regression-guard for #317)."""
        m = load_script("file-share")
        # 0 → urllib treats it as a connection failure; the script's
        # post_json catches URLError and returns (0, None), which the
        # main loop reads as "not seeded yet" and keeps retrying.
        responses = {
            "/api/system/filebrowser/init": {"status": 0, "body": None},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "FILEBROWSER_ADMIN_USER": "admin",
            "SB_NODE": "Local",
        }
        # Patch time.time so the deadline expires immediately and we
        # don't actually wait three minutes for the test.
        import urllib.request
        import subprocess as subprocess_mod
        import time as time_mod

        class _FakeCompletedProcess:
            returncode = 0
            stdout = "Running"
            stderr = ""

        # First call inside main() reads the start-of-budget; subsequent
        # calls must be > deadline so the while-loop exits on the first
        # iteration.
        time_calls = iter([0.0, 0.0, 0.0, 10_000.0])
        def fake_time(): return next(time_calls, 10_000.0)

        with run_with_env(env), \
             mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
             mock.patch.object(time_mod, "sleep", lambda _s: None), \
             mock.patch.object(time_mod, "time", fake_time), \
             mock.patch.object(subprocess_mod, "run", lambda *a, **kw: _FakeCompletedProcess()):
            rc, out = capture_main(m)
        self.assertEqual(rc, 1)
        self.assertIn("Could not pre-seed FileBrowser admin", out)


class MediaScript(unittest.TestCase):
    def test_no_passwords_emits_nothing_and_returns_zero(self):
        m = load_script("media")
        # No ABS_ADMIN_PASSWORD / NAVIDROME_ADMIN_PASSWORD → seed_media
        # short-circuits, no HTTP calls.
        with run_with_env({"HOST": "h"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])
        self.assertIn("no admin password", out)

    def test_credentials_emitted_with_mocked_seed(self):
        m = load_script("media")
        responses = {
            "/api/system/media/init": {"status": 200, "body": {"ok": True, "alreadySetup": True}},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "ABS_ADMIN_PASSWORD": "abs-pass",
            "ABS_PORT": "13378",
            "NAVIDROME_ADMIN_PASSWORD": "nav-pass",
            "NAVIDROME_PORT": "4533",
        }
        import urllib.request
        with run_with_env(env), mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        services = {c["service"] for c in parse_credentials(out)}
        self.assertIn("Audiobookshelf", services)
        self.assertIn("Navidrome", services)
        # Neither admin password may leak into user-visible log lines
        # (#321) — only travel via __SB_CREDENTIAL__ markers.
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("abs-pass", log_only)
        self.assertNotIn("nav-pass", log_only)


class HomeAssistantScript(unittest.TestCase):
    """The HA post-deploy is gated on Z-Wave device presence (skips
    udev + WS port config without it) and always tries the
    `auth_oidc` install (#493). We mock urllib so the HA-readiness
    probe + the OIDC verify call both run without touching a real
    network."""

    def test_no_zwave_no_ha_returns_zero(self):
        m = load_script("home-assistant")
        import urllib.error
        import urllib.request
        # All HTTP calls fail → HA not reachable; the script logs and
        # returns 0 rather than crashing.

        def always_unreachable(*_a, **_kw):
            raise urllib.error.URLError("connection refused")

        # Patch the ready-poll's timeout + sleep so the unreachable path
        # exits in milliseconds instead of the 3-minute production wait.
        env = {"HA_OIDC_AUTH_VERSION": "v0.6.0"}
        with run_with_env(env), \
                mock.patch.object(urllib.request, "urlopen", always_unreachable), \
                mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("No ZWAVE_DEVICE set", out)
        self.assertIn("HA did not respond", out)

    def test_already_installed_skips_download(self):
        """When the on-disk version stamp matches HA_OIDC_AUTH_VERSION,
        the script must skip the tarball download entirely. We assert
        this by configuring urllib so any HTTPS GET to github.com
        triggers a test failure."""
        m = load_script("home-assistant")
        import tempfile
        import urllib.request

        with tempfile.TemporaryDirectory() as tmp:
            # Pre-seed the stamp so install_auth_oidc returns False.
            target = os.path.join(tmp, "home-assistant", "homeassistant", "custom_components", "auth_oidc")
            os.makedirs(target, exist_ok=True)
            with open(os.path.join(target, ".sb_installed_version"), "w") as fh:
                fh.write("v0.6.0\n")

            def fake_urlopen(req, *_a, **_kw):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "github.com" in url:
                    raise AssertionError(f"unexpected tarball download: {url}")
                # HA-readiness probe → return 200 so wait_ha_ready proceeds.
                # OIDC verify call → return 200.
                class _R:
                    status = 200
                    def read(self):
                        return b"<html></html>"
                    def __enter__(self):
                        return self
                    def __exit__(self, *a):
                        return False
                return _R()

            env = {"HA_OIDC_AUTH_VERSION": "v0.6.0", "DATA_DIR": tmp}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("already installed", out)
            self.assertIn("/auth/oidc/welcome answered", out)


if __name__ == "__main__":
    unittest.main()
