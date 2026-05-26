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

    def test_seed_skipped_when_lldap_never_reachable(self):
        """If LLDAP's HTTP API never comes up, the group seed is skipped
        with a clear breadcrumb instead of firing blind against a
        not-ready LLDAP and failing silently (regression-guard for
        #808)."""
        m = load_script("auth")
        responses = {
            "/api/system/lldap/credentials": {"status": 200, "body": {"ok": True}},
            # Probe answers but reports LLDAP not yet reachable, forever.
            "/api/system/lldap/probe": {"status": 200, "body": {"reachable": False}},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "LLDAP_ADMIN_PASSWORD": "lldap-pass",
            "LLDAP_PORT": "17170",
        }
        import time as time_mod
        import urllib.request
        with run_with_env(env), \
             mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
             mock.patch.object(time_mod, "sleep", lambda _s: None), \
             mock.patch.object(m, "LLDAP_READY_TIMEOUT", 0.01), \
             mock.patch.object(m, "LLDAP_READY_INTERVAL", 0.001):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("skipping group seed", out)
        # The seed endpoint must never have been hit while LLDAP is down.
        self.assertNotIn("Seeding LLDAP groups", out)

    def test_seed_retries_then_warns_on_persistent_failure(self):
        """Once LLDAP is reachable, a failing seed is retried a few
        times before the script gives up — the pre-#808 code ran it
        exactly once and never retried."""
        m = load_script("auth")
        responses = {
            "/api/system/lldap/credentials": {"status": 200, "body": {"ok": True}},
            "/api/system/lldap/probe": {"status": 200, "body": {"reachable": True}},
            "/api/system/lldap/seed": {"status": 500, "body": {"error": "boom"}},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "LLDAP_ADMIN_PASSWORD": "lldap-pass",
            "LLDAP_PORT": "17170",
        }
        import time as time_mod
        import urllib.request
        with run_with_env(env), \
             mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
             mock.patch.object(time_mod, "sleep", lambda _s: None), \
             mock.patch.object(m, "LLDAP_READY_INTERVAL", 0.001):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("Could not fully seed LLDAP groups after 3 attempts", out)


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
        # Jellyfin doesn't reach the proxy media-init path — its setup
        # talks straight to /System/Info/Public and the /Startup/* +
        # /Users/AuthenticateByName endpoints. Mock all of those so
        # the script walks happy-path without a real Jellyfin behind
        # 127.0.0.1.
        responses = {
            "/api/system/media/init": {"status": 200, "body": {"ok": True, "alreadySetup": True}},
            "/System/Info/Public": {"status": 200, "body": {"StartupWizardCompleted": False}},
            "/Startup/FirstUser": {"status": 200, "body": {"Name": "stub"}},
            "/Startup/Configuration": {"status": 204, "body": None},
            "/Startup/User": {"status": 204, "body": None},
            "/Startup/RemoteAccess": {"status": 204, "body": None},
            "/Startup/Complete": {"status": 204, "body": None},
            "/Users/AuthenticateByName": {"status": 200, "body": {"AccessToken": "jf-token-stub"}},
            "/QuickConnect/Enable": {"status": 204, "body": None},
            "/Library/VirtualFolders": {"status": 204, "body": None},
        }
        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "ABS_ADMIN_PASSWORD": "abs-pass",
            "ABS_PORT": "13378",
            "JELLYFIN_ADMIN_PASSWORD": "jf-pass",
            "JELLYFIN_PORT": "8096",
        }
        import urllib.request
        with run_with_env(env), mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        services = {c["service"] for c in parse_credentials(out)}
        self.assertIn("Audiobookshelf", services)
        self.assertIn("Jellyfin", services)
        # Neither admin password may leak into user-visible log lines
        # (#321) — only travel via __SB_CREDENTIAL__ markers.
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("abs-pass", log_only)
        self.assertNotIn("jf-pass", log_only)

    def test_jellyfin_waits_for_default_user_before_seeding_admin(self):
        """`POST /Startup/User` returns 404 until Jellyfin's UserManager
        has initialized the default user. The script must GET
        /Startup/FirstUser — which triggers that init — before POSTing
        the admin (regression-guard for #809)."""
        m = load_script("media")
        import urllib.error
        import urllib.request

        class _Resp:
            def __init__(self, status, body):
                self.status = status
                self._b = json.dumps(body or {}).encode("utf-8")

            def read(self):
                return self._b

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        calls: list[tuple[str, str]] = []
        first_user_initialized = {"v": False}

        def recording_urlopen(req, *_a, **_kw):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            method = req.get_method() if hasattr(req, "get_method") else "GET"
            calls.append((method, url))
            if "/Startup/FirstUser" in url:
                # GET /Startup/FirstUser runs the UserManager init pass.
                first_user_initialized["v"] = True
                return _Resp(200, {"Name": "stub"})
            if "/Startup/User" in url:
                # Mimic real Jellyfin: 404 until the default user exists.
                return _Resp(204 if first_user_initialized["v"] else 404, None)
            if "/System/Info/Public" in url:
                return _Resp(200, {"StartupWizardCompleted": False})
            if "/Users/AuthenticateByName" in url:
                return _Resp(200, {"AccessToken": "tok"})
            if any(p in url for p in (
                "/Startup/Configuration", "/Startup/RemoteAccess", "/Startup/Complete",
                "/QuickConnect/Enable", "/Library/VirtualFolders",
            )):
                return _Resp(204, None)
            raise urllib.error.URLError(f"unmocked URL: {url}")

        env = {
            "HOST": "h",
            "SB_API_URL": "http://sb.test",
            "JELLYFIN_ADMIN_PASSWORD": "jf-pass",
            "JELLYFIN_PORT": "8096",
        }
        with run_with_env(env), mock.patch.object(urllib.request, "urlopen", recording_urlopen):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        # The admin seed must have succeeded — i.e. POST /Startup/User
        # was not a 404.
        self.assertIn("admin 'admin' seeded", out)
        # GET /Startup/FirstUser must come before POST /Startup/User.
        get_first = next(
            i for i, (meth, u) in enumerate(calls)
            if meth == "GET" and "/Startup/FirstUser" in u
        )
        post_user = next(
            i for i, (meth, u) in enumerate(calls)
            if meth == "POST" and u.endswith("/Startup/User")
        )
        self.assertLess(get_first, post_user)


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

    def test_seeds_zwave_external_settings_on_first_install(self):
        """`ensure_zwave_external_settings` must write the file with the
        correct keys + values when the store dir is empty, and skip
        when an operator-managed settings.json already pins a
        serverPort. The container restart is best-effort and must not
        crash the run even when podman isn't on PATH."""
        import tempfile
        import urllib.error
        import urllib.request

        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            env = {"HA_OIDC_AUTH_VERSION": "v0.6.0", "DATA_DIR": tmp}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("nope"))), \
                    mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("Seeding Z-Wave JS WS server config", out)
            self.assertIn("serverPort=3001", out)

            seeded = os.path.join(tmp, "home-assistant", "zwave-js", "sb-external-settings.json")
            self.assertTrue(os.path.isfile(seeded), f"expected file at {seeded}")
            with open(seeded) as fh:
                data = json.load(fh)
            self.assertEqual(data, {"serverEnabled": True, "serverPort": 3001, "serverHost": "0.0.0.0"})

            # Second run: file exists, must not be touched + must log skip.
            mtime_before = os.path.getmtime(seeded)
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("nope"))), \
                    mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc2, out2 = capture_main(m)
            self.assertEqual(rc2, 0)
            self.assertIn("already in place", out2)
            self.assertEqual(os.path.getmtime(seeded), mtime_before)

    def test_skips_external_settings_when_ui_serverport_already_set(self):
        """If settings.json already has a `zwave.serverPort`, the operator
        chose it via the UI — don't override silently."""
        import tempfile
        import urllib.error
        import urllib.request

        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            zwave_dir = os.path.join(tmp, "home-assistant", "zwave-js")
            os.makedirs(zwave_dir, exist_ok=True)
            with open(os.path.join(zwave_dir, "settings.json"), "w") as fh:
                json.dump({"zwave": {"serverPort": 8888}}, fh)

            env = {"HA_OIDC_AUTH_VERSION": "v0.6.0", "DATA_DIR": tmp}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("nope"))), \
                    mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("UI-configured serverPort", out)
            self.assertFalse(os.path.isfile(os.path.join(zwave_dir, "sb-external-settings.json")))

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


class ClaudeDevScript(unittest.TestCase):
    def test_emits_ssh_credential_when_password_set(self):
        m = load_script("claude-dev")
        env = {
            "HOST": "192.168.1.10",
            "CLAUDE_DEV_SSH_PORT": "2222",
            "CLAUDE_DEV_SSH_PASSWORD": "s3cr3t-ssh",
        }
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        self.assertEqual(len(creds), 1)
        self.assertEqual(creds[0]["service"], "Claude Dev (SSH)")
        self.assertEqual(creds[0]["username"], "dev")
        self.assertEqual(creds[0]["password"], "s3cr3t-ssh")
        self.assertEqual(creds[0]["url"], "ssh://dev@192.168.1.10:2222")
        # The SSH password must NOT leak into user-visible log lines —
        # it only travels via the __SB_CREDENTIAL__ JSON marker (#321).
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("s3cr3t-ssh", log_only)
        self.assertIn("git clone", out)

    def test_no_password_emits_no_credential(self):
        m = load_script("claude-dev")
        with run_with_env({"HOST": "h", "CLAUDE_DEV_SSH_PORT": "2222"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])


class HermesScript(unittest.TestCase):
    def test_happy_path_writes_config_and_restarts(self):
        import urllib.request
        m = load_script("hermes")
        import tempfile
        import shutil

        tmp = tempfile.mkdtemp()
        try:
            env = {
                "DATA_DIR": tmp,
                "SB_API_URL": "http://localhost:3000",
                "HOST": "192.168.1.100",
                "HERMES_API_PORT": "8642",
                "HERMES_API_KEY": "hermes-secret-key",
                "HERMES_LLM_PROVIDER_URL": "http://127.0.0.1:11434/v1",
                "HERMES_LLM_MODEL": "gemma3:4b",
                "HERMES_DASHBOARD_PORT": "9119",
                # #1002 — Tests have no HA token file + no HA running.
                # Default 90s+60s waits would hang the suite.
                "HA_TOKEN_TIMEOUT": "0",
                "HA_API_TIMEOUT": "0",
            }

            fake_urlopen = fake_urlopen_factory({
                "/api/services/hermes/action": {
                    "status": 200,
                    "body": {"ok": True}
                }
            })

            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch("time.sleep", return_value=None):
                rc, out = capture_main(m)

            self.assertEqual(rc, 0)
            self.assertIn("wrote config.yaml", out)
            self.assertIn("restart requested via ServiceBay API", out)
            
            # Check credentials emitted
            creds = parse_credentials(out)
            self.assertEqual(len(creds), 1)
            self.assertEqual(creds[0]["service"], "Hermes Agent (API)")
            self.assertEqual(creds[0]["url"], "http://192.168.1.100:8642")
            self.assertEqual(creds[0]["password"], "hermes-secret-key")

            # Check config file content
            config_path = Path(tmp) / "hermes" / "config.yaml"
            self.assertTrue(config_path.exists())
            config_content = config_path.read_text()
            self.assertIn("provider: custom", config_content)
            self.assertIn("model: gemma3:4b", config_content)
            self.assertIn("base_url: http://127.0.0.1:11434/v1", config_content)

            # Check that templates/hermes/template.yml contains skills and notes volume mounts
            template_path = REPO_ROOT / "templates" / "hermes" / "template.yml"
            self.assertTrue(template_path.exists())
            template_content = template_path.read_text()
            self.assertIn("mountPath: /opt/data/skills/oscar", template_content)
            self.assertIn("mountPath: /opt/data/notes", template_content)
            self.assertIn("path: {{DATA_DIR}}/oscar-household/skills", template_content)
            self.assertIn("path: {{DATA_DIR}}/file-share/data/notes", template_content)

        finally:
            shutil.rmtree(tmp)

    def test_adopts_ha_long_lived_token_into_pod_yml(self):
        """When home-assistant's post-deploy left a long-lived HA token,
        hermes post-deploy must patch the deployed pod yml's HASS_TOKEN
        value with that token (so Hermes' native HA gateway uses a
        credential HA actually recognises). Without this Hermes runs
        with the random placeholder from `assemble` and `auth_invalid`
        loops forever. #934."""
        import tempfile
        import shutil

        m = load_script("hermes")
        tmp = tempfile.mkdtemp()
        try:
            # Drop the long-lived token file where home-assistant post-deploy
            # would have written it (DATA_DIR/home-assistant/homeassistant/.oscar-long-lived-token).
            ha_dir = Path(tmp) / "home-assistant" / "homeassistant"
            ha_dir.mkdir(parents=True)
            (ha_dir / ".oscar-long-lived-token").write_text("eyJ.real.long.lived.token.value\n")

            # Fake the hermes pod yml at the path post-deploy expects
            # (~/.config/containers/systemd/hermes.yml). Use a temp HOME
            # so we don't clobber the real one.
            fake_home = Path(tmp) / "home"
            (fake_home / ".config" / "containers" / "systemd").mkdir(parents=True)
            pod_yml = fake_home / ".config" / "containers" / "systemd" / "hermes.yml"
            pod_yml.write_text(
                "spec:\n"
                "  containers:\n"
                "  - name: hermes\n"
                "    env:\n"
                "    - name: HASS_URL\n"
                "      value: \"http://127.0.0.1:8123\"\n"
                "    - name: HASS_TOKEN\n"
                "      value: \"random-placeholder-from-assemble\"\n"
            )

            token = m.adopt_ha_long_lived_token(tmp) if hasattr(m, "adopt_ha_long_lived_token") else None
            # Resolve the function via the dynamic loader and call with the
            # patched HOME so os.path.expanduser hits our fake. HA_*_TIMEOUT=0
            # skips the (real-time, not sleep-mockable) polling loops added
            # in #1002.
            with mock.patch.dict(os.environ, {"HOME": str(fake_home), "HA_TOKEN_TIMEOUT": "0", "HA_API_TIMEOUT": "0"}, clear=False):
                returned = m.adopt_ha_long_lived_token(tmp)

            self.assertEqual(returned, "eyJ.real.long.lived.token.value")
            patched = pod_yml.read_text()
            self.assertIn('value: "eyJ.real.long.lived.token.value"', patched)
            self.assertNotIn("random-placeholder-from-assemble", patched)
        finally:
            shutil.rmtree(tmp)

    def test_adopt_is_noop_when_long_lived_token_file_missing(self):
        """Operators who opted out of OSCAR auto-onboarding (or are
        upgrading from a pre-#934 install) don't have the token file.
        adopt_ha_long_lived_token must be a no-op in that case rather
        than overwriting hermes.yml with an empty string."""
        import tempfile
        import shutil

        m = load_script("hermes")
        tmp = tempfile.mkdtemp()
        try:
            fake_home = Path(tmp) / "home"
            (fake_home / ".config" / "containers" / "systemd").mkdir(parents=True)
            pod_yml = fake_home / ".config" / "containers" / "systemd" / "hermes.yml"
            original = (
                "    - name: HASS_TOKEN\n"
                "      value: \"random-placeholder-from-assemble\"\n"
            )
            pod_yml.write_text(original)
            with mock.patch.dict(os.environ, {"HOME": str(fake_home), "HA_TOKEN_TIMEOUT": "0", "HA_API_TIMEOUT": "0"}, clear=False):
                returned = m.adopt_ha_long_lived_token(tmp)
            self.assertIsNone(returned)
            self.assertEqual(pod_yml.read_text(), original)
        finally:
            shutil.rmtree(tmp)


class OscarHouseholdScript(unittest.TestCase):
    def test_happy_path_configures_mcp_and_restarts(self):
        import urllib.request
        m = load_script("oscar-household")
        import tempfile
        import shutil

        tmp = tempfile.mkdtemp()
        try:
            # Write a mock config.yaml file that the post-deploy script will read and merge into.
            hermes_dir = Path(tmp) / "hermes"
            hermes_dir.mkdir(parents=True, exist_ok=True)
            config_path = hermes_dir / "config.yaml"
            config_path.write_text("model:\n  provider: custom\n  model: gemma3:4b\n")

            env = {
                "DATA_DIR": tmp,
                "SB_API_URL": "http://localhost:3000",
                "HOST": "192.168.1.100",
                "HERMES_API_PORT": "8642",
                "HERMES_API_KEY": "hermes-secret-key",
                "HA_MCP_URL": "http://localhost:8123/mcp",
                "HA_MCP_TOKEN": "ha-token",
                "SERVICEBAY_MCP_URL": "http://localhost:5888/mcp",
                "SERVICEBAY_MCP_TOKEN": "sb-token",
                "OSCAR_DEBUG_MODE": "true",
                "TZ": "Europe/Berlin",
            }

            fake_urlopen = fake_urlopen_factory({
                "/health": {
                    "status": 200,
                    "body": {"status": "ok"}
                },
                "/api/services/hermes/action": {
                    "status": 200,
                    "body": {"ok": True}
                }
            })

            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch("time.sleep", return_value=None):
                rc, out = capture_main(m)

            self.assertEqual(rc, 0)
            self.assertIn("config.yaml mcp_servers block updated", out)
            self.assertIn("hermes restart requested via ServiceBay API", out)

            # Check config file content includes merged mcp_servers block
            config_content = config_path.read_text()
            self.assertIn("mcp_servers:", config_content)
            self.assertIn("ha-mcp:", config_content)
            self.assertIn('url: "http://localhost:8123/mcp"', config_content)
            self.assertIn('Authorization: "Bearer ha-token"', config_content)
            self.assertIn("servicebay-mcp:", config_content)
            self.assertIn('url: "http://localhost:5888/mcp"', config_content)
            self.assertIn('Authorization: "Bearer sb-token"', config_content)

        finally:
            shutil.rmtree(tmp)

    def test_minted_servicebay_mcp_token_supersedes_env(self):
        """When ServiceBay's /api/system/mcp-tokens is reachable, the post-deploy
        mints a real token and uses *that* in hermes' config.yaml instead of the
        random SERVICEBAY_MCP_TOKEN from assemble. Without this, every cloud-LLM
        call from Hermes hits 401 because the env value was never registered."""
        import urllib.request
        m = load_script("oscar-household")
        import tempfile
        import shutil

        tmp = tempfile.mkdtemp()
        try:
            hermes_dir = Path(tmp) / "hermes"
            hermes_dir.mkdir(parents=True, exist_ok=True)
            config_path = hermes_dir / "config.yaml"
            config_path.write_text("model:\n  provider: custom\n  model: gemma3:4b\n")

            env = {
                "DATA_DIR": tmp,
                "SB_API_URL": "http://localhost:3000",
                "SB_API_TOKEN": "internal-token",
                "HERMES_API_PORT": "8642",
                "HERMES_API_KEY": "hermes-secret-key",
                "HA_MCP_URL": "http://localhost:8123/mcp",
                "HA_MCP_TOKEN": "ha-token",
                "SERVICEBAY_MCP_URL": "http://localhost:3000/mcp",
                # Random value from `assemble`; mint should override.
                "SERVICEBAY_MCP_TOKEN": "random-unregistered-from-assemble",
                "OSCAR_DEBUG_MODE": "true",
                "TZ": "Europe/Berlin",
            }

            fake_urlopen = fake_urlopen_factory({
                "/health": {"status": 200, "body": {"status": "ok"}},
                "/api/system/mcp-tokens": {
                    "status": 200,
                    "body": {
                        "token": {"id": "abcd1234", "name": "oscar-hermes", "scopes": ["read","mutate","lifecycle"]},
                        "secret": "sb_abcd1234_REAL_MINTED_SECRET_xyz",
                    },
                },
                "/api/services/hermes/action": {"status": 200, "body": {"ok": True}},
            })

            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch("time.sleep", return_value=None):
                rc, out = capture_main(m)

            self.assertEqual(rc, 0)
            self.assertIn("minted servicebay-mcp token", out)
            config_content = config_path.read_text()
            self.assertIn(
                'Authorization: "Bearer sb_abcd1234_REAL_MINTED_SECRET_xyz"',
                config_content,
            )
            self.assertNotIn("random-unregistered-from-assemble", config_content)
        finally:
            shutil.rmtree(tmp)

    def test_ha_long_lived_token_file_supersedes_env(self):
        """When home-assistant's post-deploy has dropped a long-lived
        token at <DATA_DIR>/home-assistant/homeassistant/.oscar-long-lived-token
        (the #934 auto-onboarding hand-off), oscar-household's
        post-deploy must splice THAT into the mcp_servers block instead
        of HA_MCP_TOKEN from `assemble`. Otherwise ha-mcp 401s and the
        whole #920 "turn on the kitchen light" loop breaks."""
        import urllib.request
        m = load_script("oscar-household")
        import tempfile
        import shutil

        tmp = tempfile.mkdtemp()
        try:
            hermes_dir = Path(tmp) / "hermes"
            hermes_dir.mkdir(parents=True, exist_ok=True)
            (hermes_dir / "config.yaml").write_text("model:\n  provider: custom\n  model: gemma3:4b\n")

            # Drop the LLT file where home-assistant post-deploy would.
            ha_dir = Path(tmp) / "home-assistant" / "homeassistant"
            ha_dir.mkdir(parents=True)
            (ha_dir / ".oscar-long-lived-token").write_text("eyJ.real.long.lived.value\n")

            env = {
                "DATA_DIR": tmp,
                "SB_API_URL": "http://localhost:3000",
                "HERMES_API_PORT": "8642",
                "HERMES_API_KEY": "hermes-key",
                "HA_MCP_URL": "http://127.0.0.1:8123/mcp_server/sse",
                "HA_MCP_TOKEN": "random-from-assemble",  # should be ignored
                "SERVICEBAY_MCP_URL": "",  # skip servicebay-mcp for this test
                "OSCAR_DEBUG_MODE": "true",
                "TZ": "Europe/Berlin",
            }
            fake_urlopen = fake_urlopen_factory({
                "/health": {"status": 200, "body": {"status": "ok"}},
                "/api/services/hermes/action": {"status": 200, "body": {"ok": True}},
            })
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch("time.sleep", return_value=None):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            config_content = (hermes_dir / "config.yaml").read_text()
            self.assertIn('Authorization: "Bearer eyJ.real.long.lived.value"', config_content)
            self.assertNotIn("random-from-assemble", config_content)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
