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
        }
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        self.assertEqual(len(creds), 1)
        self.assertEqual(creds[0]["service"], "AdGuard Home")
        self.assertEqual(creds[0]["username"], "admin")
        self.assertEqual(creds[0]["password"], "s3cret")
        self.assertEqual(creds[0]["url"], "http://192.168.1.10:8083")
        self.assertIn("password: s3cret", out)

    def test_no_password_skips_credential_silently(self):
        m = load_script("adguard")
        with run_with_env({"HOST": "h", "ADGUARD_ADMIN_PORT": "8083"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])
        self.assertIn("ADGUARD_ADMIN_PASSWORD missing", out)


class NginxWebScript(unittest.TestCase):
    def test_emits_credential_when_password_set(self):
        m = load_script("nginx-web")
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
        m = load_script("nginx-web")
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
        self.assertIn("Vaultwarden SSO is OFF", out)

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


if __name__ == "__main__":
    unittest.main()
