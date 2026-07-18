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
                # A callable lets a test return a different response per call
                # (e.g. login that 401s until a rekey, then 201s).
                if callable(resp):
                    resp = resp()
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

    def test_wal_switch_is_idempotent_and_reports_wal(self):
        """#1679: ensure_sqlite_wal flips a real (delete-mode) sqlite DB to WAL,
        and a second run is a no-op that still reports WAL — proving the on-disk
        header persists and re-running never errors."""
        import sqlite3
        import tempfile
        m = load_script("nginx")
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "database.sqlite")
            conn = sqlite3.connect(db)
            conn.execute("PRAGMA journal_mode=DELETE;")
            conn.execute("CREATE TABLE t (id INTEGER);")
            conn.commit()
            conn.close()

            self.assertTrue(m.ensure_sqlite_wal(db, "NPM"))
            # The header now records WAL.
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute("PRAGMA journal_mode;").fetchone()[0].lower(), "wal")
            # Idempotent second run.
            self.assertTrue(m.ensure_sqlite_wal(db, "NPM"))

    def test_wal_switch_skips_missing_db(self):
        """A fresh install (no DB file yet) is a clean skip, not an error."""
        import tempfile
        m = load_script("nginx")
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "database.sqlite")
            self.assertFalse(m.ensure_sqlite_wal(missing, "NPM"))

    def test_wal_switch_skips_invalid_db(self):
        """A non-sqlite / torn file is rejected on the header check, never
        opened-and-mutated (no stray -wal/-shm sidecars)."""
        import tempfile
        m = load_script("nginx")
        with tempfile.TemporaryDirectory() as tmp:
            junk = os.path.join(tmp, "database.sqlite")
            with open(junk, "wb") as fh:
                fh.write(b"not a sqlite db at all")
            self.assertFalse(m.ensure_sqlite_wal(junk, "NPM"))
            # No sidecar files were created beside the junk file.
            self.assertFalse(os.path.exists(junk + "-wal"))
            self.assertFalse(os.path.exists(junk + "-shm"))

    def test_main_runs_wal_switch_on_the_resolved_db_path(self):
        """main() calls ensure_sqlite_wal against the template-mounted DB path
        ({DATA_DIR}/nginx-proxy-manager/data/database.sqlite) even with no admin
        password — a returning install still gets the concurrency fix."""
        import sqlite3
        import tempfile
        m = load_script("nginx")
        with tempfile.TemporaryDirectory() as tmp:
            dbdir = os.path.join(tmp, "nginx-proxy-manager", "data")
            os.makedirs(dbdir, exist_ok=True)
            db = os.path.join(dbdir, "database.sqlite")
            # A real (header-bearing) DB — a bare connect()+close() leaves a
            # zero-byte file with no sqlite header (header lands on first write).
            c = sqlite3.connect(db)
            c.execute("CREATE TABLE t (id INTEGER);")
            c.commit()
            c.close()
            with run_with_env({"DATA_DIR": tmp}):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("NPM SQLite DB is in WAL mode", out)
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute("PRAGMA journal_mode;").fetchone()[0].lower(), "wal")


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

    def test_wal_switch_flips_authelia_db_and_is_idempotent(self):
        """#1679: ensure_sqlite_wal flips Authelia's db.sqlite3 to WAL and a
        repeat run stays WAL with no error (persisted header)."""
        import sqlite3
        import tempfile
        m = load_script("auth")
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "db.sqlite3")
            conn = sqlite3.connect(db)
            conn.execute("PRAGMA journal_mode=DELETE;")
            conn.execute("CREATE TABLE t (id INTEGER);")
            conn.commit()
            conn.close()
            self.assertTrue(m.ensure_sqlite_wal(db, "Authelia"))
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute("PRAGMA journal_mode;").fetchone()[0].lower(), "wal")
            self.assertTrue(m.ensure_sqlite_wal(db, "Authelia"))

    def test_wal_switch_guards_missing_and_invalid_db(self):
        """Missing file → clean skip; non-sqlite file → header-rejected, never
        mutated (no stray sidecars)."""
        import tempfile
        m = load_script("auth")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(m.ensure_sqlite_wal(os.path.join(tmp, "db.sqlite3"), "Authelia"))
            junk = os.path.join(tmp, "db.sqlite3")
            with open(junk, "wb") as fh:
                fh.write(b"garbage")
            self.assertFalse(m.ensure_sqlite_wal(junk, "Authelia"))
            self.assertFalse(os.path.exists(junk + "-wal"))

    def test_main_runs_authelia_wal_switch(self):
        """main() flips the template-mounted Authelia DB
        ({DATA_DIR}/auth/authelia-data/db.sqlite3) — runs before the LLDAP env
        gate so it fires even with no LLDAP password."""
        import sqlite3
        import tempfile
        m = load_script("auth")
        with tempfile.TemporaryDirectory() as tmp:
            dbdir = os.path.join(tmp, "auth", "authelia-data")
            os.makedirs(dbdir, exist_ok=True)
            db = os.path.join(dbdir, "db.sqlite3")
            c = sqlite3.connect(db)
            c.execute("CREATE TABLE t (id INTEGER);")
            c.commit()
            c.close()
            # No LLDAP_ADMIN_PASSWORD → main() returns early after the WAL step.
            with run_with_env({"DATA_DIR": tmp}):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("Authelia SQLite DB is in WAL mode", out)
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute("PRAGMA journal_mode;").fetchone()[0].lower(), "wal")

    def test_smtp_notifier_disables_fatal_startup_check(self):
        """Authelia's notifier startup check is fatal on failure, so a
        transient or rate-limited SMTP server (e.g. Gmail '454 too many
        login attempts') would crash the entire auth pod and lock
        everyone out. The rendered SMTP notifier must disable that check
        so email problems degrade instead of taking down auth."""
        m = load_script("auth")
        block = m._smtp_notifier_block({
            "host": "smtp.gmail.com",
            "port": 587,
            "secure": False,
            "user": "me@example.com",
            "pass": "p",
            "from": "me@example.com",
        })
        self.assertIn("disable_startup_check: true", block)
        self.assertNotIn("disable_startup_check: false", block)


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

    def test_provisions_notes_share_acl(self):
        """#1311: provision_notes_share() must own the notes vault by the
        shared `file-share` gid, set the setgid bit (mode 2775), and apply
        a default + existing POSIX ACL granting g:<gid>:rwx — replacing the
        old 0777 hack with a real access model. Commands are recorded
        (subprocess mocked) and asserted against the real tempdir path."""
        import tempfile
        import grp as grp_mod
        m = load_script("file-share")

        with tempfile.TemporaryDirectory() as tmp:
            notes = os.path.join(tmp, "file-share", "data", "notes")
            calls: list[list[str]] = []

            class _OK:
                returncode = 0
                stdout = ""
                stderr = ""

            def record_run(cmd, *_a, **_kw):
                calls.append(list(cmd))
                return _OK()

            class _Grp:
                gr_gid = 6000

            env = {"DATA_DIR": tmp}
            import subprocess as subprocess_mod
            with run_with_env(env), \
                    mock.patch.object(subprocess_mod, "run", record_run), \
                    mock.patch.object(grp_mod, "getgrnam", lambda _n: _Grp()):
                m.provision_notes_share()

            # The notes subdir is created if absent so the model applies
            # from the first deploy.
            self.assertTrue(os.path.isdir(notes))

            # Group already resolvable → no groupadd needed.
            self.assertFalse(any("groupadd" in c for c in calls),
                             "should not groupadd when the group already exists")

            joined = [" ".join(c) for c in calls]
            # 1. chgrp -R <gid> on notes
            self.assertTrue(any(c == ["chgrp", "-R", "6000", notes] for c in calls), joined)
            # 2. setgid mode 2775
            self.assertTrue(any(c == ["chmod", "2775", notes] for c in calls), joined)
            # 3. default ACL g:<gid>:rwx (new files) + existing entries
            self.assertTrue(any(c == ["setfacl", "-R", "-d", "-m", "g:6000:rwx", notes] for c in calls), joined)
            self.assertTrue(any(c == ["setfacl", "-R", "-m", "g:6000:rwx", notes] for c in calls), joined)

    def test_provision_notes_share_fail_soft_when_group_unavailable(self):
        """If the `file-share` group can't be resolved or created, the
        provisioning logs and skips the ACL work without raising — a
        permission step must never abort the deploy (#1311)."""
        import tempfile
        import grp as grp_mod
        m = load_script("file-share")

        with tempfile.TemporaryDirectory() as tmp:
            calls: list[list[str]] = []

            class _OK:
                returncode = 0
                stdout = ""
                stderr = ""

            def record_run(cmd, *_a, **_kw):
                calls.append(list(cmd))
                return _OK()

            env = {"DATA_DIR": tmp}
            import subprocess as subprocess_mod
            # getgrnam always raises KeyError → group never resolvable even
            # after groupadd. Must skip chgrp/chmod/setfacl, log, return.
            with run_with_env(env), \
                    mock.patch.object(subprocess_mod, "run", record_run), \
                    mock.patch.object(grp_mod, "getgrnam",
                                      mock.Mock(side_effect=KeyError("no group"))):
                m.provision_notes_share()  # must not raise

            self.assertFalse(any("chgrp" in c for c in calls))
            self.assertFalse(any("setfacl" in c for c in calls))

    def test_provision_notes_share_creates_group_when_missing(self):
        """When the group doesn't exist yet, provision runs `groupadd`
        (idempotent system group), then resolves the freshly-created gid
        and proceeds with the ACL provisioning."""
        import tempfile
        import grp as grp_mod
        m = load_script("file-share")

        with tempfile.TemporaryDirectory() as tmp:
            notes = os.path.join(tmp, "file-share", "data", "notes")
            calls: list[list[str]] = []

            class _OK:
                returncode = 0
                stdout = ""
                stderr = ""

            def record_run(cmd, *_a, **_kw):
                calls.append(list(cmd))
                return _OK()

            class _Grp:
                gr_gid = 6001

            # First getgrnam raises (missing) → groupadd → second resolves.
            seq = [KeyError("missing"), _Grp()]

            def fake_getgrnam(_n):
                v = seq.pop(0)
                if isinstance(v, Exception):
                    raise v
                return v

            env = {"DATA_DIR": tmp}
            import subprocess as subprocess_mod
            with run_with_env(env), \
                    mock.patch.object(subprocess_mod, "run", record_run), \
                    mock.patch.object(grp_mod, "getgrnam", fake_getgrnam):
                m.provision_notes_share()

            self.assertTrue(any("groupadd" in c for c in calls),
                            "groupadd must run when the group is missing")
            self.assertTrue(any(c == ["chgrp", "-R", "6001", notes] for c in calls))

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
        # No JELLYFIN_ADMIN_PASSWORD → main short-circuits the Jellyfin
        # banner + first-run, no HTTP calls, no credentials emitted.
        with run_with_env({"HOST": "h"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])

    def test_credentials_emitted_with_mocked_seed(self):
        m = load_script("media")
        # Jellyfin's setup talks straight to /System/Info/Public and the
        # /Startup/* + /Users/AuthenticateByName endpoints. Mock all of
        # those so the script walks happy-path without a real Jellyfin
        # behind 127.0.0.1. (Audiobookshelf retired in #1725/#1740 —
        # Jellyfin is the only media credential now.)
        responses = {
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
            "JELLYFIN_ADMIN_PASSWORD": "jf-pass",
            "JELLYFIN_PORT": "8096",
        }
        import urllib.request
        with run_with_env(env), mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        services = {c["service"] for c in parse_credentials(out)}
        self.assertIn("Jellyfin", services)
        # The admin password may not leak into user-visible log lines
        # (#321) — only travel via __SB_CREDENTIAL__ markers.
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("jf-pass", log_only)

    # ── #1725: Audiobookshelf retired; Jellyfin serves audiobooks ─────────

    def _recording_jellyfin_urlopen(self, calls, library_status=204, library_body=None):
        """A urlopen stub that records every (method, url) and answers the
        Jellyfin first-run + library-add happy path. /Library/VirtualFolders
        responses are configurable so a test can simulate the idempotent
        400-LibraryAlreadyExists case."""
        import urllib.error

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

        def _open(req, *_a, **_kw):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            method = req.get_method() if hasattr(req, "get_method") else "GET"
            calls.append((method, url))
            if "/System/Info/Public" in url:
                return _Resp(200, {"StartupWizardCompleted": False})
            if "/Startup/FirstUser" in url:
                return _Resp(200, {"Name": "stub"})
            if "/Users/AuthenticateByName" in url:
                return _Resp(200, {"AccessToken": "tok"})
            if "/Library/VirtualFolders" in url:
                return _Resp(library_status, library_body)
            if any(p in url for p in (
                "/Startup/Configuration", "/Startup/User", "/Startup/RemoteAccess",
                "/Startup/Complete", "/QuickConnect/Enable",
                "/Packages/Installed",
            )):
                return _Resp(204, None)
            raise urllib.error.URLError(f"unmocked URL: {url}")

        return _open

    def _resp(self, status, body):
        class _R:
            def __init__(s): s.status = status
            def read(s): return body.encode() if isinstance(body, str) else body
            def __enter__(s): return s
            def __exit__(s, *a): return False
        return _R()

    def test_jellyfin_provision_libraries_public_and_private(self):
        """jellyfin_provision_libraries creates a PUBLIC library per shared media
        category dir + a PRIVATE '<Cat> (<user>)' library per user/category dir,
        excludes photos/documents, and returns the library GUIDs."""
        m = load_script("media")
        import urllib.request, urllib.parse, json
        layout = {
            "/root": ["music", "movies", "photos", "documents", "mdopp", "_superseded"],
            "/root/mdopp": ["movies", "Security"],
        }
        posts: list[tuple[str, str, str]] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            meth = req.get_method()
            if meth == "POST" and "/Library/VirtualFolders" in url:
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                path = json.loads(req.data.decode())["LibraryOptions"]["PathInfos"][0]["Path"]
                posts.append((qs["name"][0], qs["collectionType"][0], path))
                return outer._resp(204, "{}")
            if meth == "GET" and "/Library/VirtualFolders" in url:
                return outer._resp(200, json.dumps([{"Name": n, "ItemId": "id-" + n} for (n, _, _) in posts]))
            return outer._resp(204, "{}")

        with mock.patch.object(m, "_dir_nonempty", lambda p: True), \
             mock.patch.object(m.os, "listdir", lambda p: layout.get(p, [])), \
             mock.patch.object(m.os.path, "isdir", lambda p: True), \
             mock.patch.object(urllib.request, "urlopen", urlopen):
            result = m.jellyfin_provision_libraries("http://jf", "tok", "/root")

        names = {n for (n, _, _) in posts}
        self.assertIn("Music", names)
        self.assertIn("Movies", names)
        self.assertIn("Movies (mdopp)", names)        # private per-user
        self.assertNotIn("Photos", names)             # Immich's job, excluded
        self.assertNotIn("Documents", names)          # Filebrowser's job
        self.assertNotIn("Security (mdopp)", names)   # not a media category
        # collectionType + container path are correct for the private movies lib.
        priv = next((c, p) for (n, c, p) in posts if n == "Movies (mdopp)")
        self.assertEqual(priv, ("movies", "/media/mdopp/movies"))
        # GUIDs returned for access-wiring: public = Music/Movies, private under mdopp.
        self.assertEqual(set(result["public"]), {"id-Music", "id-Movies"})
        self.assertEqual(result["private_by_user"], {"mdopp": ["id-Movies (mdopp)"]})

    def test_jellyfin_bookshelf_plugin_install_requested(self):
        """ensure_jellyfin_bookshelf_plugin POSTs the Bookshelf package install
        (so a books-type library indexes audiobooks as playable AudioBook items,
        #2028) and returns True on a 204."""
        m = load_script("media")
        import urllib.request
        responses = {"/Packages/Installed/Bookshelf": {"status": 204, "body": None}}
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)):
            ok = m.ensure_jellyfin_bookshelf_plugin("http://127.0.0.1:8096", "jf-token")
        self.assertTrue(ok)

    def test_jellyfin_bookshelf_plugin_install_failsoft(self):
        """A failed Bookshelf install is best-effort: returns False, never raises
        (the deploy must not be blocked by a plugin-catalog hiccup)."""
        m = load_script("media")
        import urllib.request
        # No matching response → URLError → request_json reports a non-2xx code.
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory({})):
            ok = m.ensure_jellyfin_bookshelf_plugin("http://127.0.0.1:8096", "jf-token")
        self.assertFalse(ok)

    def test_jellyfin_set_user_access_grants_public_plus_own_private(self):
        """Each non-admin user gets the public libs + their OWN private libs;
        admins are left untouched (keep EnableAllFolders)."""
        m = load_script("media")
        import urllib.request, json
        users = [
            {"Name": "admin", "Id": "a", "Policy": {"IsAdministrator": True}},
            {"Name": "mdopp", "Id": "u1", "Policy": {"IsAdministrator": False}},
        ]
        policy_posts: dict[str, dict] = {}
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if req.get_method() == "GET" and url.endswith("/Users"):
                return outer._resp(200, json.dumps(users))
            if req.get_method() == "POST" and "/Policy" in url:
                policy_posts[url.rsplit("/Users/", 1)[1].split("/")[0]] = json.loads(req.data.decode())
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            m.jellyfin_set_user_access("http://jf", "tok", ["pub1", "pub2"], {"mdopp": ["priv1"]})

        self.assertNotIn("a", policy_posts)  # admin untouched
        self.assertIn("u1", policy_posts)
        pol = policy_posts["u1"]
        self.assertFalse(pol["EnableAllFolders"])
        self.assertEqual(pol["EnabledFolders"], ["pub1", "pub2", "priv1"])

    def test_jellyfin_ldap_config_carries_public_enabled_folders(self):
        """render_ldap_plugin_config bakes the public-library GUIDs into
        EnabledFolders (so auto-provisioned users see public libs), and keeps
        EnableAllFolders=false (never leak private libs to everyone)."""
        m = load_script("media")
        xml = m.render_ldap_plugin_config(
            "host.containers.internal", "3890", "dc=dopp,dc=cloud",
            "uid=admin,ou=people,dc=dopp,dc=cloud", "bindpw",
            "cn=lldap_admin,ou=groups,dc=dopp,dc=cloud", ["pubA", "pubB"],
        )
        self.assertIn("<EnableAllFolders>false</EnableAllFolders>", xml)
        self.assertIn("<EnabledFolders><string>pubA</string><string>pubB</string></EnabledFolders>", xml)

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

    # ── #1718: Jellyfin LDAP-Auth plugin → LLDAP ─────────────────────────

    def test_jellyfin_ldap_config_rendered_with_lldap_bind(self):
        """render_ldap_plugin_config emits the correct LLDAP bind/base/
        filter/group-map (mirrors Radicale's bind)."""
        m = load_script("media")
        xml = m.render_ldap_plugin_config(
            ldap_host="host.containers.internal",
            ldap_port="3890",
            base_dn="dc=dopp,dc=cloud",
            bind_dn="uid=admin,ou=people,dc=dopp,dc=cloud",
            bind_password="lldap-pass",
            admin_group_dn="cn=lldap_admin,ou=groups,dc=dopp,dc=cloud",
        )
        self.assertIn("<LdapServer>host.containers.internal</LdapServer>", xml)
        self.assertIn("<LdapPort>3890</LdapPort>", xml)
        self.assertIn("<LdapBaseDn>ou=people,dc=dopp,dc=cloud</LdapBaseDn>", xml)
        self.assertIn("<LdapBindUser>uid=admin,ou=people,dc=dopp,dc=cloud</LdapBindUser>", xml)
        # Filter mirrors Radicale: (&(objectClass=person)(uid={username}))
        # — the ampersand is XML-escaped.
        self.assertIn("(&amp;(objectClass=person)(uid={username}))", xml)
        # Admin-group map → Jellyfin admin.
        self.assertIn("(memberOf=cn=lldap_admin,ou=groups,dc=dopp,dc=cloud)", xml)
        # Auto-provision LDAP users so the family logs in without a manual
        # per-user step.
        self.assertIn("<CreateUsersFromLdap>true</CreateUsersFromLdap>", xml)

    def test_jellyfin_ldap_plugin_config_written_and_idempotent(self):
        """ensure_jellyfin_ldap_plugin writes LDAP-Auth.xml under the
        jellyfin-config volume, installs the plugin via the package API,
        bounces Jellyfin, and re-applies identically on a second run
        (self-healing / idempotent)."""
        import tempfile
        m = load_script("media")
        responses = {
            "/Packages/Installed/LDAP%20Authentication": {"status": 204, "body": None},
        }
        restarts: list[list[str]] = []

        class _CP:
            returncode = 0
            stdout = ""
            stderr = ""

        def run_fn(cmd, *_a, **_kw):
            restarts.append(list(cmd))
            return _CP()

        import urllib.request
        import subprocess as subprocess_mod
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = os.path.join(
                tmp, "media", "jellyfin-config", "plugins",
                "configurations", "LDAP-Auth.xml",
            )
            env = {"DATA_DIR": tmp}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
                    mock.patch.object(subprocess_mod, "run", run_fn):
                ok = m.ensure_jellyfin_ldap_plugin(
                    "http://127.0.0.1:8096", "jf-token",
                    "3890", "dc=dopp,dc=cloud", "lldap-pass",
                )
            self.assertTrue(ok)
            self.assertTrue(os.path.isfile(cfg_path))
            with open(cfg_path, encoding="utf-8") as fh:
                first = fh.read()
            self.assertIn("<LdapServer>host.containers.internal</LdapServer>", first)
            self.assertIn("<LdapBindUser>uid=admin,ou=people,dc=dopp,dc=cloud</LdapBindUser>", first)
            # Jellyfin was bounced so the plugin reloads its config.
            self.assertTrue(
                any(c[:3] == ["podman", "container", "restart"]
                    and c[-1] == "media-jellyfin" for c in restarts),
                restarts,
            )
            # Idempotent second run → byte-identical config.
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
                    mock.patch.object(subprocess_mod, "run", run_fn):
                m.ensure_jellyfin_ldap_plugin(
                    "http://127.0.0.1:8096", "jf-token",
                    "3890", "dc=dopp,dc=cloud", "lldap-pass",
                )
            with open(cfg_path, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), first)

    def test_jellyfin_ldap_config_written_without_admin_token(self):
        """Even when the Jellyfin admin login failed (no token), the LDAP
        config is still stamped so a later deploy with a token completes
        the binary install — the config write needs no token."""
        import tempfile
        m = load_script("media")

        class _CP:
            returncode = 0
            stdout = ""
            stderr = ""

        import urllib.request
        import urllib.error
        import subprocess as subprocess_mod
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = os.path.join(
                tmp, "media", "jellyfin-config", "plugins",
                "configurations", "LDAP-Auth.xml",
            )
            env = {"DATA_DIR": tmp}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("no token path hit"))), \
                    mock.patch.object(subprocess_mod, "run", lambda *a, **kw: _CP()):
                ok = m.ensure_jellyfin_ldap_plugin(
                    "http://127.0.0.1:8096", None,
                    "3890", "dc=dopp,dc=cloud", "lldap-pass",
                )
            self.assertTrue(ok)
            self.assertTrue(os.path.isfile(cfg_path))

    def test_jellyfin_ldap_skipped_without_lldap_password(self):
        """No LLDAP_ADMIN_PASSWORD → skip the LDAP wiring with a clear
        breadcrumb (auth stack not installed) instead of writing a config
        with an empty bind password."""
        import tempfile
        m = load_script("media")
        with tempfile.TemporaryDirectory() as tmp:
            with run_with_env({"DATA_DIR": tmp}):
                ok = m.ensure_jellyfin_ldap_plugin(
                    "http://127.0.0.1:8096", "jf-token",
                    "3890", "dc=dopp,dc=cloud", "",
                )
            self.assertFalse(ok)
            cfg_path = os.path.join(
                tmp, "media", "jellyfin-config", "plugins",
                "configurations", "LDAP-Auth.xml",
            )
            self.assertFalse(os.path.isfile(cfg_path))


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

    def test_zwave_port_settings_written_on_fresh_store(self):
        """`ensure_zwave_port_settings` must seed zwave.port and default
        enableSoftReset to false when settings.json doesn't exist yet
        (#1594 — driver logged 'no port configured' + Gen5 soft-reset)."""
        import tempfile

        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            with run_with_env({"DATA_DIR": tmp}):
                changed = m.ensure_zwave_port_settings("/dev/ttyACM0")
            self.assertTrue(changed)
            settings_path = os.path.join(tmp, "home-assistant", "zwave-js", "settings.json")
            with open(settings_path) as fh:
                data = json.load(fh)
            self.assertEqual(data["zwave"]["port"], "/dev/ttyACM0")
            self.assertIs(data["zwave"]["enableSoftReset"], False)

    def test_zwave_port_settings_merges_without_clobbering(self):
        """Must MERGE into an existing settings.json (zwave-js-ui owns it),
        preserving securityKeys and an operator-chosen port/soft-reset."""
        import tempfile

        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "home-assistant", "zwave-js")
            os.makedirs(store, exist_ok=True)
            existing = {
                "zwave": {
                    "port": "/dev/ttyUSB7",          # operator-chosen — keep
                    "enableSoftReset": True,         # operator-chosen — keep
                    "securityKeys": {"S0_Legacy": "deadbeefdeadbeefdeadbeefdeadbeef"},
                },
                "mqtt": {"name": "zwave"},
            }
            with open(os.path.join(store, "settings.json"), "w") as fh:
                json.dump(existing, fh)
            with run_with_env({"DATA_DIR": tmp}):
                changed = m.ensure_zwave_port_settings("/dev/ttyACM0")
            self.assertFalse(changed)  # nothing to change → no rewrite
            with open(os.path.join(store, "settings.json")) as fh:
                data = json.load(fh)
            # Operator choices + keys + sibling sections all survive.
            self.assertEqual(data["zwave"]["port"], "/dev/ttyUSB7")
            self.assertIs(data["zwave"]["enableSoftReset"], True)
            self.assertEqual(data["zwave"]["securityKeys"]["S0_Legacy"], "deadbeefdeadbeefdeadbeefdeadbeef")
            self.assertEqual(data["mqtt"]["name"], "zwave")

    def test_zwave_port_settings_keeps_keys_when_only_port_missing(self):
        """A restored store with keys but no port (the live #1594 repro):
        seed the port + soft-reset, keep the securityKeys intact."""
        import tempfile

        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "home-assistant", "zwave-js")
            os.makedirs(store, exist_ok=True)
            with open(os.path.join(store, "settings.json"), "w") as fh:
                json.dump({"zwave": {"securityKeys": {"S2_Authenticated": "k"}}}, fh)
            with run_with_env({"DATA_DIR": tmp}):
                changed = m.ensure_zwave_port_settings("/dev/ttyACM0")
            self.assertTrue(changed)
            with open(os.path.join(store, "settings.json")) as fh:
                data = json.load(fh)
            self.assertEqual(data["zwave"]["port"], "/dev/ttyACM0")
            self.assertIs(data["zwave"]["enableSoftReset"], False)
            self.assertEqual(data["zwave"]["securityKeys"]["S2_Authenticated"], "k")

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

    def test_zwave_device_redetected_when_unset(self):
        """#1511: a wipe-configs reinstall loses ZWAVE_DEVICE. When it's
        unset but exactly one USB-serial stick is on the box, the script
        re-detects it and writes the udev rule against the resolved path —
        no operator step."""
        m = load_script("home-assistant")
        import urllib.error
        import urllib.request

        # Exactly one resolved device → auto-pick fires.
        with mock.patch.object(m, "_detect_single_usb_serial_device", lambda: "/dev/ttyACM0"):
            captured = {}

            def fake_ensure(dev):
                captured["dev"] = dev

            env = {"HA_OIDC_AUTH_VERSION": "v0.6.0"}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("nope"))), \
                    mock.patch.object(m, "ensure_udev_rule", fake_ensure), \
                    mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(captured.get("dev"), "/dev/ttyACM0")
        self.assertIn("re-detected /dev/ttyACM0", out)

    def test_zwave_device_not_redetected_when_ambiguous(self):
        """Two sticks → don't guess; skip the udev rule. (Mirrors the
        installer's 'auto-pick only when exactly one' rule.)"""
        m = load_script("home-assistant")
        import urllib.error
        import urllib.request

        with mock.patch.object(m, "_detect_single_usb_serial_device", lambda: None):
            env = {"HA_OIDC_AUTH_VERSION": "v0.6.0"}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("nope"))), \
                    mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertIn("no single USB-serial stick detected", out)

    def test_detect_single_usb_serial_resolves_and_dedupes(self):
        """A multi-radio stick has several by-id symlinks pointing at one
        tty — the resolver must collapse them to a single device and pick
        it; two distinct ttys must yield None."""
        import tempfile
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            tty = os.path.join(tmp, "ttyACM0")
            open(tty, "w").close()
            by_id = os.path.join(tmp, "by-id")
            os.makedirs(by_id)
            os.symlink(tty, os.path.join(by_id, "usb-Foo-if00"))
            os.symlink(tty, os.path.join(by_id, "usb-Foo-if01"))
            with mock.patch.object(m, "ZWAVE_BY_ID_DIR", by_id):
                self.assertEqual(m._detect_single_usb_serial_device(), os.path.realpath(tty))

            # Add a second distinct device → ambiguous → None.
            tty2 = os.path.join(tmp, "ttyUSB0")
            open(tty2, "w").close()
            os.symlink(tty2, os.path.join(by_id, "usb-Bar-if00"))
            with mock.patch.object(m, "ZWAVE_BY_ID_DIR", by_id):
                self.assertIsNone(m._detect_single_usb_serial_device())

    def test_fresh_install_persists_solaris_token(self):
        """#1847 / solbay#408: on a fresh install (onboarding user step not
        done) the script onboards the admin, mints a long-lived token, and
        persists it at the new `.solaris-long-lived-token` path that downstream
        adopt_ha_long_lived_token() reads — otherwise HASS_TOKEN comes up empty."""
        import tempfile
        import urllib.request
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            def fake_urlopen(req, *_a, **_kw):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "github.com" in url:
                    raise AssertionError(f"unexpected download: {url}")

                class _R:
                    def __init__(self, status, body):
                        self.status = status
                        self._b = json.dumps(body).encode("utf-8") if body is not None else b"<html></html>"
                    def read(self):
                        return self._b
                    def __enter__(self):
                        return self
                    def __exit__(self, *a):
                        return False

                if "/api/onboarding/users" in url:
                    return _R(200, {"auth_code": "fresh-auth-code"})
                if "/api/onboarding" in url:
                    return _R(200, [{"step": "user", "done": False}])
                if "/auth/token" in url:
                    return _R(200, {"access_token": "fresh-access-tok"})
                return _R(200, None)

            def fake_mint(access_token):
                return "fresh-long-lived"

            env = {
                "HA_OIDC_AUTH_VERSION": "v0.6.0",
                "DATA_DIR": tmp,
                "OSCAR_HA_ADMIN_USERNAME": "oscar",
                "OSCAR_HA_ADMIN_PASSWORD": "pw",
            }
            ha_cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            oidc = os.path.join(ha_cfg, "custom_components", "auth_oidc")
            os.makedirs(oidc, exist_ok=True)
            with open(os.path.join(oidc, ".sb_installed_version"), "w") as fh:
                fh.write("v0.6.0\n")
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch.object(m, "_mint_long_lived_token", fake_mint), \
                    mock.patch.object(m, "_complete_remaining_onboarding_steps", lambda *_a, **_k: None), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            token_file = os.path.join(ha_cfg, ".solaris-long-lived-token")
            self.assertTrue(os.path.isfile(token_file))
            with open(token_file) as fh:
                self.assertEqual(fh.read().strip(), "fresh-long-lived")

    def test_token_remint_via_login_when_user_already_onboarded(self):
        """#1505: after a wipe-configs reinstall HA's user already exists
        but ServiceBay lost the long-lived token. The script must log in as
        the existing admin (no second user) and mint + persist a fresh
        token."""
        import tempfile
        import urllib.request
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            def fake_urlopen(req, *_a, **_kw):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "github.com" in url:
                    raise AssertionError(f"unexpected download: {url}")

                class _R:
                    def __init__(self, status, body):
                        self.status = status
                        self._b = json.dumps(body).encode("utf-8") if body is not None else b"<html></html>"
                    def read(self):
                        return self._b
                    def __enter__(self):
                        return self
                    def __exit__(self, *a):
                        return False

                if "/api/onboarding" in url:
                    return _R(200, [{"step": "user", "done": True}])
                if "/auth/login_flow/" in url:
                    return _R(200, {"type": "create_entry", "result": "auth-code-xyz"})
                if "/auth/login_flow" in url:
                    return _R(200, {"flow_id": "flow-123"})
                if "/auth/token" in url:
                    return _R(200, {"access_token": "short-lived-tok"})
                if "/auth/oidc/welcome" in url or url.rstrip("/").endswith("8123"):
                    return _R(200, None)
                # HA-readiness probe (GET /) + everything else → 200 html.
                return _R(200, None)

            minted = {}

            def fake_mint(access_token):
                minted["access"] = access_token
                return "long-lived-tok"

            env = {
                "HA_OIDC_AUTH_VERSION": "v0.6.0",
                "DATA_DIR": tmp,
                "OSCAR_HA_ADMIN_USERNAME": "oscar",
                "OSCAR_HA_ADMIN_PASSWORD": "pw",
            }
            # Pre-create the config dir + auth_oidc stamp so the OIDC install
            # path short-circuits (no tarball download in the test).
            ha_cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            oidc = os.path.join(ha_cfg, "custom_components", "auth_oidc")
            os.makedirs(oidc, exist_ok=True)
            with open(os.path.join(oidc, ".sb_installed_version"), "w") as fh:
                fh.write("v0.6.0\n")
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch.object(m, "_mint_long_lived_token", fake_mint), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("Re-provisioning HA long-lived token from kept data", out)
            self.assertEqual(minted.get("access"), "short-lived-tok")
            token_file = os.path.join(tmp, "home-assistant", "homeassistant", ".solaris-long-lived-token")
            self.assertTrue(os.path.isfile(token_file))
            with open(token_file) as fh:
                self.assertEqual(fh.read().strip(), "long-lived-tok")

    def test_valid_existing_token_short_circuits_remint(self):
        """If the persisted token still authenticates, the reconcile is a
        no-op — no login_flow, no re-mint."""
        import tempfile
        import urllib.request
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(cfg, exist_ok=True)
            with open(os.path.join(cfg, ".solaris-long-lived-token"), "w") as fh:
                fh.write("good-token\n")
            # Stamp so the OIDC install path skips the tarball download.
            oidc = os.path.join(cfg, "custom_components", "auth_oidc")
            os.makedirs(oidc, exist_ok=True)
            with open(os.path.join(oidc, ".sb_installed_version"), "w") as fh:
                fh.write("v0.6.0\n")

            def fake_urlopen(req, *_a, **_kw):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "/auth/login_flow" in url:
                    raise AssertionError("must not start a login flow when the token is valid")

                class _R:
                    status = 200
                    def read(self):
                        return b"<html></html>"
                    def __enter__(self):
                        return self
                    def __exit__(self, *a):
                        return False
                return _R()

            env = {
                "HA_OIDC_AUTH_VERSION": "v0.6.0",
                "DATA_DIR": tmp,
                "OSCAR_HA_ADMIN_USERNAME": "oscar",
                "OSCAR_HA_ADMIN_PASSWORD": "pw",
            }
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("still authenticates — nothing to reconcile", out)

    def test_legacy_oscar_token_migrated_to_solaris(self):
        """#1769 + solbay#408: a box onboarded before the OSCAR→Solilos→Solaris
        renames has a valid token only at the oldest legacy
        `.oscar-long-lived-token` path. The deploy renames it on disk to
        `.solaris-long-lived-token` and reuses it — no re-mint, no login flow,
        even without working admin creds (two-hop chain in one move)."""
        import tempfile
        import urllib.request
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(cfg, exist_ok=True)
            legacy_file = os.path.join(cfg, ".oscar-long-lived-token")
            new_file = os.path.join(cfg, ".solaris-long-lived-token")
            with open(legacy_file, "w") as fh:
                fh.write("good-token\n")
            # Stamp so the OIDC install path skips the tarball download.
            oidc = os.path.join(cfg, "custom_components", "auth_oidc")
            os.makedirs(oidc, exist_ok=True)
            with open(os.path.join(oidc, ".sb_installed_version"), "w") as fh:
                fh.write("v0.6.0\n")

            def fake_urlopen(req, *_a, **_kw):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "/auth/login_flow" in url:
                    raise AssertionError("must not start a login flow after migrating a valid legacy token")

                class _R:
                    status = 200
                    def read(self):
                        return b"<html></html>"
                    def __enter__(self):
                        return self
                    def __exit__(self, *a):
                        return False
                return _R()

            env = {
                "HA_OIDC_AUTH_VERSION": "v0.6.0",
                "DATA_DIR": tmp,
                "OSCAR_HA_ADMIN_USERNAME": "oscar",
                "OSCAR_HA_ADMIN_PASSWORD": "pw",
            }
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(legacy_file))
            self.assertTrue(os.path.isfile(new_file))
            with open(new_file) as fh:
                self.assertEqual(fh.read().strip(), "good-token")
            self.assertIn("Migrated legacy HA token", out)
            self.assertIn("still authenticates — nothing to reconcile", out)

    def test_legacy_solilos_token_migrated_to_solaris(self):
        """solbay#408: a box onboarded after OSCAR→Solilos but before
        Solilos→Solaris has a valid token at `.solilos-long-lived-token`. The
        deploy renames it on disk to `.solaris-long-lived-token` and reuses it —
        no re-mint, no login flow, even without working admin creds."""
        import tempfile
        import urllib.request
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(cfg, exist_ok=True)
            legacy_file = os.path.join(cfg, ".solilos-long-lived-token")
            new_file = os.path.join(cfg, ".solaris-long-lived-token")
            with open(legacy_file, "w") as fh:
                fh.write("good-token\n")
            # Stamp so the OIDC install path skips the tarball download.
            oidc = os.path.join(cfg, "custom_components", "auth_oidc")
            os.makedirs(oidc, exist_ok=True)
            with open(os.path.join(oidc, ".sb_installed_version"), "w") as fh:
                fh.write("v0.6.0\n")

            def fake_urlopen(req, *_a, **_kw):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "/auth/login_flow" in url:
                    raise AssertionError("must not start a login flow after migrating a valid legacy token")

                class _R:
                    status = 200
                    def read(self):
                        return b"<html></html>"
                    def __enter__(self):
                        return self
                    def __exit__(self, *a):
                        return False
                return _R()

            env = {
                "HA_OIDC_AUTH_VERSION": "v0.6.0",
                "DATA_DIR": tmp,
                "OSCAR_HA_ADMIN_USERNAME": "oscar",
                "OSCAR_HA_ADMIN_PASSWORD": "pw",
            }
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen", fake_urlopen), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(legacy_file))
            self.assertTrue(os.path.isfile(new_file))
            with open(new_file) as fh:
                self.assertEqual(fh.read().strip(), "good-token")
            self.assertIn("Migrated legacy HA token", out)
            self.assertIn("still authenticates — nothing to reconcile", out)

    def test_kept_data_state_reported(self):
        """#1512: the script states whether HA kept-data was found, so the
        operator isn't left guessing why HA looks bare."""
        import tempfile
        import urllib.error
        import urllib.request
        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(os.path.join(cfg, ".storage"), exist_ok=True)
            zwave = os.path.join(tmp, "home-assistant", "zwave-js")
            os.makedirs(zwave, exist_ok=True)
            open(os.path.join(zwave, "settings.json"), "w").close()

            env = {"HA_OIDC_AUTH_VERSION": "v0.6.0", "DATA_DIR": tmp}
            with run_with_env(env), \
                    mock.patch.object(urllib.request, "urlopen",
                                      lambda *_a, **_kw: (_ for _ in ()).throw(urllib.error.URLError("nope"))), \
                    mock.patch.object(m, "HA_READY_TIMEOUT", 0.01), \
                    mock.patch.object(m, "HA_READY_INTERVAL", 0.001):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("kept-data found", out)
            self.assertIn("re-wiring against the existing mesh", out)

    def test_auth_oidc_block_reseeded_when_missing(self):
        """#1687: after a backup-restore the restored configuration.yaml has
        no auth_oidc: block; ensure_auth_oidc_config_block re-appends it from
        the post-deploy env (secret/groups/domain) without clobbering the
        user's existing content."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(cfg, exist_ok=True)
            cfg_file = os.path.join(cfg, "configuration.yaml")
            with open(cfg_file, "w") as fh:
                fh.write("default_config:\n\nfrontend:\n  themes: !include themes.yaml\n")
            env = {
                "DATA_DIR": tmp,
                "HA_OIDC_SECRET": "s3cret",
                "PUBLIC_DOMAIN": "dopp.cloud",
                "HA_OIDC_ADMIN_GROUP": "admins",
                "HA_OIDC_USER_GROUP": "family",
            }
            with run_with_env(env):
                changed = m.ensure_auth_oidc_config_block()
            self.assertTrue(changed)
            content = open(cfg_file).read()
            # User content preserved + auth_oidc appended with rendered values.
            self.assertIn("frontend:", content)
            self.assertIn("auth_oidc:", content)
            self.assertIn("client_secret: s3cret", content)
            self.assertIn("auth.dopp.cloud/.well-known/openid-configuration", content)
            self.assertIn('admin: "admins"', content)

            # Idempotent: a second pass leaves the (now-present) block alone.
            with run_with_env(env):
                again = m.ensure_auth_oidc_config_block()
            self.assertFalse(again)
            self.assertEqual(content, open(cfg_file).read())

    def test_auth_oidc_block_skipped_without_secret(self):
        """No HA_OIDC_SECRET → never write a half-filled auth_oidc block."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(cfg, exist_ok=True)
            cfg_file = os.path.join(cfg, "configuration.yaml")
            with open(cfg_file, "w") as fh:
                fh.write("default_config:\n")
            with run_with_env({"DATA_DIR": tmp, "PUBLIC_DOMAIN": "dopp.cloud"}):
                changed = m.ensure_auth_oidc_config_block()
            self.assertFalse(changed)
            self.assertNotIn("auth_oidc:", open(cfg_file).read())

    def test_orphaned_helpers_detected_and_reported(self):
        """#1686: a restored entity_registry stub on a helper platform whose
        config_entry_id has no row in core.config_entries is reported as an
        orphan; a helper with a resolvable entry and a normal (non-helper)
        entity are not."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            storage = os.path.join(tmp, "home-assistant", "homeassistant", ".storage")
            os.makedirs(storage, exist_ok=True)
            registry = {"data": {"entities": [
                # Orphan: integration helper pointing at a missing entry.
                {"entity_id": "sensor.senec_import", "platform": "integration",
                 "config_entry_id": "gone1"},
                # Orphan: template helper with a None config entry.
                {"entity_id": "cover.garage", "platform": "template",
                 "config_entry_id": None},
                # Healthy helper: entry exists.
                {"entity_id": "sensor.daily_energy", "platform": "utility_meter",
                 "config_entry_id": "present1"},
                # Not a helper platform → ignored even with a dangling entry.
                {"entity_id": "light.kitchen", "platform": "hue",
                 "config_entry_id": "gone2"},
            ]}}
            entries = {"data": {"entries": [{"entry_id": "present1"}]}}
            with open(os.path.join(storage, "core.entity_registry"), "w") as fh:
                json.dump(registry, fh)
            with open(os.path.join(storage, "core.config_entries"), "w") as fh:
                json.dump(entries, fh)

            with run_with_env({"DATA_DIR": tmp}):
                orphans = m.find_orphaned_helpers()
                ids = {o["entity_id"] for o in orphans}
                self.assertEqual(ids, {"sensor.senec_import", "cover.garage"})

                buf = io.StringIO()
                old = sys.stdout
                sys.stdout = buf
                try:
                    m.report_orphaned_helpers()
                finally:
                    sys.stdout = old
                report = buf.getvalue()
            self.assertIn("2 Home Assistant helper(s) did not fully restore", report)
            self.assertIn("sensor.senec_import", report)
            self.assertIn("cover.garage", report)
            self.assertNotIn("sensor.daily_energy", report)
            self.assertNotIn("light.kitchen", report)

    def test_orphaned_helpers_none_on_fresh_install(self):
        """No entity_registry (fresh install / no restore) → no orphans, no
        report, no crash."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "home-assistant", "homeassistant"), exist_ok=True)
            with run_with_env({"DATA_DIR": tmp}):
                self.assertEqual(m.find_orphaned_helpers(), [])
                buf = io.StringIO()
                old = sys.stdout
                sys.stdout = buf
                try:
                    m.report_orphaned_helpers()
                finally:
                    sys.stdout = old
            self.assertEqual(buf.getvalue(), "")


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



class ImmichScript(unittest.TestCase):
    """#1556: on a wipe-configs reinstall Authelia regenerates the OIDC
    client secret (CONFIG) but Immich keeps its copy in its DB (survived
    DATA), so they drift and SSO login fails with "Failed to finish
    oauth". The admin-authenticated PUT /api/system-config can't repair it
    because the freshly-generated IMMICH_ADMIN_PASSWORD no longer matches
    the preserved admin row, so the script falls back to a DB-level
    secret re-stamp (no admin token needed)."""

    BASE_RESPONSES = {
        "/api/server/ping": {"status": 200, "body": {}},
    }

    def _run(self, m, env, responses, fake_psql):
        import urllib.request
        import subprocess as subprocess_mod
        import time as time_mod
        with run_with_env(env), \
                mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory(responses)), \
                mock.patch.object(time_mod, "sleep", lambda _s: None), \
                mock.patch.object(subprocess_mod, "run", fake_psql), \
                mock.patch.object(m, "READY_INTERVAL", 0.001):
            return capture_main(m)

    def _psql_recorder(self, select_value: str):
        """Return (run_fn, calls) where run_fn fakes `podman exec … psql`.
        SELECT returns `select_value`; UPDATE returns rc 0 and is recorded
        with its bound `-v secret=…` value so the test can assert the
        new secret was written.

        SQL is now passed via `input=` kwarg (stdin mode — so psql variable
        interpolation works); the recorder reads it from `_kw['input']`."""
        calls: list[dict[str, Any]] = []

        class _CP:
            def __init__(self, rc=0, out=""):
                self.returncode = rc
                self.stdout = out
                self.stderr = ""

        def run_fn(cmd, *_a, **_kw):
            sql = _kw.get("input", "")
            secret_var = None
            for i, tok in enumerate(cmd):
                if tok == "-v" and i + 1 < len(cmd) and cmd[i + 1].startswith("secret="):
                    secret_var = cmd[i + 1].split("=", 1)[1]
            calls.append({"sql": sql, "secret": secret_var})
            if sql.strip().upper().startswith("SELECT"):
                return _CP(0, select_value)
            return _CP(0, "UPDATE 1")

        return run_fn, calls

    def test_db_reconcile_on_admin_login_failure_when_secret_drifts(self):
        m = load_script("immich")
        # admin sign-up → 400 (admin pre-exists), login → 401 forever
        # (preserved admin row, mismatched freshly-generated password).
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 400, "body": {}}
        responses["/api/auth/login"] = {"status": 401, "body": {}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "true",
            "IMMICH_SSO_SECRET": "fresh-authelia-secret",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "regenerated-pw",
            "DB_PASSWORD": "db-pass",
        }
        # DB holds the OLD, drifted secret.
        run_fn, calls = self._psql_recorder("stale-immich-secret")
        rc, out = self._run(m, env, responses, run_fn)
        self.assertEqual(rc, 0)
        self.assertIn("DB-level OIDC secret reconcile", out)
        self.assertIn("Reconciled Immich's stored OIDC secret", out)
        # An UPDATE must have been issued, binding the fresh secret.
        updates = [c for c in calls if c["sql"].strip().upper().startswith("UPDATE")]
        self.assertEqual(len(updates), 1, calls)
        self.assertEqual(updates[0]["secret"], "fresh-authelia-secret")
        # The secret must not leak into a user-visible log line.
        log_only = "\n".join(
            line for line in out.splitlines() if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("fresh-authelia-secret", log_only)
        self.assertNotIn("stale-immich-secret", log_only)

    def test_db_reconcile_noop_when_secret_already_matches(self):
        m = load_script("immich")
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 400, "body": {}}
        responses["/api/auth/login"] = {"status": 401, "body": {}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "true",
            "IMMICH_SSO_SECRET": "matching-secret",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "regenerated-pw",
            "DB_PASSWORD": "db-pass",
        }
        run_fn, calls = self._psql_recorder("matching-secret")
        rc, out = self._run(m, env, responses, run_fn)
        self.assertEqual(rc, 0)
        self.assertIn("already matches Authelia", out)
        # No UPDATE when the stored secret is already correct.
        self.assertFalse(any(c["sql"].strip().upper().startswith("UPDATE") for c in calls), calls)

    def test_db_reconcile_skipped_when_no_oauth_in_db(self):
        m = load_script("immich")
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 400, "body": {}}
        responses["/api/auth/login"] = {"status": 401, "body": {}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "true",
            "IMMICH_SSO_SECRET": "fresh-secret",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "regenerated-pw",
            "DB_PASSWORD": "db-pass",
        }
        # Empty SELECT → no oauth block yet → nothing to reconcile.
        run_fn, calls = self._psql_recorder("")
        rc, out = self._run(m, env, responses, run_fn)
        self.assertEqual(rc, 0)
        self.assertIn("nothing to reconcile", out)
        self.assertFalse(any(c["sql"].strip().upper().startswith("UPDATE") for c in calls), calls)

    def test_happy_path_configures_oidc_via_api_no_db_touch(self):
        m = load_script("immich")
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 201, "body": {}}
        responses["/api/auth/login"] = {"status": 201, "body": {"accessToken": "tok"}}
        responses["/api/system-config"] = {"status": 200, "body": {"oauth": {}}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "true",
            "IMMICH_SSO_SECRET": "fresh-secret",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "pw",
            "DB_PASSWORD": "db-pass",
        }
        # psql must never be invoked on the happy path.
        def boom(*_a, **_kw):
            raise AssertionError("psql must not run when the admin API path succeeds")
        rc, out = self._run(m, env, responses, boom)
        self.assertEqual(rc, 0)
        self.assertIn("Immich OIDC configured", out)

    # ---- #1928: preserved-pgdata admin password rekey ----------------------

    def _rekey_recorder(self, *, user_exists=True, bcrypt_ok=True, login_after_rekey="201"):
        """Fake `podman exec` for the rekey path. Distinguishes the three call
        shapes: the `SELECT 1 FROM "user"` probe, the in-container `node -e`
        bcrypt mint, and the `UPDATE "user"` re-stamp. `login_after_rekey` is
        unused by the fake (login is HTTP, mocked separately) but documents
        intent. Records the UPDATE's bound `hash=` value.

        SQL is now passed via `input=` kwarg (stdin mode); the recorder reads
        it from `_kw['input']`. Table is `"user"` (singular, quoted reserved
        word) — Immich's actual schema name, not the plural `users`."""
        calls: list[dict[str, Any]] = []

        class _CP:
            def __init__(self, rc=0, out=""):
                self.returncode = rc
                self.stdout = out
                self.stderr = ""

        def run_fn(cmd, *_a, **_kw):
            # bcrypt mint: `podman exec -e SB_NEW_PW=… -w <dir> <ctr> node -e <src>`
            if "node" in cmd and "-e" in cmd:
                calls.append({"kind": "bcrypt", "cmd": list(cmd)})
                if not bcrypt_ok:
                    return _CP(1, "")
                return _CP(0, "$2b$11$" + "x" * 53)
            sql = _kw.get("input", "")
            bound = {}
            for i, tok in enumerate(cmd):
                if tok == "-v" and i + 1 < len(cmd):
                    k, _, v = cmd[i + 1].partition("=")
                    bound[k] = v
            upper = sql.strip().upper()
            if 'SELECT 1 FROM "USER"' in upper:
                calls.append({"kind": "user_select", "bound": bound})
                return _CP(0, "1" if user_exists else "")
            if upper.startswith('UPDATE "USER"'):
                calls.append({"kind": "user_update", "bound": bound})
                return _CP(0, "UPDATE 1")
            # Any OIDC-secret SELECT/UPDATE that may still run afterwards.
            if upper.startswith("SELECT"):
                calls.append({"kind": "oidc_select"})
                return _CP(0, "")
            calls.append({"kind": "other", "sql": sql})
            return _CP(0, "")

        return run_fn, calls

    def test_admin_password_rekey_recovers_login_on_preserved_pgdata(self):
        """The core #1928 path: admin pre-exists, login 401s (preserved
        password), so the script rekeys the admin password hash in the DB and
        the follow-up login succeeds, letting the OIDC API config run."""
        m = load_script("immich")
        # Login 401s while the preserved password mismatches; once the rekey
        # has re-stamped the hash, the follow-up login attempt succeeds.
        login_states = {"n": 0}
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 400, "body": {}}
        # Stateful login: first 8 attempts 401, then 201 after rekey.
        def login_response():
            login_states["n"] += 1
            if login_states["n"] <= 8:
                return {"status": 401, "body": {}}
            return {"status": 201, "body": {"accessToken": "tok"}}
        responses["/api/auth/login"] = login_response
        responses["/api/system-config"] = {"status": 200, "body": {"oauth": {}}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "true",
            "IMMICH_SSO_SECRET": "fresh-secret",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "regenerated-pw",
            "DB_PASSWORD": "db-pass",
        }
        run_fn, calls = self._rekey_recorder()
        rc, out = self._run(m, env, responses, run_fn)
        self.assertEqual(rc, 0)
        # The admin row was probed, bcrypt minted, and the hash re-stamped.
        kinds = [c["kind"] for c in calls]
        self.assertIn("user_select", kinds)
        self.assertIn("bcrypt", kinds)
        # The bcrypt mint must run with `-w /usr/src/app/server` so Node
        # resolves `bcrypt` from immich-server's app node_modules; without it
        # `require('bcrypt')` fails "Cannot find module" (rc=1). The `-w <dir>`
        # is a `podman exec` flag, so it must precede the container name
        # (arg order: `podman exec [flags] CONTAINER CMD...`).
        bcrypt_cmd = next(c for c in calls if c["kind"] == "bcrypt")["cmd"]
        self.assertIn("-w", bcrypt_cmd)
        w_idx = bcrypt_cmd.index("-w")
        self.assertEqual(bcrypt_cmd[w_idx + 1], "/usr/src/app/server")
        self.assertIn("immich-immich-server", bcrypt_cmd)
        self.assertLess(
            w_idx, bcrypt_cmd.index("immich-immich-server"),
            "the -w workdir flag must precede the container name",
        )
        update = next(c for c in calls if c["kind"] == "user_update")
        self.assertTrue(update["bound"].get("hash", "").startswith("$2"))
        self.assertEqual(update["bound"].get("email"), "op@example.com")
        self.assertIn("Rekeyed the preserved Immich admin password", out)
        self.assertIn("Admin login succeeded after the DB rekey", out)
        # And the API-authenticated OIDC config then ran.
        self.assertIn("Immich OIDC configured", out)
        # The new password / hash must not leak into a user-visible log line.
        log_only = "\n".join(
            line for line in out.splitlines() if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("regenerated-pw", log_only)
        self.assertNotIn(update["bound"]["hash"], log_only)

    def test_rekey_skipped_when_admin_row_absent(self):
        """Fresh DATA dir: no admin row yet → no rekey, no UPDATE. The script
        must not invent a row; admin-sign-up seeds it via the API."""
        m = load_script("immich")
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 400, "body": {}}
        responses["/api/auth/login"] = {"status": 401, "body": {}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "false",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "regenerated-pw",
            "DB_PASSWORD": "db-pass",
        }
        run_fn, calls = self._rekey_recorder(user_exists=False)
        rc, out = self._run(m, env, responses, run_fn)
        self.assertEqual(rc, 0)
        self.assertFalse(any(c["kind"] == "user_update" for c in calls), calls)
        self.assertFalse(any(c["kind"] == "bcrypt" for c in calls), calls)
        self.assertIn("nothing to rekey", out)

    def test_rekey_aborts_cleanly_when_bcrypt_unavailable(self):
        """If the bcrypt mint fails, no UPDATE is issued and the script
        degrades honestly (no masked success) — login still failed."""
        m = load_script("immich")
        responses = dict(self.BASE_RESPONSES)
        responses["/api/auth/admin-sign-up"] = {"status": 400, "body": {}}
        responses["/api/auth/login"] = {"status": 401, "body": {}}
        env = {
            "PUBLIC_DOMAIN": "dopp.cloud",
            "IMMICH_SSO_ENABLED": "false",
            "IMMICH_ADMIN_EMAIL": "op@example.com",
            "IMMICH_ADMIN_PASSWORD": "regenerated-pw",
            "DB_PASSWORD": "db-pass",
        }
        run_fn, calls = self._rekey_recorder(bcrypt_ok=False)
        rc, out = self._run(m, env, responses, run_fn)
        self.assertEqual(rc, 0)
        self.assertFalse(any(c["kind"] == "user_update" for c in calls), calls)
        self.assertNotIn("Rekeyed the preserved Immich admin password", out)
        # Honest degrade message, not a cheerful success.
        self.assertIn("admin row pre-dates this install", out)


if __name__ == "__main__":
    unittest.main()
