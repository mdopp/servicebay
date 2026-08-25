#!/usr/bin/env python3
"""
post-deploy hook for the `adguard` stack.

What this replaces (was hardcoded in src/lib/stackInstall/postInstall.ts):
  - logAdguardCredentials  → `__SB_CREDENTIAL__` for AdGuard admin

AdGuard's first-start config is pre-seeded by the wizard's mustache step
(AdGuardHome.yaml.mustache lives in this directory). The bcrypt password
hash is computed server-side via /api/system/keys/bcrypt and baked into
that config. So this script has nothing to seed — it just surfaces the
credential the operator needs for their first login...

...plus, since #2632, it reconciles the two values ServiceBay still owns
inside that config. AdGuardHome.yaml is `servicebay.seed-only-configs`
now, so a deploy no longer re-renders it (the admin UI rewrites the whole
file itself and the seed would wipe the operator's filters, user rules and
DNS rewrites). See `reconcile_managed_config()` for what is still managed
and why.

See lib/registry.ts:getTemplatePostDeployScript for the script protocol.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ADGUARD_CONTAINER_NAME = "adguard-adguard-home"


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


# ── AdGuardHome.yaml managed-value reconcile (#2632) ─────────────────────────
#
# AdGuardHome.yaml is seed-only from #2632 on: ServiceBay writes it once and
# AdGuard owns it afterwards. That stops a redeploy from wiping the operator's
# filters / user rules / DHCP / DNS rewrites — and, on its own, would freeze
# the two values the file only ever received *because* it was re-rendered
# (the trap #2597 hit on Home Assistant's configuration.yaml):
#
#   * `http.address`'s PORT — ADGUARD_ADMIN_PORT. The NPM proxy host and the
#     template's healthcheck both address the admin UI on that port, so a
#     changed variable that never reaches AdGuard leaves the UI unreachable
#     and the health probe permanently red.
#   * the bcrypt hash of the `users:` entry named ADGUARD_ADMIN_USER.
#     ServiceBay generates the password, shows it in the install log, stores
#     it in Saved Credentials and logs in with it to provision the wildcard
#     DNS rewrites — so a rotated password has to reach AdGuard or all three
#     quietly become wrong.
#
# Everything else in the file is AdGuard's or the operator's. We rewrite only
# those two scalars, only when they actually differ (so an unchanged deploy
# leaves the file byte-identical and skips the restart), and we never create a
# `users:` entry that isn't there — one the operator renamed or deleted is
# reported, not re-invented.


def _adguard_conf_path() -> str:
    """Host-side path of AdGuard's /opt/adguardhome/conf volume. The pod mounts
    `{{DATA_DIR}}/adguard/conf`; DATA_DIR reaches us via the post-deploy env."""
    return os.path.join(env("DATA_DIR", "/mnt/data"), "adguard", "conf", "AdGuardHome.yaml")


def _scalar(raw: str) -> str:
    """The value part of a YAML `key: value` tail — trailing comment stripped
    (YAML only opens one after whitespace) and surrounding quotes removed."""
    match = re.search(r"\s+#.*$", raw)
    if match:
        raw = raw[:match.start()]
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1]
    return raw


def _rewrite_scalar_line(line: str, value: str) -> str:
    """`line` with its scalar replaced by `value`, keeping the indentation, key
    spelling, quoting style, trailing comment and line ending. Preserving the
    quotes matters for an IPv6 bind address, which is only valid YAML quoted."""
    body = line.rstrip("\r\n")
    ending = line[len(body):] or "\n"
    key, _, rest = body.partition(":")
    comment = ""
    match = re.search(r"\s+#.*$", rest)
    if match:
        rest, comment = rest[:match.start()], rest[match.start():]
    old = rest.strip()
    quote = old[0] if len(old) >= 2 and old[0] == old[-1] and old[0] in "\"'" else ""
    gap = rest[:len(rest) - len(rest.lstrip())] or " "
    return f"{key}:{gap}{quote}{value}{quote}{comment}{ending}"


def _top_level_block(lines: list[str], key: str) -> tuple[int, int] | None:
    """`(start, end)` line indices of the body of top-level `key:`, or None
    when the file has no such key. Comment and blank lines never close a
    block — only the next real top-level key does."""
    start = None
    for i, line in enumerate(lines):
        if start is None:
            if re.match(rf"^{re.escape(key)}\s*:", line):
                start = i + 1
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not line[0].isspace():
            return start, i
    return (start, len(lines)) if start is not None else None


def _reconcile_admin_port(lines: list[str], port: str) -> bool | None:
    """Point `http.address` at `port`, keeping its bind host. Returns True when
    a line was rewritten, False when it already matched, None when there is no
    `http.address` to reconcile. The host is deliberately NOT managed: binding
    is a choice the operator may have made on purpose."""
    span = _top_level_block(lines, "http")
    if span is None:
        return None
    for i in range(*span):
        if not re.match(r"^\s\saddress\s*:", lines[i]):
            continue
        current = _scalar(lines[i].split(":", 1)[1])
        bind_host, sep, current_port = current.rpartition(":")
        if current_port == port:
            return False
        lines[i] = _rewrite_scalar_line(lines[i], f"{bind_host}{sep}{port}")
        return True
    return None


def _reconcile_admin_password(lines: list[str], user: str, password_hash: str) -> bool | None:
    """Set the `password` of the `users:` entry named `user` to `password_hash`.
    Returns True when it was rewritten, False when it already matched, None
    when no entry carries that name — in which case we leave the list exactly
    as it is (the operator renamed or removed it; re-adding would be the very
    overwrite this change exists to stop)."""
    span = _top_level_block(lines, "users")
    if span is None:
        return None
    in_target = False
    for i in range(*span):
        name = re.match(r"^\s*-\s+name\s*:(.*)$", lines[i])
        if name:
            in_target = _scalar(name.group(1)) == user
            continue
        if not in_target:
            continue
        if not re.match(r"^\s*password\s*:", lines[i]):
            continue
        if _scalar(lines[i].split(":", 1)[1]) == password_hash:
            return False
        lines[i] = _rewrite_scalar_line(lines[i], password_hash)
        return True
    return None


def restart_adguard() -> bool:
    """Restart AdGuard so it reloads the config we just edited. AdGuard reads
    AdGuardHome.yaml at start and rewrites it from memory whenever a setting
    changes, so an edit that is not followed by a restart is not just inert —
    it is liable to be overwritten again."""
    try:
        result = subprocess.run(
            ["podman", "container", "restart", ADGUARD_CONTAINER_NAME],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0:
            return True
        log(f"   ⚠️ `podman container restart {ADGUARD_CONTAINER_NAME}` exited "
            f"{result.returncode}: {result.stderr.strip()}")
    except (subprocess.SubprocessError, OSError) as exc:
        log(f"   ⚠️ Could not restart AdGuard: {exc}")
    return False


def wait_for_admin_ui(port: str, timeout: float = 60.0) -> bool:
    """Poll the admin login page until it answers on `port`. This doubles as
    the proof that a port reconcile actually took: nothing served there means
    AdGuard did not come back on the port we asked for."""
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/login.html"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status < 500:
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                return True
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(2)
    return False


def reconcile_managed_config(user: str, port: str) -> None:
    """Bring the two ServiceBay-owned values in AdGuardHome.yaml back in step
    with this deploy, and restart AdGuard when either moved. Idempotent: a
    deploy that changes nothing leaves the file untouched and AdGuard running."""
    path = _adguard_conf_path()
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines(keepends=True)
    except OSError:
        # First install: the seed write lands before the pod starts, so a
        # missing file here means this deploy never got that far.
        log(f"   {path} not on disk yet — nothing to reconcile.")
        return

    managed: list[tuple[str, bool | None]] = [("http.address port", _reconcile_admin_port(lines, port))]
    # No hash this run (a manual/partial deploy) → don't touch the users list.
    # Writing an empty password would lock the operator out of their own box.
    password_hash = env("ADGUARD_ADMIN_PASSWORD_HASH")
    if password_hash:
        managed.append((f"password of user {user}", _reconcile_admin_password(lines, user, password_hash)))

    changed: list[str] = []
    missing: list[str] = []
    for key, outcome in managed:
        if outcome is None:
            missing.append(key)
        elif outcome:
            changed.append(key)

    if missing:
        log(f"   AdGuardHome.yaml has no {', '.join(missing)} — left as it is "
            f"(ServiceBay updates those values, it does not re-add what you removed).")
    if not changed:
        log("   AdGuardHome.yaml already matches this deploy — leaving it untouched.")
        return

    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
    except OSError as exc:
        log(f"   ⚠️ Could not update {path}: {exc}")
        return

    # Key NAMES only — never the password or its hash.
    log(f"   Updated {', '.join(changed)} in AdGuardHome.yaml from this deploy's settings.")
    if not restart_adguard():
        log(f"   The new values are on disk but AdGuard is still running the old ones. "
            f"Recover with: podman container restart {ADGUARD_CONTAINER_NAME}")
        return
    if wait_for_admin_ui(port):
        log(f"   AdGuard restarted and is serving the admin UI on :{port}.")
    else:
        log(f"   ⚠️ AdGuard restarted but nothing answers on :{port}. It rewrites "
            f"AdGuardHome.yaml from memory on shutdown, so it may have discarded the "
            f"edit — check {path} and restart AdGuard again if the values reverted.")


def main() -> int:
    host = env("HOST", "<server-ip>")
    user = env("ADGUARD_ADMIN_USER", "admin")
    password = env("ADGUARD_ADMIN_PASSWORD")
    port = env("ADGUARD_ADMIN_PORT", "8083")

    # Before anything else: AdGuardHome.yaml is seed-only (#2632), so this is
    # the only path by which a changed admin port or a rotated admin password
    # reaches an already-installed AdGuard. Runs even without a password in
    # the env, because the port half stands on its own.
    reconcile_managed_config(user, port)

    if not password:
        log("⚠️ ADGUARD_ADMIN_PASSWORD missing — first-login won't work; reset via the AdGuard Home setup wizard at http://<server-ip>:" + port)
        return 0

    log(f"✅ AdGuard admin saved (user: {user}) — open http://{host}:{port}. Password retrievable from Settings → Integrations → Saved credentials.")
    emit_credential(
        service="AdGuard Home",
        url=f"http://{host}:{port}",
        username=user,
        password=password,
        importance="critical",
        notes="DNS console. Add custom rewrites + manage blocklists.",
    )

    # Persist the admin credentials into ServiceBay's config so the
    # provisioner can pick them up later for DNS rewrites + the
    # FritzBox-DNS hand-off probe. Mirrors what nginx + lldap post-
    # deploys do. The endpoint also triggers provisionPortalRouting()
    # in the background, which installs the wildcard rewrites
    # (`*.<lan>`, `*.<public>`) the operator expects to land
    # automatically after install. See #341 + the AdGuard-rewrites
    # follow-up.
    sb_api = env("SB_API_URL", "http://localhost:3000")
    persist_status, _ = post_json(
        f"{sb_api}/api/system/adguard/credentials",
        {
            "adminUrl": f"http://localhost:{port}",
            "username": user,
            "password": password,
        },
        timeout=10,
    )
    if persist_status == 200:
        log("ServiceBay registered AdGuard credentials — wildcard DNS rewrites will be provisioned.")
    else:
        log(f"⚠️ Could not register AdGuard credentials with ServiceBay (HTTP {persist_status}). Wildcard rewrites won't auto-install; add them manually in AdGuard if subdomains don't resolve.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
