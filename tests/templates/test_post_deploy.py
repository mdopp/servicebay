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
import tarfile
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

    def test_config_paths_track_data_dir_instead_of_a_hardcoded_root(self):
        """#2424: the two notifier paths were module-level literals pinned to
        one deployment's `/mnt/data...` root, so on any install with a
        non-default DATA_DIR the SMTP wiring silently no-opped. They must now
        derive from DATA_DIR, like `authelia_db_path()` in the same file."""
        m = load_script("auth")
        with run_with_env({"DATA_DIR": "/srv/pool/stacks"}):
            self.assertEqual(
                m.authelia_config_path(),
                "/srv/pool/stacks/auth/authelia-config/configuration.yml",
            )
            # ServiceBay's own config.json is a SIBLING of the stacks dir, so
            # the parent is probed first, then DATA_DIR itself (bare-/mnt/data
            # dev layout). Neither candidate is a hardcoded literal.
            self.assertEqual(
                m.sb_config_path_candidates(),
                ["/srv/pool/servicebay/config.json", "/srv/pool/stacks/servicebay/config.json"],
            )
        src = (TEMPLATES_DIR / "auth" / "post-deploy.py").read_text()
        self.assertNotIn('"/mnt/data/servicebay/config.json"', src)
        self.assertNotIn('"/mnt/data/stacks/auth/authelia-config/configuration.yml"', src)

    def test_smtp_notifier_is_wired_on_a_non_default_data_dir(self):
        """End-to-end for #2424: with DATA_DIR pointed somewhere other than the
        default, `rewrite_authelia_smtp_notifier` must FIND ServiceBay's email
        config on disk and REWRITE Authelia's filesystem notifier to smtp.
        Before the fix this printed 'Authelia config not at ...' and did
        nothing while the UI reported email as configured."""
        import tempfile
        m = load_script("auth")
        with tempfile.TemporaryDirectory() as root:
            # Box layout: <root>/servicebay (ServiceBay) + <root>/stacks (DATA_DIR).
            data_dir = os.path.join(root, "stacks")
            sb_dir = os.path.join(root, "servicebay")
            authelia_dir = os.path.join(data_dir, "auth", "authelia-config")
            os.makedirs(sb_dir)
            os.makedirs(authelia_dir)
            with open(os.path.join(sb_dir, "config.json"), "w", encoding="utf-8") as fh:
                json.dump({"notifications": {"email": {
                    "host": "smtp.example.com", "port": 587, "secure": False,
                    "user": "box@example.com", "pass": "s3cret", "from": "box@example.com",
                }}}, fh)
            cfg = os.path.join(authelia_dir, "configuration.yml")
            with open(cfg, "w", encoding="utf-8") as fh:
                fh.write("theme: light\n\nnotifier:\n  filesystem:\n    filename: /data/notification.txt\n\nserver:\n  address: 'tcp://:9091'\n")

            # No SB_API_TOKEN → the API path is skipped and the on-disk
            # fallback (the half that #2424 broke) is what runs.
            with run_with_env({"DATA_DIR": data_dir}):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    m.rewrite_authelia_smtp_notifier("http://127.0.0.1:5888")
                out = buf.getvalue()

            self.assertNotIn("skipping notifier rewrite", out)
            self.assertIn("Rewrote Authelia notifier", out)
            with open(cfg, encoding="utf-8") as fh:
                written = fh.read()
            self.assertIn("submission://smtp.example.com:587", written)
            self.assertIn("username: 'box@example.com'", written)
            self.assertNotIn("filesystem:", written)
            # The surrounding config survives the splice untouched.
            self.assertIn("theme: light", written)
            self.assertIn("address: 'tcp://:9091'", written)

    def test_smtp_notifier_finds_config_on_a_bare_data_dir_layout(self):
        """The dev/default layout has no `stacks` level: DATA_DIR and the
        servicebay dir share a parent. The second candidate covers it."""
        import tempfile
        m = load_script("auth")
        with tempfile.TemporaryDirectory() as data_dir:
            os.makedirs(os.path.join(data_dir, "servicebay"))
            with open(os.path.join(data_dir, "servicebay", "config.json"), "w", encoding="utf-8") as fh:
                json.dump({"notifications": {"email": {
                    "host": "smtp.example.com", "port": 465, "secure": True,
                    "user": "box@example.com", "pass": "s3cret", "from": "box@example.com",
                }}}, fh)
            with run_with_env({"DATA_DIR": data_dir}):
                em = m._sb_email_config("http://127.0.0.1:5888")
            self.assertIsNotNone(em)
            self.assertEqual(em["host"], "smtp.example.com")


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
            "host.containers.internal", "3890", "dc=example,dc=com",
            "uid=admin,ou=people,dc=example,dc=com", "bindpw",
            "cn=lldap_admin,ou=groups,dc=example,dc=com", ["pubA", "pubB"],
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

    # ── #2375: redeploy of an already-initialized Jellyfin ───────────────

    def test_jellyfin_wizard_guard_retries_instead_of_falling_through(self):
        """#2375: the StartupWizardCompleted guard is probed over a bounded
        window, not once. A pod-topology change fully restarts the container,
        so Kestrel can still be coming up when the first probe fires. The
        guard must retry and short-circuit on the delayed "wizard already
        completed" answer, never falling through to the /Startup/FirstUser
        wait (which can only 401 on an already-initialized server)."""
        m = load_script("media")
        m.JELLYFIN_WIZARD_PROBE_TIMEOUT = 30
        m.JELLYFIN_READY_INTERVAL = 0  # don't actually sleep between probes
        import urllib.error
        import urllib.request

        calls: list[str] = []
        probes = {"n": 0}
        outer = self

        def urlopen(req, *_a, **_kw):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            calls.append(url)
            if "/System/Info/Public" in url:
                probes["n"] += 1
                if probes["n"] < 3:
                    # Kestrel not listening yet right after the restart.
                    raise urllib.error.URLError("connection refused")
                return outer._resp(200, json.dumps({"StartupWizardCompleted": True}))
            raise urllib.error.URLError(f"unmocked URL: {url}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            ok = m.jellyfin_run_first_setup("http://jf", "admin", "pw", "Europe/Berlin")

        self.assertTrue(ok)
        self.assertEqual(probes["n"], 3)  # retried, not single-shot
        # Never fell through to the first-run path.
        self.assertFalse(any("/Startup/FirstUser" in u for u in calls))
        self.assertFalse(any("/Startup/Configuration" in u for u in calls))

    def test_jellyfin_first_user_401_means_already_past_first_run(self):
        """#2375: once the wizard is completed Jellyfin locks /Startup/* down
        and /Startup/FirstUser answers 401 forever — never 200. If the
        public-info guard gets no usable answer inside its window, the
        first-user wait must read that 401 as "already past first-run" and
        return True promptly, instead of polling to JELLYFIN_READY_TIMEOUT and
        reporting not-ready (which silently skips music providers, the LrcLib
        plugin, DLNA, libraries and user access on that redeploy)."""
        m = load_script("media")
        m.JELLYFIN_WIZARD_PROBE_TIMEOUT = 0  # guard window already elapsed
        m.JELLYFIN_READY_INTERVAL = 0
        import urllib.error
        import urllib.request

        calls: list[str] = []

        def urlopen(req, *_a, **_kw):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            calls.append(url)
            if "/System/Info/Public" in url:
                raise urllib.error.URLError("connection refused")
            if "/Startup/FirstUser" in url:
                raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)  # type: ignore[arg-type]
            raise urllib.error.URLError(f"unmocked URL: {url}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            ok = m.jellyfin_run_first_setup("http://jf", "admin", "pw", "Europe/Berlin")

        self.assertTrue(ok)
        # Exactly one FirstUser probe — the 401 ends the wait, no 5-min poll.
        self.assertEqual(len([u for u in calls if "/Startup/FirstUser" in u]), 1)
        # And no first-run walk was attempted against a locked-down server.
        self.assertFalse(any("/Startup/Configuration" in u for u in calls))

    # ── #1718: Jellyfin LDAP-Auth plugin → LLDAP ─────────────────────────

    def test_jellyfin_ldap_config_rendered_with_lldap_bind(self):
        """render_ldap_plugin_config emits the correct LLDAP bind/base/
        filter/group-map (mirrors Radicale's bind)."""
        m = load_script("media")
        xml = m.render_ldap_plugin_config(
            ldap_host="host.containers.internal",
            ldap_port="3890",
            base_dn="dc=example,dc=com",
            bind_dn="uid=admin,ou=people,dc=example,dc=com",
            bind_password="lldap-pass",
            admin_group_dn="cn=lldap_admin,ou=groups,dc=example,dc=com",
        )
        self.assertIn("<LdapServer>host.containers.internal</LdapServer>", xml)
        self.assertIn("<LdapPort>3890</LdapPort>", xml)
        self.assertIn("<LdapBaseDn>ou=people,dc=example,dc=com</LdapBaseDn>", xml)
        self.assertIn("<LdapBindUser>uid=admin,ou=people,dc=example,dc=com</LdapBindUser>", xml)
        # Filter mirrors Radicale: (&(objectClass=person)(uid={username}))
        # — the ampersand is XML-escaped.
        self.assertIn("(&amp;(objectClass=person)(uid={username}))", xml)
        # Admin-group map → Jellyfin admin.
        self.assertIn("(memberOf=cn=lldap_admin,ou=groups,dc=example,dc=com)", xml)
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
                    "3890", "dc=example,dc=com", "lldap-pass",
                )
            self.assertTrue(ok)
            self.assertTrue(os.path.isfile(cfg_path))
            with open(cfg_path, encoding="utf-8") as fh:
                first = fh.read()
            self.assertIn("<LdapServer>host.containers.internal</LdapServer>", first)
            self.assertIn("<LdapBindUser>uid=admin,ou=people,dc=example,dc=com</LdapBindUser>", first)
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
                    "3890", "dc=example,dc=com", "lldap-pass",
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
                    "3890", "dc=example,dc=com", "lldap-pass",
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
                    "3890", "dc=example,dc=com", "",
                )
            self.assertFalse(ok)
            cfg_path = os.path.join(
                tmp, "media", "jellyfin-config", "plugins",
                "configurations", "LDAP-Auth.xml",
            )
            self.assertFalse(os.path.isfile(cfg_path))

    def test_jellyfin_ldap_skipped_without_base_dn(self):
        """Empty LLDAP_BASE_DN → skip the LDAP wiring (#2439). Every DN in
        the plugin config is built from it, so writing one with a blank base
        binds against a tree that does not exist and fails every login."""
        import tempfile
        m = load_script("media")
        with tempfile.TemporaryDirectory() as tmp:
            with run_with_env({"DATA_DIR": tmp}):
                ok = m.ensure_jellyfin_ldap_plugin(
                    "http://127.0.0.1:8096", "jf-token",
                    "3890", "", "lldap-pass",
                )
            self.assertFalse(ok)
            cfg_path = os.path.join(
                tmp, "media", "jellyfin-config", "plugins",
                "configurations", "LDAP-Auth.xml",
            )
            self.assertFalse(os.path.isfile(cfg_path))

    def test_jellyfin_enable_music_providers_music_only_and_merges(self):
        """The music library gets EnableInternetProviders=true + the two
        fetchers; non-music libraries are untouched; the POST is a
        read-modify-write that preserves existing LibraryOptions."""
        m = load_script("media")
        import urllib.request, json
        folders = [
            {"Name": "Music", "ItemId": "id-music", "CollectionType": "music",
             "LibraryOptions": {"EnableRealtimeMonitor": False, "KeepExisting": "yes"}},
            {"Name": "Movies", "ItemId": "id-movies", "CollectionType": "movies",
             "LibraryOptions": {}},
        ]
        posts: list[dict] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if req.get_method() == "POST" and "/Library/VirtualFolders/LibraryOptions" in url:
                posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            m.jellyfin_enable_music_providers("http://jf", "tok", folders)

        # Only the music library is POSTed.
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["Id"], "id-music")
        opts = posts[0]["LibraryOptions"]
        self.assertTrue(opts["EnableInternetProviders"])
        # Existing settings preserved (read-modify-write, not a bare object).
        self.assertEqual(opts["KeepExisting"], "yes")
        self.assertFalse(opts["EnableRealtimeMonitor"])
        types = {t["Type"]: t for t in opts["TypeOptions"]}
        self.assertEqual(set(types), {"MusicArtist", "MusicAlbum"})
        for t in types.values():
            self.assertEqual(t["MetadataFetchers"], ["TheAudioDB", "MusicBrainz"])

    def test_jellyfin_enable_music_providers_idempotent(self):
        """Re-running posts the same EnableInternetProviders + fetchers."""
        m = load_script("media")
        import urllib.request, json
        folders = [
            {"Name": "Music", "ItemId": "id-music", "CollectionType": "music",
             "LibraryOptions": {}},
        ]
        posts: list[dict] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if req.get_method() == "POST" and "/Library/VirtualFolders/LibraryOptions" in url:
                posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            m.jellyfin_enable_music_providers("http://jf", "tok", folders)
            m.jellyfin_enable_music_providers("http://jf", "tok", folders)

        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["LibraryOptions"], posts[1]["LibraryOptions"])

    def test_jellyfin_enable_music_providers_failsoft(self):
        """A raising HTTP call is swallowed — the deploy is never blocked."""
        m = load_script("media")
        import urllib.request
        folders = [
            {"Name": "Music", "ItemId": "id-music", "CollectionType": "music",
             "LibraryOptions": {}},
        ]
        # No matching response → URLError inside request_json → non-2xx, no raise.
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory({})):
            m.jellyfin_enable_music_providers("http://jf", "tok", folders)  # must not raise

    def test_jellyfin_lrclib_repo_added_then_install(self):
        """ensure_jellyfin_lrclib_plugin registers the LrcLib community repo (when
        absent) and then requests the package install."""
        m = load_script("media")
        import urllib.request, json
        repo_posts: list[list] = []
        install_called: list[str] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            meth = req.get_method()
            if meth == "GET" and url.endswith("/Repositories"):
                return outer._resp(200, json.dumps([
                    {"Name": "Jellyfin Stable", "Url": "https://repo.jellyfin.org/manifest.json", "Enabled": True},
                ]))
            if meth == "POST" and url.endswith("/Repositories"):
                repo_posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            if meth == "POST" and "/Packages/Installed/" in url:
                install_called.append(url)
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            ok = m.ensure_jellyfin_lrclib_plugin("http://jf", "tok")

        self.assertTrue(ok)
        # The existing repo is preserved and the LrcLib manifest is appended.
        self.assertEqual(len(repo_posts), 1)
        urls = {r["Url"] for r in repo_posts[0]}
        self.assertIn(m.JELLYFIN_LRCLIB_REPO_URL, urls)
        self.assertIn("https://repo.jellyfin.org/manifest.json", urls)
        # The package install was requested.
        self.assertTrue(any("/Packages/Installed/" in u for u in install_called))

    def test_jellyfin_lrclib_repo_skipped_when_present(self):
        """When the LrcLib manifest is already registered, no repo POST is made;
        only the install is requested (idempotent on a redeploy)."""
        m = load_script("media")
        import urllib.request, json
        repo_posts: list = []
        install_called: list[str] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            meth = req.get_method()
            if meth == "GET" and url.endswith("/Repositories"):
                return outer._resp(200, json.dumps([
                    {"Name": "LrcLib", "Url": m.JELLYFIN_LRCLIB_REPO_URL, "Enabled": True},
                ]))
            if meth == "POST" and url.endswith("/Repositories"):
                repo_posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            if meth == "POST" and "/Packages/Installed/" in url:
                install_called.append(url)
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            ok = m.ensure_jellyfin_lrclib_plugin("http://jf", "tok")

        self.assertTrue(ok)
        self.assertEqual(repo_posts, [])  # repo already present → no add
        self.assertTrue(install_called)

    def test_jellyfin_lrclib_failsoft(self):
        """If the repositories can't be read, log-and-continue: returns False,
        never raises (the deploy must not be blocked)."""
        m = load_script("media")
        import urllib.request
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory({})):
            ok = m.ensure_jellyfin_lrclib_plugin("http://jf", "tok")  # must not raise
        self.assertFalse(ok)

    # ── #2282: a redeploy actually REACHES the music steps ────────────────

    def test_main_redeploy_reaches_music_providers_and_lrclib(self):
        """#2282 + #2375: on a redeploy of an already-initialized Jellyfin,
        main() must walk past the first-run guard and actually reach the music
        block — POSTing EnableInternetProviders=true for the music library and
        requesting the LrcLib install.

        The unit tests above prove those two functions do the right thing when
        *called*; this pins the wiring that calls them. The 401-forever race made
        jellyfin_run_first_setup report not-ready, so `if ready:` was False and
        the whole block (providers, LrcLib, DLNA, libraries, user access) was
        silently skipped on every redeploy — green tests, nothing enabled on the
        box."""
        m = load_script("media")
        import urllib.request
        m.JELLYFIN_READY_INTERVAL = 0
        provider_posts: list[dict] = []
        lrclib_installs: list[str] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            meth = req.get_method()
            if "/System/Info/Public" in url:
                # Redeploy: the wizard was completed on a previous install.
                return outer._resp(200, json.dumps({"StartupWizardCompleted": True}))
            if meth == "POST" and "/Users/AuthenticateByName" in url:
                return outer._resp(200, json.dumps({"AccessToken": "tok"}))
            if meth == "POST" and "/Library/VirtualFolders/LibraryOptions" in url:
                provider_posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            if meth == "GET" and "/Library/VirtualFolders" in url:
                return outer._resp(200, json.dumps([
                    {"Name": "Music", "ItemId": "id-music", "CollectionType": "music",
                     "LibraryOptions": {}},
                ]))
            if meth == "GET" and url.endswith("/Repositories"):
                return outer._resp(200, json.dumps([]))
            if meth == "POST" and "/Packages/Installed/" in url:
                lrclib_installs.append(url)
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        env = {
            "HOST": "10.0.0.5",
            "JELLYFIN_ADMIN_USER": "admin",
            "JELLYFIN_ADMIN_PASSWORD": "pw",
            # No media root on disk and no LLDAP password → library provisioning
            # and the LDAP wiring skip themselves; the music block must not.
            "JELLYFIN_MEDIA_PATH": "/nonexistent-media-root",
        }
        with mock.patch.object(urllib.request, "urlopen", urlopen), run_with_env(env):
            rc, out = capture_main(m)

        self.assertEqual(rc, 0)
        # The first-run guard short-circuited instead of walking the wizard.
        self.assertIn("startup wizard already completed", out)
        # Criterion: the music library got EnableInternetProviders=true.
        self.assertEqual(len(provider_posts), 1)
        self.assertEqual(provider_posts[0]["Id"], "id-music")
        self.assertTrue(provider_posts[0]["LibraryOptions"]["EnableInternetProviders"])
        # Criterion: the LrcLib install was requested.
        self.assertTrue(any(m.JELLYFIN_LRCLIB_PACKAGE in u for u in lrclib_installs))

    # ── #2369: built-in DLNA server enabled by default ────────────────────

    def test_jellyfin_dlna_server_installs_plugin_and_enables_server(self):
        """ensure_jellyfin_dlna_server requests the DLNA plugin install AND
        read-modify-writes the `dlna` named configuration to flip EnableServer
        on, preserving every other DLNA option (#2369)."""
        m = load_script("media")
        import urllib.request, json
        install_called: list[str] = []
        config_posts: list[dict] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            meth = req.get_method()
            if meth == "POST" and "/Packages/Installed/" in url:
                install_called.append(url)
                return outer._resp(204, "")
            if meth == "GET" and url.endswith("/System/Configuration/dlna"):
                # Existing DlnaOptions with a non-default field to prove RMW.
                return outer._resp(200, json.dumps(
                    {"EnableServer": False, "EnablePlayTo": True, "BlastAliveMessageIntervalSeconds": 30}))
            if meth == "POST" and url.endswith("/System/Configuration/dlna"):
                config_posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            ok = m.ensure_jellyfin_dlna_server("http://jf", "tok")

        self.assertTrue(ok)
        # The DLNA plugin install was requested.
        self.assertTrue(any(u.endswith("/Packages/Installed/DLNA") for u in install_called))
        # The config POST enabled the server and preserved the other options.
        self.assertEqual(len(config_posts), 1)
        self.assertTrue(config_posts[0]["EnableServer"])
        self.assertTrue(config_posts[0]["EnablePlayTo"])
        self.assertEqual(config_posts[0]["BlastAliveMessageIntervalSeconds"], 30)

    def test_jellyfin_dlna_server_idempotent(self):
        """Re-running posts the same EnableServer=true config (self-healing on
        every redeploy)."""
        m = load_script("media")
        import urllib.request, json
        config_posts: list[dict] = []
        outer = self

        def urlopen(req, *a, **k):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            meth = req.get_method()
            if meth == "GET" and url.endswith("/System/Configuration/dlna"):
                return outer._resp(200, json.dumps({"EnableServer": False}))
            if meth == "POST" and url.endswith("/System/Configuration/dlna"):
                config_posts.append(json.loads(req.data.decode()))
                return outer._resp(204, "")
            return outer._resp(204, "{}")

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            m.ensure_jellyfin_dlna_server("http://jf", "tok")
            m.ensure_jellyfin_dlna_server("http://jf", "tok")

        self.assertEqual(len(config_posts), 2)
        self.assertEqual(config_posts[0], config_posts[1])
        self.assertTrue(config_posts[0]["EnableServer"])

    def test_jellyfin_dlna_server_failsoft(self):
        """If the DLNA config can't be read (endpoint absent / unreachable),
        log-and-continue: returns False, never raises (the deploy must not be
        blocked by a DLNA hiccup)."""
        m = load_script("media")
        import urllib.request
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen_factory({})):
            ok = m.ensure_jellyfin_dlna_server("http://jf", "tok")  # must not raise
        self.assertFalse(ok)


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
            # serverHost is the LOOPBACK since template v7 (#2416): port 3001
            # speaks the raw zwave-js protocol with no auth, and this pod is
            # hostNetwork, so 0.0.0.0 handed every LAN device direct control of
            # the mesh. HA is in the same pod and uses ws://localhost:3001.
            self.assertEqual(data, {"serverEnabled": True, "serverPort": 3001, "serverHost": "127.0.0.1"})

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

    def test_repins_wildcard_ws_host_on_a_pre_v7_install(self):
        """#2416: the seeder only writes sb-external-settings.json when it is
        MISSING, so every pre-v7 install already has one saying 0.0.0.0 and
        would keep port 3001 LAN-reachable forever. An existing file carrying
        a wildcard bind must be re-pinned in place (the migration does it once
        at the hop; this is the every-deploy convergence for a restored
        backup). A DELIBERATE non-wildcard address is left alone."""
        import tempfile

        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            zwave_dir = os.path.join(tmp, "home-assistant", "zwave-js")
            os.makedirs(zwave_dir, exist_ok=True)
            path = os.path.join(zwave_dir, "sb-external-settings.json")
            with open(path, "w") as fh:
                json.dump({"serverEnabled": True, "serverPort": 3001, "serverHost": "0.0.0.0"}, fh)

            with run_with_env({"DATA_DIR": tmp}):
                changed = m.ensure_zwave_external_settings()
            # True → the caller restarts zwave-js so the new bind takes effect
            # on this deploy rather than at the next reboot.
            self.assertTrue(changed)
            with open(path) as fh:
                self.assertEqual(json.load(fh)["serverHost"], "127.0.0.1")

            # Idempotent: a second pass finds it pinned and writes nothing.
            with run_with_env({"DATA_DIR": tmp}):
                self.assertFalse(m.ensure_zwave_external_settings())

            # Operator-chosen address survives (warned, not overridden).
            with open(path, "w") as fh:
                json.dump({"serverEnabled": True, "serverPort": 3001, "serverHost": "10.1.2.3"}, fh)
            with run_with_env({"DATA_DIR": tmp}):
                self.assertFalse(m.ensure_zwave_external_settings())
            with open(path) as fh:
                self.assertEqual(json.load(fh)["serverHost"], "10.1.2.3")

    def test_skips_external_settings_when_ui_serverport_already_set(self):
        """If settings.json already has a `zwave.serverPort`, the operator
        chose it via the UI — don't override silently. The loopback bind is
        still merged in, because in that install shape settings.json is what
        governs the WS server and the UI has no field for its bind address
        (#2416)."""
        import tempfile
        import urllib.error
        import urllib.request

        m = load_script("home-assistant")

        with tempfile.TemporaryDirectory() as tmp:
            zwave_dir = os.path.join(tmp, "home-assistant", "zwave-js")
            os.makedirs(zwave_dir, exist_ok=True)
            settings_path = os.path.join(zwave_dir, "settings.json")
            with open(settings_path, "w") as fh:
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
            with open(settings_path) as fh:
                stored = json.load(fh)
            # The operator's port is untouched; only the bind address is pinned.
            self.assertEqual(stored["zwave"]["serverPort"], 8888)
            self.assertEqual(stored["zwave"]["serverHost"], "127.0.0.1")

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

    # ── UI-config reset guard (#2444) ────────────────────────────────────────

    @staticmethod
    def _run_guard(m):
        """Run guard_ha_include_reset() capturing stdout → (regressed, log)."""
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            regressed = m.guard_ha_include_reset()
        finally:
            sys.stdout = old
        return regressed, buf.getvalue()

    @staticmethod
    def _read_snapshot(cfg):
        with open(os.path.join(cfg, ".sb_include_snapshot.json")) as fh:
            return json.load(fh)

    @staticmethod
    def _seed_ha_config(tmp, files):
        cfg = os.path.join(tmp, "home-assistant", "homeassistant")
        os.makedirs(cfg, exist_ok=True)
        for name, body in files.items():
            with open(os.path.join(cfg, name), "w") as fh:
                fh.write(body)
        return cfg

    def test_include_reset_guard_fires_when_a_populated_file_comes_back_empty(self):
        """#2444: simulate the incident — deploy 1 sees 11 real automations,
        the redeploy comes back with HA's empty `[]` default. The guard must
        say so loudly and stamp lastRegression for the diagnose probe."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = self._seed_ha_config(tmp, {
                "automations.yaml": "".join(f"- id: '{i}'\n  alias: real {i}\n" for i in range(11)),
                "scripts.yaml": "{}\n",
                "scenes.yaml": "[]\n",
            })
            with run_with_env({"DATA_DIR": tmp}):
                # Deploy 1: baseline, nothing to compare against yet.
                regressed, log1 = self._run_guard(m)
                self.assertEqual(regressed, [])
                self.assertEqual(log1, "")

                # HA's bootstrap rewrites the file during the restart.
                with open(os.path.join(cfg, "automations.yaml"), "w") as fh:
                    fh.write("[]\n")

                # Deploy 2: the guard compares against deploy 1's record.
                regressed, log2 = self._run_guard(m)

            self.assertEqual(regressed, ["automations.yaml"])
            self.assertIn("Home Assistant config reset detected", log2)
            self.assertIn("automations.yaml", log2)
            self.assertIn("ServiceBay did not empty them", log2)
            # scripts/scenes were empty at deploy 1 too → not false-flagged.
            self.assertNotIn("scripts.yaml", log2)
            self.assertNotIn("scenes.yaml", log2)

            snap = self._read_snapshot(cfg)
            self.assertEqual(snap["lastRegression"]["files"], ["automations.yaml"])
            self.assertFalse(snap["lastRegression"]["previous"]["automations.yaml"]["empty"])
            # The baseline advances, so the next deploy compares against reality.
            self.assertTrue(snap["files"]["automations.yaml"]["empty"])

    def test_include_reset_guard_silent_on_a_normal_redeploy(self):
        """A redeploy that leaves the files alone (or grows them) must not
        warn — and once the file is restored the lastRegression stamp clears,
        which is how the diagnose row self-clears."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = self._seed_ha_config(tmp, {
                "automations.yaml": "- id: '1'\n  alias: morning\n",
                "scripts.yaml": "# only a comment\n{}\n",
                "scenes.yaml": "[]\n",
            })
            with run_with_env({"DATA_DIR": tmp}):
                self._run_guard(m)                       # deploy 1: baseline
                regressed, log = self._run_guard(m)      # deploy 2: unchanged
                self.assertEqual(regressed, [])
                self.assertEqual(log, "")

                # Operator adds an automation → still no alarm.
                with open(os.path.join(cfg, "automations.yaml"), "a") as fh:
                    fh.write("- id: '2'\n  alias: evening\n")
                regressed, log = self._run_guard(m)
                self.assertEqual(regressed, [])
                self.assertEqual(log, "")

                # Reset, then recovery: the stamp appears, then goes away.
                with open(os.path.join(cfg, "automations.yaml"), "w") as fh:
                    fh.write("[]\n")
                self._run_guard(m)
                self.assertIn("lastRegression", self._read_snapshot(cfg))

                with open(os.path.join(cfg, "automations.yaml"), "w") as fh:
                    fh.write("- id: '1'\n  alias: restored\n")
                regressed, log = self._run_guard(m)
                self.assertEqual(regressed, [])
                self.assertNotIn("lastRegression", self._read_snapshot(cfg))

    def test_include_reset_guard_no_ha_data_is_a_no_op(self):
        """No HA config dir (never installed) → no snapshot, no output."""
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            with run_with_env({"DATA_DIR": tmp}):
                regressed, log = self._run_guard(m)
            self.assertEqual(regressed, [])
            self.assertEqual(log, "")

    def test_yaml_is_effectively_empty_classification(self):
        """The emptiness rule must treat HA's seeds + comment-only files as
        empty, and any real entry as content — no YAML parser on the host."""
        m = load_script("home-assistant")
        for body in ("", "\n", "[]", "{}\n", "---\n[]\n", "# seeded by ServiceBay\n[]\n", "null\n"):
            self.assertTrue(m._yaml_is_effectively_empty(body), body)
        for body in ("- id: '1'\n", "morning:\n  sequence: []\n", "# c\n- alias: x\n"):
            self.assertFalse(m._yaml_is_effectively_empty(body), body)


class HomeAssistantHttpTrustedProxies(unittest.TestCase):
    """#2573 — Home Assistant 2026.8 moved the `http:` integration out of
    configuration.yaml into its own store, and raises a permanent repair issue
    ("HTTP YAML configuration is ignored after migration") for as long as an
    `http:` block is left in the YAML. ServiceBay used to re-render that block
    on every deploy, so the operator could never make the warning stay gone.

    The replacement has to hold two things at once: a FRESH install still ends
    up with a working trust list (HA's defaults reject proxied requests
    outright), and an ALREADY-MIGRATED install keeps whatever it migrated."""

    TOKEN = "long-lived-tok"

    def _cfg_dir(self, tmp, token=TOKEN):
        cfg = os.path.join(tmp, "home-assistant", "homeassistant")
        os.makedirs(cfg, exist_ok=True)
        if token is not None:
            with open(os.path.join(cfg, ".solaris-long-lived-token"), "w") as fh:
                fh.write(token + "\n")
        return cfg

    @staticmethod
    def _store(stable, pending=None, active="stable"):
        """One `http/config` result envelope, shaped like HA's."""
        return {
            "success": True,
            "result": {"stable": stable, "pending": pending, "active_config_type": active},
        }

    @staticmethod
    def _default_stable():
        """What HA stores for an install that never configured HTTP: proxied
        requests are rejected, because `use_x_forwarded_for` is off and the
        trust list is empty."""
        return {
            "server_port": 8123,
            "cors_allowed_origins": [],
            "login_attempts_threshold": -1,
            "ip_ban_enabled": True,
            "ssl_profile": "modern",
            "use_x_frame_options": True,
            "created_at": "2026-08-17T10:00:00+00:00",
            "error": None,
            "error_message": None,
        }

    def _fake_ws(self, calls, responses):
        """Record every websocket command and answer from `responses`, keyed by
        command type. An unstubbed type is a test bug, not a silent pass."""
        def fake(_token, commands, timeout=30):
            kind = commands[0]["type"]
            calls.append(commands[0])
            if kind not in responses:
                raise AssertionError(f"unexpected websocket command {kind}")
            return [responses[kind]]
        return fake

    # ── criterion 1: the block is gone from what we render ────────────────
    def test_rendered_configuration_yaml_carries_no_http_block(self):
        """The seed template must not reintroduce the block on a fresh install
        — that is what re-armed HA's repair issue every deploy."""
        body = (TEMPLATES_DIR / "home-assistant" / "configuration.yaml.mustache").read_text()
        # Comments may (and do) explain where the setting went; only what HA
        # actually parses counts.
        yaml_lines = [ln for ln in body.splitlines() if not ln.lstrip().startswith("#")]
        for line in yaml_lines:
            self.assertFalse(
                line.startswith("http:"),
                f"configuration.yaml.mustache still renders a top-level http: block: {line!r}",
            )
        self.assertNotIn("trusted_proxies", "\n".join(yaml_lines))
        self.assertNotIn("use_x_forwarded_for", "\n".join(yaml_lines))
        # …and it says where the setting went, so the next reader isn't puzzled.
        self.assertIn("http/config/configure", body)

    # ── criterion 2: a fresh install still ends up trusted ────────────────
    def test_fresh_install_writes_the_trust_list_into_has_own_store(self):
        import tempfile
        m = load_script("home-assistant")
        calls = []
        responses = {
            "http/config": self._store(self._default_stable()),
            "http/config/configure": {"success": True, "result": {"restart": True}},
            "http/config/promote": {"success": True, "result": None},
        }
        with tempfile.TemporaryDirectory() as tmp:
            self._cfg_dir(tmp)
            with run_with_env({"DATA_DIR": tmp}), \
                    mock.patch.object(m, "_ha_ws_commands", self._fake_ws(calls, responses)), \
                    mock.patch.object(m, "_wait_ha_ready", lambda *_a, **_kw: True):
                verdict = m.ensure_http_trusted_proxies()

        self.assertEqual(verdict, "ok")
        configure = next(c for c in calls if c["type"] == "http/config/configure")
        sent = configure["config"]
        self.assertIs(sent["use_x_forwarded_for"], True)
        # Loopback + every RFC1918 range, in the network form HA requires.
        self.assertEqual(
            set(sent["trusted_proxies"]),
            {"127.0.0.1/32", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"},
        )
        # HA applies a new HTTP config as a 5-minute trial that reverts itself
        # unless it is promoted — so the promote is not optional.
        self.assertIn("http/config/promote", [c["type"] for c in calls])

    def test_a_config_that_is_never_promoted_is_reported_as_failed(self):
        """An unpromoted trial silently auto-reverts. Reporting "ok" there
        would hand back a box whose trust list disappears five minutes later."""
        import tempfile
        m = load_script("home-assistant")
        calls = []
        responses = {
            "http/config": self._store(self._default_stable()),
            "http/config/configure": {"success": True, "result": {"restart": True}},
            "http/config/promote": {"success": False, "error": {"code": "not_allowed"}},
        }
        with tempfile.TemporaryDirectory() as tmp:
            self._cfg_dir(tmp)
            with run_with_env({"DATA_DIR": tmp}), \
                    mock.patch.object(m, "_ha_ws_commands", self._fake_ws(calls, responses)), \
                    mock.patch.object(m, "_wait_ha_ready", lambda *_a, **_kw: True):
                verdict = m.ensure_http_trusted_proxies()
        self.assertEqual(verdict, "failed")

    # ── criterion 3 + 5: an already-migrated install is left alone ────────
    def test_already_trusted_store_is_left_untouched_on_every_later_deploy(self):
        """The steady state. No configure, no promote, no HA restart — which is
        what makes the fix survive the next deploy instead of fighting it."""
        import tempfile
        m = load_script("home-assistant")
        calls = []
        stable = dict(
            self._default_stable(),
            use_x_forwarded_for=True,
            # HA stores what the operator typed in canonical network form.
            trusted_proxies=["127.0.0.1/32", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
        )
        responses = {"http/config": self._store(stable)}
        with tempfile.TemporaryDirectory() as tmp:
            self._cfg_dir(tmp)
            with run_with_env({"DATA_DIR": tmp}), \
                    mock.patch.object(m, "_ha_ws_commands", self._fake_ws(calls, responses)):
                verdict = m.ensure_http_trusted_proxies()
        self.assertEqual(verdict, "ok")
        self.assertEqual([c["type"] for c in calls], ["http/config"])

    def test_ha_s_own_yaml_import_is_promoted_rather_than_overwritten(self):
        """The real box: HA imported the old `http:` block into the PENDING
        slot on this very start and is counting down to an auto-revert.
        Confirming what it imported preserves the operator's migrated values
        exactly, and costs one restart fewer than writing a second config."""
        import tempfile
        m = load_script("home-assistant")
        calls = []
        imported = dict(
            self._default_stable(),
            use_x_forwarded_for=True,
            trusted_proxies=["127.0.0.1/32", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
        )
        responses = {
            "http/config": self._store(self._default_stable(), pending=imported, active="pending"),
            "http/config/promote": {"success": True, "result": None},
        }
        with tempfile.TemporaryDirectory() as tmp:
            self._cfg_dir(tmp)
            with run_with_env({"DATA_DIR": tmp}), \
                    mock.patch.object(m, "_ha_ws_commands", self._fake_ws(calls, responses)):
                verdict = m.ensure_http_trusted_proxies()
        self.assertEqual(verdict, "ok")
        self.assertEqual([c["type"] for c in calls], ["http/config", "http/config/promote"])

    def test_operator_settings_survive_and_their_own_proxies_are_kept(self):
        """We add to the operator's stored config, never replace it: their port,
        SSL paths and extra proxy stay, and HA's own bookkeeping keys are
        stripped (HTTP_STORAGE_SCHEMA rejects unknown keys)."""
        m = load_script("home-assistant")
        stable = dict(
            self._default_stable(),
            server_port=8124,
            ssl_certificate="/ssl/fullchain.pem",
            cors_allowed_origins=["https://example.com"],
            trusted_proxies=["172.30.0.0/16"],
        )
        desired = m._desired_http_config(stable)
        self.assertEqual(desired["server_port"], 8124)
        self.assertEqual(desired["ssl_certificate"], "/ssl/fullchain.pem")
        self.assertEqual(desired["cors_allowed_origins"], ["https://example.com"])
        self.assertIn("172.30.0.0/16", desired["trusted_proxies"])
        self.assertIn("10.0.0.0/8", desired["trusted_proxies"])
        for meta in ("created_at", "error", "error_message"):
            self.assertNotIn(meta, desired)

    def test_host_and_network_proxy_forms_compare_equal(self):
        """`127.0.0.1` and `127.0.0.1/32` are the same trust entry; HA stores
        the second. Without normalising, every deploy would rewrite the config
        and restart HA in a loop."""
        m = load_script("home-assistant")
        self.assertTrue(m._http_config_trusts_proxies({
            "use_x_forwarded_for": True,
            "trusted_proxies": ["127.0.0.1", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
        }))
        # Trusting the proxy range but not reading the header is still broken:
        # HA would report the proxy's own address as the client.
        self.assertFalse(m._http_config_trusts_proxies({
            "use_x_forwarded_for": False,
            "trusted_proxies": ["127.0.0.1/32", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
        }))
        self.assertFalse(m._http_config_trusts_proxies({
            "use_x_forwarded_for": True,
            "trusted_proxies": ["192.168.0.0/16"],
        }))

    # ── criterion 1 + 4: what happens to the YAML block on disk ───────────
    def test_block_is_removed_only_once_the_store_is_confirmed(self):
        """Ordering is the safety property: strip the YAML only after HA's own
        store is known to carry the trust list, never before."""
        import tempfile
        m = load_script("home-assistant")
        legacy = (
            "default_config:\n"
            "\n"
            "# Reverse-proxy trust list. NPM forwards X-Forwarded-For.\n"
            "http:\n"
            "  use_x_forwarded_for: true\n"
            "  trusted_proxies:\n"
            "    - 127.0.0.1\n"
            "\n"
            "auth_oidc:\n"
            "  client_id: homeassistant\n"
        )
        for verdict, expect_removed in (("ok", True), ("failed", False), ("skipped", False)):
            with tempfile.TemporaryDirectory() as tmp:
                cfg = self._cfg_dir(tmp)
                cfg_file = os.path.join(cfg, "configuration.yaml")
                with open(cfg_file, "w") as fh:
                    fh.write(legacy)
                with run_with_env({"DATA_DIR": tmp}), \
                        mock.patch.object(m, "ensure_http_trusted_proxies", lambda: verdict):
                    m.configure_http_trusted_proxies()
                with open(cfg_file) as fh:
                    content = fh.read()
                if expect_removed:
                    self.assertNotIn("http:", content, verdict)
                    self.assertNotIn("trusted_proxies", content, verdict)
                else:
                    self.assertIn("http:", content, verdict)

    def test_removing_the_block_keeps_the_rest_of_the_file_and_backs_it_up(self):
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = os.path.join(tmp, "configuration.yaml")
            original = (
                "default_config:\n"
                "\n"
                "automation: !include automations.yaml\n"
                "\n"
                "# Reverse-proxy trust list, explained over\n"
                "# two comment lines.\n"
                "http:\n"
                "  use_x_forwarded_for: true\n"
                "  trusted_proxies:\n"
                "    - 127.0.0.1\n"
                "    - 10.0.0.0/8\n"
                "\n"
                "auth_oidc:\n"
                "  client_id: homeassistant\n"
            )
            with open(cfg_file, "w") as fh:
                fh.write(original)

            self.assertTrue(m.remove_legacy_http_yaml_block(cfg_file))
            with open(cfg_file) as fh:
                    content = fh.read()
            self.assertNotIn("http:", content)
            self.assertNotIn("trusted_proxies", content)
            self.assertNotIn("two comment lines", content)   # the block's own comment went with it
            self.assertIn("default_config:", content)
            self.assertIn("automation: !include automations.yaml", content)
            self.assertIn("auth_oidc:", content)
            self.assertIn("  client_id: homeassistant", content)
            # The operator may have had their own settings under that key.
            with open(cfg_file + ".pre-http-migration.bak") as fh:
                self.assertEqual(fh.read(), original)

            # Idempotent: nothing left to remove, and the backup is not
            # overwritten with the already-stripped file.
            self.assertFalse(m.remove_legacy_http_yaml_block(cfg_file))
            with open(cfg_file + ".pre-http-migration.bak") as fh:
                self.assertEqual(fh.read(), original)

    def test_a_key_that_merely_starts_with_http_is_not_touched(self):
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = os.path.join(tmp, "configuration.yaml")
            body = "http_response_sensor:\n  resource: http://x\nhttpx:\n  a: b\n"
            with open(cfg_file, "w") as fh:
                fh.write(body)
            self.assertFalse(m.remove_legacy_http_yaml_block(cfg_file))
            with open(cfg_file) as fh:
                self.assertEqual(fh.read(), body)

    def test_pre_2026_8_home_assistant_keeps_its_yaml_block(self):
        """An older HA has no store to write to — there the YAML block is still
        the only place the trust list can live, so it is re-added, not
        removed. Only a running HA can tell us which era the box is on, which
        is why this moved out of the pre-start hook."""
        import tempfile
        m = load_script("home-assistant")
        calls = []
        responses = {"http/config": {"success": False, "error": {"code": "unknown_command"}}}
        with tempfile.TemporaryDirectory() as tmp:
            cfg = self._cfg_dir(tmp)
            cfg_file = os.path.join(cfg, "configuration.yaml")
            with open(cfg_file, "w") as fh:
                fh.write("default_config:\n")
            with run_with_env({"DATA_DIR": tmp}), \
                    mock.patch.object(m, "_ha_ws_commands", self._fake_ws(calls, responses)):
                m.configure_http_trusted_proxies()
            with open(cfg_file) as fh:
                    content = fh.read()
        self.assertIn("http:", content)
        self.assertIn("use_x_forwarded_for: true", content)
        self.assertIn("- 10.0.0.0/8", content)

    def test_no_admin_token_explains_the_manual_step_instead_of_failing_silently(self):
        import tempfile
        m = load_script("home-assistant")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = self._cfg_dir(tmp, token=None)
            cfg_file = os.path.join(cfg, "configuration.yaml")
            with open(cfg_file, "w") as fh:
                fh.write("default_config:\n\nhttp:\n  use_x_forwarded_for: true\n")
            buf = io.StringIO()
            with run_with_env({"DATA_DIR": tmp}), contextlib.redirect_stdout(buf):
                m.configure_http_trusted_proxies()
            out = buf.getvalue()
            # The existing block is the only working copy — leave it alone.
            with open(cfg_file) as fh:
                self.assertIn("http:", fh.read())
        self.assertIn("Settings", out)
        self.assertIn("Trust X-Forwarded-For", out)


class HomeAssistantAuthOidcTarball(unittest.TestCase):
    """#2453: the auth_oidc release tarball is fetched over the network and
    unpacked as root. Extraction must not be able to write outside the staging
    dir, and the artifact must be checked against a pinned hash *before* it is
    unpacked — otherwise a compromised upstream release (or a MITM) is a
    root-level arbitrary-write primitive."""

    PREFIX = "hass-oidc-auth-1.1.0"

    @staticmethod
    def _make_tarball(path: str, entries: dict[str, str]) -> None:
        """Write a .tar.gz with the member names given VERBATIM — `tf.add()`
        would normalise a `../` path away, which is exactly the payload we
        need to keep, so each member is an explicit TarInfo."""
        import tarfile as tar_mod
        with tar_mod.open(path, "w:gz") as tf:
            for name, body in entries.items():
                data = body.encode("utf-8")
                info = tar_mod.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))

    @contextlib.contextmanager
    def _staging_under(self, parent: str):
        """Pin the script's mkdtemp into `parent` so a `../` payload has a
        known resolved destination we can assert never appears."""
        import tempfile as tmp_mod
        os.makedirs(parent, exist_ok=True)
        real = tmp_mod.mkdtemp
        with mock.patch.object(tmp_mod, "mkdtemp", lambda *a, **kw: real(*a, **{**kw, "dir": parent})):
            yield

    def test_safe_member_target_rejects_escapes(self):
        """The containment check itself, over the shapes a hostile archive
        can produce once the top-level dir is stripped."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as staging:
            for rel in ("../pwned", "../../etc/cron.d/pwned", "a/../../pwned",
                        "/etc/cron.d/pwned", "/tmp/pwned"):
                self.assertIsNone(m._safe_member_target(staging, rel), rel)
            root = os.path.realpath(staging)
            self.assertEqual(m._safe_member_target(staging, ""), root)
            self.assertEqual(m._safe_member_target(staging, "a/b.py"), os.path.join(root, "a/b.py"))
            # `..` that stays inside is fine — only escaping is rejected.
            self.assertEqual(m._safe_member_target(staging, "a/../b.py"), os.path.join(root, "b.py"))

    def test_extract_rejects_relative_traversal_entry(self):
        """Hostile payload: a real tarball carrying `../pwned.py` inside
        custom_components/auth_oidc/. Extraction must abort, and the escaped
        path must not exist afterwards."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tar_path = os.path.join(tmp, "release.tar.gz")
            parent = os.path.join(tmp, "stage")
            target = os.path.join(tmp, "auth_oidc")
            self._make_tarball(tar_path, {
                f"{self.PREFIX}/custom_components/auth_oidc/__init__.py": "legit\n",
                f"{self.PREFIX}/custom_components/auth_oidc/../pwned.py": "os.system('id')\n",
            })
            with self._staging_under(parent):
                with self.assertRaises(tarfile.TarError) as ctx:
                    m._extract_auth_oidc(tar_path, target)
            self.assertIn("escapes the staging dir", str(ctx.exception))
            self.assertFalse(os.path.exists(os.path.join(parent, "pwned.py")))
            # Aborted, not half-installed.
            self.assertFalse(os.path.exists(target))
            self.assertEqual(os.listdir(parent), [])

    def test_extract_rejects_absolute_path_entry(self):
        """The other shape: an absolute member path, which `os.path.join`
        would have honoured wholesale (join(staging, '/x') == '/x')."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tar_path = os.path.join(tmp, "release.tar.gz")
            target = os.path.join(tmp, "auth_oidc")
            absolute_victim = os.path.join(tmp, "victim.py")
            self._make_tarball(tar_path, {
                f"{self.PREFIX}/custom_components/auth_oidc/__init__.py": "legit\n",
                f"{self.PREFIX}/custom_components/auth_oidc/{absolute_victim}": "pwned\n",
            })
            with self.assertRaises(tarfile.TarError):
                m._extract_auth_oidc(tar_path, target)
            self.assertFalse(os.path.exists(absolute_victim))
            self.assertFalse(os.path.exists(target))

    def test_extract_installs_a_legitimate_tarball(self):
        """The benign case still works: the top-level dir is unwrapped, the
        auth_oidc subtree lands in target_dir, everything else is skipped."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tar_path = os.path.join(tmp, "release.tar.gz")
            target = os.path.join(tmp, "auth_oidc")
            self._make_tarball(tar_path, {
                f"{self.PREFIX}/README.md": "not part of the component\n",
                f"{self.PREFIX}/custom_components/auth_oidc/__init__.py": "component\n",
                f"{self.PREFIX}/custom_components/auth_oidc/manifest.json": '{"domain": "auth_oidc"}\n',
                f"{self.PREFIX}/custom_components/auth_oidc/views/welcome.py": "view\n",
            })
            m._extract_auth_oidc(tar_path, target)
            with open(os.path.join(target, "__init__.py")) as fh:
                self.assertEqual(fh.read(), "component\n")
            with open(os.path.join(target, "views", "welcome.py")) as fh:
                self.assertEqual(fh.read(), "view\n")
            self.assertTrue(os.path.isfile(os.path.join(target, "manifest.json")))
            self.assertFalse(os.path.exists(os.path.join(target, "README.md")))

    # ── pinned-digest verification ────────────────────────────────────────

    def _install_with_fake_download(self, m, tmp, tar_path, env_extra):
        """Run install_auth_oidc with urlretrieve serving `tar_path`. Returns
        (result, stdout, download_count)."""
        import shutil as shutil_mod
        calls = []

        def fake_urlretrieve(url, dest):
            calls.append(url)
            shutil_mod.copyfile(tar_path, dest)
            return dest, None

        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            with run_with_env({"DATA_DIR": tmp, **env_extra}):
                with mock.patch.object(m.urllib.request, "urlretrieve", fake_urlretrieve):
                    result = m.install_auth_oidc(env_extra.get("HA_OIDC_AUTH_VERSION", "v1.1.0"))
        finally:
            sys.stdout = old
        return result, buf.getvalue(), len(calls)

    @staticmethod
    def _sha256_of(path: str) -> str:
        import hashlib
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            h.update(fh.read())
        return h.hexdigest()

    def test_install_rejects_tarball_whose_digest_does_not_match_the_pin(self):
        """A swapped artifact (compromised release / MITM) must be refused
        before extraction — nothing lands in the config dir."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tar_path = os.path.join(tmp, "release.tar.gz")
            self._make_tarball(tar_path, {
                f"{self.PREFIX}/custom_components/auth_oidc/__init__.py": "swapped\n",
            })
            result, out, downloads = self._install_with_fake_download(
                m, tmp, tar_path,
                {"HA_OIDC_AUTH_SHA256": "0" * 64, "HA_OIDC_AUTH_VERSION": "v1.1.0"},
            )
            self.assertFalse(result)
            self.assertIn("sha256 mismatch", out)
            self.assertEqual(downloads, 1)
            self.assertFalse(os.path.exists(
                os.path.join(tmp, "home-assistant", "homeassistant", "custom_components", "auth_oidc")))

    def test_install_refuses_a_version_with_no_pinned_digest(self):
        """An unpinned version is never even downloaded — no unverified
        artifact gets unpacked as root."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tar_path = os.path.join(tmp, "release.tar.gz")
            self._make_tarball(tar_path, {
                f"{self.PREFIX}/custom_components/auth_oidc/__init__.py": "x\n",
            })
            result, out, downloads = self._install_with_fake_download(
                m, tmp, tar_path, {"HA_OIDC_AUTH_VERSION": "v9.9.9-unpinned"},
            )
            self.assertFalse(result)
            self.assertEqual(downloads, 0)
            self.assertIn("No pinned SHA-256", out)
            self.assertIn("HA_OIDC_AUTH_SHA256", out)

    def test_install_accepts_a_tarball_matching_the_pin(self):
        """Happy path: digest matches → component installed + version stamped."""
        m = load_script("home-assistant")
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tar_path = os.path.join(tmp, "release.tar.gz")
            self._make_tarball(tar_path, {
                f"{self.PREFIX}/custom_components/auth_oidc/__init__.py": "component\n",
            })
            result, _out, downloads = self._install_with_fake_download(
                m, tmp, tar_path,
                {"HA_OIDC_AUTH_SHA256": self._sha256_of(tar_path), "HA_OIDC_AUTH_VERSION": "v1.1.0"},
            )
            self.assertTrue(result)
            self.assertEqual(downloads, 1)
            installed = os.path.join(tmp, "home-assistant", "homeassistant",
                                     "custom_components", "auth_oidc")
            with open(os.path.join(installed, "__init__.py")) as fh:
                self.assertEqual(fh.read(), "component\n")
            with open(os.path.join(installed, ".sb_installed_version")) as fh:
                self.assertEqual(fh.read().strip(), "v1.1.0")

    def test_default_version_digest_is_pinned_in_the_script(self):
        """The shipped default must not depend on an operator-supplied digest
        — variables.json's HA_OIDC_AUTH_VERSION default needs a pin."""
        m = load_script("home-assistant")
        with open(TEMPLATES_DIR / "home-assistant" / "variables.json") as fh:
            declared = json.load(fh)
        default_version = declared["HA_OIDC_AUTH_VERSION"]["default"]
        self.assertIn(default_version, m.HA_OIDC_RELEASE_SHA256)
        self.assertRegex(m.HA_OIDC_RELEASE_SHA256[default_version], r"^[0-9a-f]{64}$")


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



class MosquittoScript(unittest.TestCase):
    """#2569 — the broker's credentials are auto-generated and mandatory
    (anonymous access is off), so this script is the ONLY place the operator
    ever sees them. It also has to answer "which host do I enter?", which has
    two different right answers depending on who is connecting."""

    def test_emits_broker_credential_and_both_addresses(self):
        m = load_script("mosquitto")
        env = {
            "HOST": "servicebay.example",
            "LAN_IP": "192.168.1.10",
            "MQTT_PORT": "1883",
            "MQTT_USERNAME": "mqtt-user",
            "MQTT_PASSWORD": "br0ker-p4ss",
        }
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        self.assertEqual(len(creds), 1)
        self.assertEqual(creds[0]["service"], "MQTT Broker (Mosquitto)")
        self.assertEqual(creds[0]["username"], "mqtt-user")
        self.assertEqual(creds[0]["password"], "br0ker-p4ss")
        self.assertEqual(creds[0]["url"], "mqtt://192.168.1.10:1883")
        self.assertEqual(creds[0]["importance"], "critical")

        # Devices connect to the LAN address; on-box containers use
        # host.containers.internal (ADR 0007 Decision 3) — never a hardcoded
        # IP for the container path, never `localhost` (that's the container).
        self.assertIn("192.168.1.10", out)
        self.assertIn("host.containers.internal", out)

        # The password must NOT leak into user-visible log lines — it travels
        # only via the __SB_CREDENTIAL__ marker, which ServiceBay stores
        # encrypted (#321).
        log_only = "\n".join(
            line for line in out.splitlines()
            if not line.startswith("__SB_CREDENTIAL__ ")
        )
        self.assertNotIn("br0ker-p4ss", log_only)

    def test_falls_back_to_host_when_lan_ip_unknown(self):
        m = load_script("mosquitto")
        env = {"HOST": "servicebay.example", "MQTT_USERNAME": "u", "MQTT_PASSWORD": "p"}
        with run_with_env(env):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        creds = parse_credentials(out)
        self.assertEqual(creds[0]["url"], "mqtt://servicebay.example:1883")

    def test_missing_credentials_explains_instead_of_emitting_nothing(self):
        """The initContainer refuses to start an anonymous broker, so a blank
        credential is a hard failure — say why in the install log rather than
        leaving the operator to read pod logs."""
        m = load_script("mosquitto")
        with run_with_env({"HOST": "h"}):
            rc, out = capture_main(m)
        self.assertEqual(rc, 0)
        self.assertEqual(parse_credentials(out), [])
        self.assertIn("MQTT_USERNAME/MQTT_PASSWORD missing", out)


class MosquittoHomeAssistantLink(unittest.TestCase):
    """#2578 — installing mosquitto next to Home Assistant used to leave the
    operator typing broker/port/user/password into HA by hand, and a later
    password rotation (#2574) silently broke that hand-entered connection.

    The wiring goes through HA's config-flow REST API — the same endpoints HA's
    own frontend posts to — and never through `.storage`, which a running HA
    holds in memory and rewrites on its own schedule.

    The four acceptance criteria pull in different directions, so each has its
    own tests: wire it up unasked, follow a rotation, stay silent without HA,
    and never touch a connection the operator made themselves."""

    TOKEN = "ha-admin-token"
    ENTRY_ID = "01ENTRY0000000000000000000"
    USERNAME = "mqtt-user"
    PASSWORD = "s3cret-broker-pass"
    PWD_SENTINEL = "__**password_not_changed**__"

    def _box(self, tmp, with_ha=True, token=TOKEN):
        """Lay DATA_DIR out the way a real box has it, and return the env the
        install runner would hand this script."""
        os.makedirs(os.path.join(tmp, "mosquitto"), exist_ok=True)
        if with_ha:
            cfg = os.path.join(tmp, "home-assistant", "homeassistant")
            os.makedirs(cfg, exist_ok=True)
            if token is not None:
                with open(os.path.join(cfg, ".solaris-long-lived-token"), "w") as fh:
                    fh.write(token + "\n")
        return {
            "DATA_DIR": tmp,
            "HOST": "box.example",
            "LAN_IP": "192.168.1.10",
            "MQTT_PORT": "1883",
            "MQTT_USERNAME": self.USERNAME,
            "MQTT_PASSWORD": self.PASSWORD,
        }

    def _http(self, calls, routes):
        """Fake urlopen over HA's REST API. `routes` maps "METHOD /path-prefix"
        to (status, body); the longest matching prefix wins so the flow-resource
        route beats the flow-index one. An unrouted call is a test bug, not a
        silent pass — that is how we assert "nothing was written"."""
        class FakeResponse:
            def __init__(self, status, body):
                self.status = status
                self._body = json.dumps(body if body is not None else {}).encode("utf-8")

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        ordered = sorted(routes.items(), key=lambda kv: -len(kv[0]))

        def fake(req, *_a, **_kw):
            method = req.get_method()
            path = req.full_url.split("127.0.0.1:8123", 1)[1]
            calls.append({
                "method": method,
                "path": path,
                "body": json.loads(req.data.decode("utf-8")) if req.data else None,
                "auth": req.headers.get("Authorization"),
            })
            for key, response in ordered:
                route_method, _, prefix = key.partition(" ")
                if method == route_method and path.startswith(prefix):
                    if callable(response):
                        response = response(len(calls))
                    return FakeResponse(response[0], response[1])
            raise AssertionError(f"unexpected {method} {path}")

        return fake

    # ── fixtures shaped like the forms HA 2026.8.2 actually returns ────────
    #
    # Captured from a live Home Assistant, not invented: `broker` is required
    # with no default at all, the advanced settings sit in a required section,
    # and two fields inside it are required with neither default nor suggestion
    # — which is exactly what a hand-written payload gets wrong.

    def _fresh_form(self, flow_id="flow-new"):
        return {
            "type": "form",
            "flow_id": flow_id,
            "handler": "mqtt",
            "step_id": "broker",
            "data_schema": [
                {"name": "broker", "required": True, "selector": {"text": {}}},
                {"name": "port", "type": "integer", "required": True, "default": 1883},
                {"name": "protocol", "required": True, "default": "5"},
                {"name": "username", "required": False, "optional": True},
                {"name": "password", "required": False, "optional": True},
                {
                    "type": "expandable",
                    "name": "other_settings",
                    "required": True,
                    "schema": [
                        {"name": "client_id", "required": False, "optional": True},
                        {"name": "keepalive", "required": False, "optional": True},
                        {"name": "set_client_cert", "required": True},
                        {"name": "set_ca_cert", "required": True},
                        {"name": "transport", "required": True, "default": "tcp"},
                    ],
                },
            ],
        }

    def _reconfigure_form(self, flow_id="flow-reconf"):
        """A reconfigure form carries the entry's current values back as
        `suggested_value` — including HA's password sentinel, never the real
        password."""
        return {
            "type": "form",
            "flow_id": flow_id,
            "handler": "mqtt",
            "step_id": "broker",
            "data_schema": [
                {"name": "broker", "required": True,
                 "description": {"suggested_value": "host.containers.internal"}},
                {"name": "port", "type": "integer", "required": True, "default": 1883,
                 "description": {"suggested_value": 1883}},
                {"name": "protocol", "required": True, "default": "5",
                 "description": {"suggested_value": "3.1.1"}},
                {"name": "username", "required": False, "optional": True,
                 "description": {"suggested_value": "old-user"}},
                {"name": "password", "required": False, "optional": True,
                 "description": {"suggested_value": self.PWD_SENTINEL}},
                {
                    "type": "expandable",
                    "name": "other_settings",
                    "required": True,
                    "schema": [
                        {"name": "keepalive", "required": False, "optional": True,
                         "description": {"suggested_value": 90}},
                        {"name": "set_client_cert", "required": True,
                         "description": {"suggested_value": True}},
                        {"name": "set_ca_cert", "required": True,
                         "description": {"suggested_value": "custom"}},
                        {"name": "transport", "required": True, "default": "tcp",
                         "description": {"suggested_value": "websockets"}},
                    ],
                },
            ],
        }

    def _entry(self, entry_id=None, title="host.containers.internal", state="loaded"):
        return {
            "entry_id": entry_id or self.ENTRY_ID,
            "domain": "mqtt",
            "title": title,
            "source": "user",
            "state": state,
            "supports_reconfigure": True,
        }

    def _diagnostics(self, broker="host.containers.internal", port=1883, connected=True):
        """HA's own diagnostics for an MQTT entry. Username and password come
        back redacted — we never need them, which is the point."""
        return {
            "home_assistant": {"version": "2026.8.2"},
            "data": {
                "connected": connected,
                "mqtt_config": {
                    "data": {
                        "broker": broker,
                        "port": port,
                        "username": "**REDACTED**",
                        "password": "**REDACTED**",
                    },
                    "options": {},
                },
            },
        }

    def _link(self, tmp):
        with open(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")) as fh:
            return json.load(fh)

    # ── criterion 1: mosquitto onto a box that already has HA ──────────────

    def test_a_box_with_home_assistant_gets_mqtt_wired_up_with_no_manual_step(self):
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (200, []),
                "POST /api/config/config_entries/flow": (200, self._fresh_form()),
                "POST /api/config/config_entries/flow/": (
                    200, {"type": "create_entry", "result": self._entry()},
                ),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)

            submit = [c for c in calls
                      if c["method"] == "POST" and c["path"].startswith("/api/config/config_entries/flow/")]
            self.assertEqual(len(submit), 1, "the broker form is answered exactly once")
            payload = submit[0]["body"]
            # ADR 0007 Decision 3 — the container-to-container name, never a LAN IP.
            self.assertEqual(payload["broker"], "host.containers.internal")
            self.assertEqual(payload["port"], 1883)
            self.assertEqual(payload["username"], self.USERNAME)
            self.assertEqual(payload["password"], self.PASSWORD)
            # …and the parts of HA's form we did not come to change are answered
            # from HA's own defaults, including the required section that has none.
            self.assertEqual(payload["protocol"], "5")
            self.assertEqual(payload["other_settings"]["transport"], "tcp")
            self.assertEqual(payload["other_settings"]["set_ca_cert"], "off")
            self.assertIs(payload["other_settings"]["set_client_cert"], False)

            self.assertEqual(self._link(tmp)["entry_id"], self.ENTRY_ID)
            self.assertIn("Home Assistant is now connected to this broker", out)

    def test_every_call_is_home_assistants_own_api_and_never_its_storage(self):
        """The ticket's central ask: the way into HA's configuration must be
        justified as safe. It is safe because nothing here knows the file
        format — every write is a form post HA validates itself."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (200, []),
                "POST /api/config/config_entries/flow": (200, self._fresh_form()),
                "POST /api/config/config_entries/flow/": (
                    200, {"type": "create_entry", "result": self._entry()},
                ),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                capture_main(m)
            for call in calls:
                self.assertTrue(
                    call["path"].startswith("/api/config/config_entries/")
                    or call["path"].startswith("/api/diagnostics/"),
                    f"unexpected endpoint {call['path']}",
                )
                self.assertEqual(call["auth"], f"Bearer {self.TOKEN}")
            # Nothing was written anywhere inside HA's config dir.
            ha_dir = os.path.join(tmp, "home-assistant", "homeassistant")
            self.assertEqual(sorted(os.listdir(ha_dir)), [".solaris-long-lived-token"])

    # ── criterion 2: a password rotation is carried over ───────────────────

    def test_rotating_the_broker_password_updates_home_assistants_entry(self):
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            # What the previous deploy left behind: our entry, wired with the
            # OLD password.
            with open(os.path.join(tmp, "mosquitto", ".home-assistant-link.json"), "w") as fh:
                json.dump({
                    "entry_id": self.ENTRY_ID,
                    "fingerprint": m._fingerprint("host.containers.internal", 1883, self.USERNAME, "old-pass"),
                }, fh)
            routes = {
                "GET /api/config/config_entries/entry": (200, [self._entry()]),
                "POST /api/config/config_entries/flow": (200, self._reconfigure_form()),
                "POST /api/config/config_entries/flow/": (
                    200, {"type": "abort", "reason": "reconfigure_successful"},
                ),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)

            start = [c for c in calls if c["path"] == "/api/config/config_entries/flow"]
            self.assertEqual(len(start), 1)
            # A reconfigure, not a second entry: HA is told which entry to edit.
            self.assertEqual(start[0]["body"]["entry_id"], self.ENTRY_ID)

            payload = [c for c in calls if c["path"].startswith("/api/config/config_entries/flow/")][0]["body"]
            self.assertEqual(payload["password"], self.PASSWORD)
            self.assertNotEqual(payload["password"], self.PWD_SENTINEL)
            self.assertEqual(payload["username"], self.USERNAME)
            # Everything the operator set on that entry survives the update —
            # this is a credential change, not a reset to our defaults.
            self.assertEqual(payload["protocol"], "3.1.1")
            self.assertEqual(payload["other_settings"]["keepalive"], 90)
            self.assertEqual(payload["other_settings"]["transport"], "websockets")
            self.assertEqual(payload["other_settings"]["set_ca_cert"], "custom")
            self.assertIs(payload["other_settings"]["set_client_cert"], True)

            self.assertEqual(
                self._link(tmp)["fingerprint"],
                m._fingerprint("host.containers.internal", 1883, self.USERNAME, self.PASSWORD),
            )
            self.assertIn("updated to the current credentials", out)

    def test_a_deploy_that_changes_nothing_touches_home_assistant_not_at_all(self):
        """The steady state. Reconfiguring on every deploy would reload HA's
        MQTT integration — and every device with it — for no reason."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            with open(os.path.join(tmp, "mosquitto", ".home-assistant-link.json"), "w") as fh:
                json.dump({
                    "entry_id": self.ENTRY_ID,
                    "fingerprint": m._fingerprint(
                        "host.containers.internal", 1883, self.USERNAME, self.PASSWORD),
                }, fh)
            routes = {"GET /api/config/config_entries/entry": (200, [self._entry()])}
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertEqual([c["method"] for c in calls], ["GET"])
            self.assertIn("already up to date", out)

    # ── criterion 3: a box without Home Assistant, unchanged and unmentioned ──

    def test_a_box_without_home_assistant_says_and_does_nothing(self):
        """"Ohne Home Assistant läuft die Installation unverändert und ohne
        Meldung durch" — no HTTP call, and not one line about a service the
        operator never installed."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp, with_ha=False)
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, {})
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertEqual(calls, [])
            for phrase in ("no admin token", "left alone", "left exactly as it is",
                           "now connected to this broker", "⚠️"):
                self.assertNotIn(phrase, out)
            self.assertEqual(parse_credentials(out)[0]["password"], self.PASSWORD)

    def test_home_assistant_without_a_token_asks_for_the_manual_step_and_exits_clean(self):
        """Both installed in one wizard run: HA's own post-deploy mints the
        token and may not have run yet. That is a "later", not a failure."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp, token=None)
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, {})
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertEqual(calls, [])
            self.assertIn("no admin token", out)
            self.assertIn("Settings → Devices & Services", out)
            self.assertNotIn("⚠️", out)

    def test_an_unreachable_home_assistant_never_fails_the_deploy(self):
        import tempfile
        import urllib.error
        m = load_script("mosquitto")
        m.HA_READY_ATTEMPTS = 2
        m.HA_READY_INTERVAL = 0
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)

            def refused(*_a, **_kw):
                raise urllib.error.URLError("connection refused")

            with run_with_env(env), mock.patch.object(m.urllib.request, "urlopen", refused):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("left alone", out)
            self.assertFalse(os.path.exists(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")))

    # ── criterion 4: an existing hand-made connection is left alone ─────────

    def test_a_hand_made_connection_to_a_different_broker_is_left_untouched(self):
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (
                    200, [self._entry(entry_id="OTHER", title="192.168.1.55")],
                ),
                "GET /api/diagnostics/config_entry/": (
                    200, self._diagnostics(broker="192.168.1.55"),
                ),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            # Not one write: no flow started, so nothing duplicated and nothing
            # overwritten. `single_config_entry` on HA's side would have refused
            # a second entry anyway — we do not even ask.
            self.assertEqual([c["method"] for c in calls], ["GET", "GET"])
            self.assertNotIn("/flow", "".join(c["path"] for c in calls))
            self.assertIn("left exactly as it is", out)
            self.assertFalse(os.path.exists(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")))

    def test_a_hand_made_connection_that_is_live_against_this_broker_is_recognised_not_rewritten(self):
        """The case on a box that was wired by hand before this shipped. HA's
        diagnostics say the entry is connected to this very broker — and the
        broker accepts exactly one account, so it is already using these
        credentials. Recording it writes NOTHING into HA today and means the
        next rotation follows it instead of silently breaking it."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (200, [self._entry()]),
                "GET /api/diagnostics/config_entry/": (200, self._diagnostics()),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertEqual([c["method"] for c in calls], ["GET", "GET"])
            self.assertEqual(self._link(tmp), {
                "entry_id": self.ENTRY_ID,
                "fingerprint": m._fingerprint(
                    "host.containers.internal", 1883, self.USERNAME, self.PASSWORD),
            })
            self.assertIn("you set it up yourself", out)

    def test_a_hand_made_connection_that_is_not_connected_is_not_claimed(self):
        """Without a live connection there is no evidence it is this broker's
        account, so the conservative branch wins: leave it, claim nothing."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (
                    200, [self._entry(state="setup_retry")],
                ),
                "GET /api/diagnostics/config_entry/": (200, self._diagnostics(connected=False)),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertNotIn("/flow", "".join(c["path"] for c in calls))
            self.assertFalse(os.path.exists(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")))
            self.assertIn("left exactly as it is", out)

    def test_a_connection_on_the_right_host_but_a_different_port_is_not_ours(self):
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (200, [self._entry()]),
                "GET /api/diagnostics/config_entry/": (200, self._diagnostics(port=1884)),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, _ = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")))

    # ── failure handling: HA says no ────────────────────────────────────────

    def test_a_refused_broker_form_closes_the_flow_and_leaves_no_link(self):
        """HA opens a real connection to the broker before accepting the
        settings. A rejection comes back as the same form with errors — leaving
        it open would park a half-finished "Configure" prompt in HA's UI."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            refused = dict(self._fresh_form(), errors={"base": "cannot_connect"})
            routes = {
                "GET /api/config/config_entries/entry": (200, []),
                "POST /api/config/config_entries/flow": (200, self._fresh_form()),
                "POST /api/config/config_entries/flow/": (200, refused),
                "DELETE /api/config/config_entries/flow/": (200, {"message": "Flow aborted"}),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0, "the broker is up; the wiring never fails the deploy")
            self.assertIn("DELETE", [c["method"] for c in calls])
            self.assertIn("cannot_connect", out)
            self.assertFalse(os.path.exists(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")))

    def test_an_unexpected_error_is_reported_without_failing_the_deploy(self):
        import tempfile
        m = load_script("mosquitto")
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            with run_with_env(env), mock.patch.object(
                m, "configure_home_assistant", side_effect=RuntimeError("boom")
            ):
                rc, out = capture_main(m)
            self.assertEqual(rc, 0)
            self.assertIn("boom", out)
            self.assertIn("broker itself is fine", out)

    # ── secret hygiene ─────────────────────────────────────────────────────

    def test_the_password_never_reaches_the_log_or_the_link_file(self):
        """It travels in exactly two places: the __SB_CREDENTIAL__ marker
        ServiceBay stores encrypted, and the form body HA gets over loopback."""
        import tempfile
        m = load_script("mosquitto")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            env = self._box(tmp)
            routes = {
                "GET /api/config/config_entries/entry": (200, []),
                "POST /api/config/config_entries/flow": (200, self._fresh_form()),
                "POST /api/config/config_entries/flow/": (
                    200, {"type": "create_entry", "result": self._entry()},
                ),
            }
            with run_with_env(env), mock.patch.object(
                m.urllib.request, "urlopen", self._http(calls, routes)
            ):
                _, out = capture_main(m)
            log_only = "\n".join(
                line for line in out.splitlines() if not line.startswith("__SB_CREDENTIAL__ ")
            )
            self.assertNotIn(self.PASSWORD, log_only)
            with open(os.path.join(tmp, "mosquitto", ".home-assistant-link.json")) as fh:
                raw_link = fh.read()
            self.assertNotIn(self.PASSWORD, raw_link)
            self.assertNotIn(self.USERNAME, raw_link)

    def test_the_fingerprint_changes_with_the_password_and_is_short(self):
        m = load_script("mosquitto")
        one = m._fingerprint("host.containers.internal", 1883, "u", "pass-a")
        two = m._fingerprint("host.containers.internal", 1883, "u", "pass-b")
        self.assertNotEqual(one, two)
        self.assertEqual(m._fingerprint("host.containers.internal", 1883, "u", "pass-a"), one)
        # Truncated on purpose: enough to notice a change, too short to be a
        # usable handle on the password it came from.
        self.assertEqual(len(one), 16)

    # ── the form filler, which is where a hand-written payload goes wrong ───

    def test_the_form_is_answered_from_home_assistants_own_schema(self):
        m = load_script("mosquitto")
        payload = m._form_payload(
            self._fresh_form()["data_schema"],
            {"broker": "b", "port": 1883, "username": "u", "password": "p"},
        )
        # The required section is sent even though everything we know about it
        # comes from defaults — HA rejects the form outright when it is missing.
        self.assertIn("other_settings", payload)
        self.assertEqual(payload["other_settings"]["set_ca_cert"], "off")
        # Optional fields HA did not suggest a value for are left out rather
        # than sent as null: `PREVENT_EXTRA`/None would fail validation.
        self.assertNotIn("client_id", payload["other_settings"])
        self.assertNotIn("keepalive", payload["other_settings"])

    def test_an_unknown_future_field_is_answered_from_its_own_default(self):
        """The payload is not pinned to one HA version: a field this script has
        never heard of is answered with what HA itself proposes."""
        m = load_script("mosquitto")
        schema = [
            {"name": "broker", "required": True},
            {"name": "some_new_thing", "required": True, "default": "sane"},
            {"name": "another_new_thing", "required": True,
             "description": {"suggested_value": "current"}},
        ]
        payload = m._form_payload(schema, {"broker": "host.containers.internal"})
        self.assertEqual(payload, {
            "broker": "host.containers.internal",
            "some_new_thing": "sane",
            "another_new_thing": "current",
        })


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


class VerbatimScriptBodies(unittest.TestCase):
    """#2415 — post-deploy.py bodies are no longer Mustache-rendered.

    Every `{{…}}` left in a first-party script is either prose (a
    docstring/comment naming the template.yml placeholder) or a Python
    f-string brace escape. None of them was ever a value-delivery
    mechanism: the values arrive through the process environment
    (`postDeployEnv` in packages/backend/src/lib/install/runner.ts).
    These cases pin that down site by site, so a future author can't
    quietly start depending on a render pass that no longer happens.
    """

    # The nine `{{…}}` sites across templates/*/post-deploy.py, and the
    # env var that actually carries the value (None = prose only).
    SITES = [
        ("auth", "DATA_DIR"),            # authelia_db_path() docstring
        ("auth", "DATA_DIR"),            # authelia_config_path() docstring (#2424)
        ("auth", None),                  # f-string escape: subject "[Authelia] {title}"
        ("nginx", "DATA_DIR"),           # npm_db_path() docstring
        ("file-share", "DATA_DIR"),      # _notes_dir() docstring
        ("home-assistant", "DATA_DIR"),  # _ha_config_dir() docstring
        ("home-assistant", "ZWAVE_DEVICE"),  # udev/zwave.port docstring
        ("mosquitto", "DATA_DIR"),       # _ha_config_dir() comment (#2578)
        ("immich", None),                # comment: podman --format '{{.State}}'
    ]

    def test_all_sites_are_accounted_for(self):
        """Guard the inventory: if a new `{{…}}` appears in a post-deploy
        script, this fails until someone confirms it doesn't need a render."""
        found = []
        for script in sorted(TEMPLATES_DIR.glob("*/post-deploy.py")):
            text = script.read_text(encoding="utf-8")
            found.extend([script.parent.name] * text.count("{{"))
        self.assertEqual(
            sorted(found),
            sorted(name for name, _ in self.SITES),
            "post-deploy.py `{{…}}` inventory changed — confirm the new site "
            "reads its value from os.environ, then update SITES.",
        )

    def test_data_dir_paths_resolve_from_the_environment(self):
        """The DATA_DIR docstring sites: the path helper next to each
        docstring reads DATA_DIR from os.environ, with a sane default."""
        cases = [
            ("auth", "authelia_db_path", ("auth", "authelia-data", "db.sqlite3")),
            ("auth", "authelia_config_path", ("auth", "authelia-config", "configuration.yml")),
            ("nginx", "npm_db_path", ("nginx-proxy-manager", "data", "database.sqlite")),
            ("file-share", "_notes_dir", ("file-share", "data", "notes")),
            ("home-assistant", "_ha_config_dir", ("home-assistant", "homeassistant")),
            ("mosquitto", "_ha_config_dir", ("home-assistant", "homeassistant")),
        ]
        for template, fn_name, tail in cases:
            with self.subTest(template=template):
                m = load_script(template)
                fn = getattr(m, fn_name)
                with run_with_env({"DATA_DIR": "/srv/from-env"}):
                    self.assertEqual(fn(), os.path.join("/srv/from-env", *tail))
                # Unset → documented fallback, never an empty path.
                with run_with_env({}):
                    self.assertEqual(fn(), os.path.join("/mnt/data", *tail))

    def test_zwave_device_resolves_from_the_environment(self):
        """home-assistant's `{{ZWAVE_DEVICE}}` docstring names the
        template.yml mount; the script itself reads the value from env."""
        m = load_script("home-assistant")
        with run_with_env({"ZWAVE_DEVICE": "/dev/ttyACM0"}):
            self.assertEqual(m.env("ZWAVE_DEVICE"), "/dev/ttyACM0")
        with run_with_env({}):
            self.assertEqual(m.env("ZWAVE_DEVICE"), "")

    def test_authelia_smtp_subject_keeps_its_title_placeholder(self):
        """The one site the render pass actively BROKE: `{{title}}` is an
        f-string escape producing Authelia's own `{title}` token. Mustache
        deleted it, deploying `subject: "[Authelia] "`."""
        m = load_script("auth")
        block = m._smtp_notifier_block({
            "host": "smtp.gmail.com",
            "port": 587,
            "secure": False,
            "user": "me@example.com",
            "pass": "p",
            "from": "me@example.com",
        })
        self.assertIn('subject: "[Authelia] {title}"', block)
        self.assertNotIn('subject: "[Authelia] "', block)

    def test_go_template_format_strings_survive_in_a_script_body(self):
        """The mdopp/solarisbay#1092 shape, asserted on the Python side:
        a script may embed a podman/docker Go-template format string and
        it must still be there when the file is read for execution."""
        sample = "'{{.Image}}|{{index .Config.Labels \"org.opencontainers.image.revision\"}}'"
        # Compiles as valid Python source with the tags intact (the runner
        # ships exactly these bytes; see runner.test.ts for the transport).
        compile(f"FMT = {sample}\n", "<sample>", "exec")
        scope: dict[str, Any] = {}
        exec(f"FMT = {sample}\n", scope)  # noqa: S102 - fixed literal
        self.assertIn("{{.Image}}", scope["FMT"])
        self.assertNotEqual(scope["FMT"].strip("'"), "|")


class BeetsScript(unittest.TestCase):
    """#2581 — beets post-deploy never imports; it makes the decision informed.

    The property under test is the config warning: an operator carrying a
    config over from an earlier install commonly has `import: move: yes`, and
    with that set ANY import relocates and renames their whole music library.
    The script must never rewrite that config, but it must never let it pass
    unremarked either.
    """

    HEALTH_OK = {"/api/health/checks": {"status": 200, "body": {"ok": True}}}

    def _run(self, config_text: str | None) -> tuple[int, str]:
        import tempfile

        module = load_script("beets")
        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "beets" / "config"
            cfg_dir.mkdir(parents=True)
            if config_text is not None:
                (cfg_dir / "config.yaml").write_text(config_text, encoding="utf-8")
            env = {
                "DATA_DIR": tmp,
                "BEETS_PORT": "8337",
                "BEETS_COVERAGE_PORT": "8338",
                "SB_API_URL": "http://localhost:3000",
                "SB_API_TOKEN": "t",
            }
            with run_with_env(env), mock.patch(
                "urllib.request.urlopen", fake_urlopen_factory(self.HEALTH_OK)
            ):
                rc, out = capture_main(module)
            # The script must never write or alter the config.
            after = (cfg_dir / "config.yaml").read_text(encoding="utf-8") if config_text is not None else None
            self.assertEqual(after, config_text, "post-deploy must not touch config.yaml")
        return rc, out

    def test_warns_when_a_carried_over_config_will_relocate_files(self):
        rc, out = self._run(
            "directory: /music\n"
            "import:\n"
            "  move: yes\n"
            "  write: yes\n"
            "paths:\n"
            "  default: $artist/$album/$track $title\n"
        )
        self.assertEqual(rc, 0)
        self.assertIn("RELOCATE YOUR MUSIC", out)
        self.assertIn("move: yes", out)

    def test_quiet_when_the_config_writes_tags_in_place(self):
        rc, out = self._run(
            "directory: /music\nimport:\n  copy: false\n  move: false\n  write: true\n"
        )
        self.assertEqual(rc, 0)
        self.assertIn("in place", out)
        self.assertNotIn("RELOCATE YOUR MUSIC", out)

    def test_move_under_another_top_level_key_is_not_a_false_positive(self):
        # Only the `import:` block decides whether files get relocated — a
        # `move` key belonging to some other plugin must not trip the warning.
        rc, out = self._run(
            "import:\n  move: false\n"
            "somepluginn:\n  move: yes\n"
        )
        self.assertEqual(rc, 0)
        self.assertNotIn("RELOCATE YOUR MUSIC", out)

    def test_missing_config_is_not_an_error(self):
        rc, out = self._run(None)
        self.assertEqual(rc, 0)
        self.assertIn("seeds one on start", out)

    def test_registers_the_coverage_check_and_prints_the_trigger(self):
        rc, out = self._run("import:\n  move: false\n")
        self.assertEqual(rc, 0)
        self.assertIn("Beets library coverage", out)
        # The service must be genuinely operable: the command is in the log.
        self.assertIn("beet import /music", out)
        self.assertIn("beet import -q -i /music", out)

    def test_the_registered_check_asks_about_coverage_not_existence(self):
        """#2584 — the payload, not just the log line.

        The old check was `"items"\\s*:\\s*[1-9]` against beets' /stats: green
        at one item, forever. The replacement asserts a status code from the
        coverage endpoint, and it keeps the same check id so an upgraded box
        has its stale row rewritten instead of gaining a green twin.
        """
        import tempfile
        import urllib.error

        posted: list[dict[str, Any]] = []

        def capture(req, *_a, **_kw):
            posted.append(json.loads(req.data.decode("utf-8")))
            raise urllib.error.URLError("registration response is not the point")

        module = load_script("beets")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "beets" / "config").mkdir(parents=True)
            env = {"DATA_DIR": tmp, "BEETS_PORT": "8337", "BEETS_COVERAGE_PORT": "9338"}
            with run_with_env(env), mock.patch("urllib.request.urlopen", capture):
                rc, _out = capture_main(module)
        self.assertEqual(rc, 0)
        self.assertEqual(len(posted), 1)
        check = posted[0]
        self.assertEqual(check["id"], "beets-library-populated")
        self.assertEqual(check["target"], "http://127.0.0.1:9338/coverage")
        self.assertEqual(check["httpConfig"].get("expectedStatus"), 200)
        # No body regex at all — a ratio is not expressible as one, and a
        # baked-in item floor is the threshold that ages into a lie.
        self.assertNotIn("bodyMatch", check["httpConfig"])
        self.assertNotIn("bodyMatchType", check["httpConfig"])

    def test_health_check_registration_failure_is_not_fatal(self):
        module = load_script("beets")
        import tempfile
        import urllib.error

        def boom(*_a, **_kw):
            raise urllib.error.URLError("down")

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "beets" / "config").mkdir(parents=True)
            with run_with_env({"DATA_DIR": tmp, "BEETS_PORT": "8337"}), mock.patch(
                "urllib.request.urlopen", boom
            ):
                rc, out = capture_main(module)
        self.assertEqual(rc, 0)
        self.assertIn("service:beets check still applies", out)


class BeetsCoverageEndpoint(unittest.TestCase):
    """#2584 — the coverage sidecar embedded in templates/beets/template.yml.

    The script lives in a heredoc inside the pod spec (beets ships no
    `*.mustache` companion — that would clobber the operator's config on every
    redeploy, see template_consistency.test.ts), so the test extracts it and
    exercises it directly. What is under test is the property the issue is
    about: the verdict must depend on the RATIO, so it cannot go green on a
    library holding one album out of thousands, and it must not need
    re-tuning when the collection grows.
    """

    @classmethod
    def setUpClass(cls):
        import re
        import textwrap

        raw = (TEMPLATES_DIR / "beets" / "template.yml").read_text(encoding="utf-8")
        match = re.search(r"<<'PY'\n(.*?)\n\s*PY\n", raw, re.DOTALL)
        assert match, "beets template.yml must embed the coverage script in a PY heredoc"
        cls.source = textwrap.dedent(match.group(1))

    def _module(self):
        """A fresh instance of the extracted script (module state is global)."""
        spec = importlib.util.spec_from_loader("_beets_coverage", loader=None)
        assert spec is not None
        module = importlib.util.module_from_spec(spec)
        exec(compile(self.source, "beets-coverage.py", "exec"), module.__dict__)  # noqa: S102
        return module

    @contextlib.contextmanager
    def _library(self, files: int, items: int, floor: str = "90"):
        """A music tree with `files` audio files and a beets library of `items`."""
        import tempfile

        module = self._module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Artist" / "Album"
            root.mkdir(parents=True)
            for i in range(files):
                (root / f"{i:05d}.mp3").write_text("", encoding="utf-8")
            module.MUSIC_DIR = str(tmp)
            module.library_items = lambda: items
            with run_with_env({"SB_COVERAGE_MIN_PERCENT": floor}):
                module._state["files"] = module.count_audio_files(str(tmp))
                module._state["scanned_at"] = 1.0
                yield module

    def test_one_album_out_of_a_full_collection_is_not_healthy(self):
        # The exact defect: the old regex went green here.
        with self._library(files=200, items=1) as module:
            status, report = module.coverage_report()
        self.assertEqual(status, 503)
        self.assertEqual(report["status"], "behind")
        self.assertEqual(report["percent"], 0.5)
        self.assertIn("1 of 200", report["detail"])

    def test_a_covered_library_is_healthy(self):
        with self._library(files=200, items=195) as module:
            status, report = module.coverage_report()
        self.assertEqual(status, 200)
        self.assertEqual(report["status"], "ok")

    def test_the_floor_is_a_ratio_so_it_does_not_age(self):
        # Same proportion, ten times the collection: same verdict. A
        # hard-coded item floor would flip here, which is what #2584 forbids.
        verdicts = []
        for scale in (1, 10):
            with self._library(files=50 * scale, items=48 * scale) as module:
                verdicts.append(module.coverage_report()[0])
            with self._library(files=50 * scale, items=10 * scale) as module:
                verdicts.append(module.coverage_report()[0])
        self.assertEqual(verdicts, [200, 503, 200, 503])

    def test_syncthing_version_copies_do_not_inflate_the_denominator(self):
        with self._library(files=10, items=10) as module:
            versions = Path(module.MUSIC_DIR) / ".stversions" / "Artist"
            versions.mkdir(parents=True)
            for i in range(40):
                (versions / f"old-{i}.mp3").write_text("", encoding="utf-8")
            (Path(module.MUSIC_DIR) / "Artist" / "cover.jpg").write_text("", encoding="utf-8")
            self.assertEqual(module.count_audio_files(module.MUSIC_DIR), 10)

    def test_beets_not_answering_is_red_not_green(self):
        with self._library(files=10, items=10) as module:
            def boom():
                raise OSError("connection refused")

            module.library_items = boom
            status, report = module.coverage_report()
        self.assertEqual(status, 503)
        self.assertEqual(report["status"], "unknown")

    def test_the_first_scan_is_reported_as_scanning_never_as_ok(self):
        # Transient and bounded (one walk), so it must not flap the check red —
        # but it must not claim a coverage verdict it does not have either.
        with self._library(files=10, items=1) as module:
            module._state["files"] = None
            status, report = module.coverage_report()
        self.assertEqual(status, 200)
        self.assertEqual(report["status"], "scanning")
        self.assertNotIn("percent", report)

    def test_an_empty_music_folder_is_not_a_failure(self):
        with self._library(files=0, items=0) as module:
            status, report = module.coverage_report()
        self.assertEqual(status, 200)
        self.assertEqual(report["status"], "ok")


class BeetsV1ToV2Migration(unittest.TestCase):
    """#2581 — the v1→v2 migration re-owns /config and moves nothing."""

    def _load(self):
        path = TEMPLATES_DIR / "beets" / "migrations" / "v1-to-v2.py"
        spec = importlib.util.spec_from_file_location("_beets_v1_to_v2", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_noop_when_the_config_dir_is_already_owned_by_the_podman_user(self):
        import tempfile

        module = self._load()
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "beets" / "config"
            cfg.mkdir(parents=True)
            (cfg / "musiclibrary.db").write_bytes(b"db")
            with run_with_env({"DATA_DIR": tmp}), mock.patch(
                "subprocess.run", side_effect=AssertionError("must not shell out")
            ):
                rc, out = capture_main(module)
        self.assertEqual(rc, 0)
        self.assertIn("nothing to do", out)

    def test_noop_when_there_is_no_config_dir_at_all(self):
        import tempfile

        module = self._load()
        with tempfile.TemporaryDirectory() as tmp:
            with run_with_env({"DATA_DIR": tmp}):
                rc, out = capture_main(module)
        self.assertEqual(rc, 0)
        self.assertIn("nothing to re-own", out)

    def test_chowns_foreign_owned_entries_and_leaves_the_data_in_place(self):
        import subprocess
        import tempfile

        module = self._load()
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "beets" / "config"
            cfg.mkdir(parents=True)
            db = cfg / "musiclibrary.db"
            db.write_bytes(b"library")
            calls: list[list[str]] = []

            def fake_run(cmd, **_kw):
                calls.append(list(cmd))
                return subprocess.CompletedProcess(cmd, 0, "", "")

            # Report the db as owned by a container sub-UID on the first scan
            # and as re-owned on the verification scan.
            scans = iter([[str(db)], []])
            with run_with_env({"DATA_DIR": tmp}), mock.patch.object(
                module, "foreign_owned_entries", lambda *_a: next(scans)
            ), mock.patch("subprocess.run", fake_run):
                rc, out = capture_main(module)

        self.assertEqual(rc, 0)
        self.assertEqual(calls, [["podman", "unshare", "chown", "-R", "0:0", str(cfg)]])
        self.assertIn("No file is moved or deleted", out)

    def test_a_failed_chown_warns_but_never_aborts_the_deploy(self):
        import subprocess
        import tempfile

        module = self._load()
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "beets" / "config"
            cfg.mkdir(parents=True)
            (cfg / "musiclibrary.db").write_bytes(b"library")
            with run_with_env({"DATA_DIR": tmp}), mock.patch.object(
                module, "foreign_owned_entries", lambda *_a: [str(cfg / "musiclibrary.db")]
            ), mock.patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, "", "chown: denied"),
            ):
                rc, out = capture_main(module)
        # Migrations are fail-fast by contract, but a permissions fixup is not
        # a half-completed data migration — it must not strand the operator.
        self.assertEqual(rc, 0)
        self.assertIn("podman unshare chown -R 0:0", out)


if __name__ == "__main__":
    unittest.main()
