#!/usr/bin/env python3
"""
post-deploy hook for the `media` stack (Jellyfin).

Convention (see lib/registry.ts:getTemplatePostDeployScript):
  - Runs on the agent host after `systemctl --user start media.service`
    succeeds.
  - All wizard variables are exported as env vars
    (`os.environ['JELLYFIN_PORT']` etc.). `SB_NODE` is the node name.
    `HOST` is the operator's browsing hostname (set by the wizard from
    window.location).
  - stdout is relayed to the install log line by line.
  - Lines starting with `__SB_CREDENTIAL__ ` followed by JSON go into the
    SAVE-THESE-NOW banner / Bitwarden export — emit one per service.
  - Non-zero exit logs a warning but doesn't roll back the deploy.

Schema v4 swapped Navidrome for Jellyfin so Symfonium / Findroid /
Streamyfin can pair via Quick Connect (the closest practical thing to
SSO for music-app pairing — operator confirms a 6-digit code in the
web UI once, app is paired). #1725/#1730 retired Audiobookshelf; Jellyfin
owns the whole media stack now (audiobooks included).

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
  6. Install + configure the LDAP-Authentication plugin against LLDAP so
     the family signs in with their Authelia/LLDAP credentials (#1718).

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
import urllib.parse
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

# Bounded window for the "is the startup wizard already done?" probe
# (#2375). Much shorter than JELLYFIN_READY_TIMEOUT: this only has to
# outlast a container restart's Kestrel-not-listening-yet gap, and on a
# genuinely fresh install every second spent here is wasted before the
# real first-run wait starts.
JELLYFIN_WIZARD_PROBE_TIMEOUT = 60

# Pod-container names. Podman names a Pod's containers `<pod>-<container>`;
# this pod is `media`, the container is `jellyfin` (see template.yml).
# Used by the Jellyfin LDAP plugin restart (#1718) and kept as the
# `ContainerName=` of the GPU `.container` Quadlet so every other caller
# (LDAP restart, ServiceBay's discovery, the operator's `podman logs`)
# keeps finding the same name after the swap.
JELLYFIN_CONTAINER = "media-jellyfin"

# Systemd user Quadlet directory — where `media.kube` / `media.yml` land
# and where the GPU `.container` unit is written (#2580).
SYSTEMD_USER_DIR = "~/.config/containers/systemd"

# Presence of this file is how the host advertises a CDI-registered
# NVIDIA GPU (`nvidia-ctk cdi generate`). No file → no card ServiceBay
# can hand over → leave the pod alone and keep transcoding on the CPU.
CDI_NVIDIA_SPEC = "/etc/cdi/nvidia.yaml"


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


# ── GPU passthrough: swap the .kube pod for a .container Quadlet ─────


def gpu_requested() -> bool:
    """Whether the operator wants NVIDIA hardware transcoding.

    Blank means "force software transcoding"; anything else (the default
    `yes`) means "use the card if this host has one". The *if* is
    resolved in `install_gpu_quadlet_fallback`, not here — a GPU-less
    box must install unchanged, so the toggle alone is never enough to
    change the deploy shape."""
    return env("JELLYFIN_GPU_PASSTHROUGH", "").strip() != ""


def build_jellyfin_container_unit() -> str:
    """Render the `.container` Quadlet that replaces the `media` pod when
    the GPU is passed through (#2580).

    It mirrors `template.yml`'s single jellyfin container one directive
    at a time — image, published port, env, the three bind mounts, and
    the `auth.<domain>` host alias — and adds the two lines that are the
    entire point:

      * `AddDevice=nvidia.com/gpu=all` — the CDI handle. Expressed as
        `resources.limits.nvidia.com/gpu` in a Pod spec it is silently
        dropped by `podman kube play` on rootless 5.x (#1026/#2517), so
        the pod deploys healthy and transcodes on the CPU with nothing
        in the logs to say why.
      * `SecurityLabelDisable=true` — required, not cosmetic: without it
        the container gets the device nodes but NVML fails to
        initialise under SELinux ("Insufficient Permissions").

    `SecurityLabelDisable=true` also subsumes the pod's
    `io.podman.annotations.label/jellyfin: "disable"` annotation, which
    exists for the same reason the mounts below carry no `:z`/`:Z`: the
    /media tree is the SHARED multi-writer file-share volume, and a
    recursive relabel of it crash-loops the service on a single
    root-owned stray (#1731). Do not add relabel flags here.

    Values come from the environment (every wizard variable is exported
    into this script), so this stays in step with what the pod was
    rendered from."""
    port = env("JELLYFIN_PORT", "8096")
    data_dir = env("DATA_DIR", "/mnt/data/stacks")
    media_path = env("JELLYFIN_MEDIA_PATH", f"{data_dir}/file-share/data")
    tz = env("TZ", "Europe/Berlin")
    public_domain = env("PUBLIC_DOMAIN", "")
    media_subdomain = env("MEDIA_SUBDOMAIN", "media")
    gateway_ip = env("HOST_GATEWAY_IP", "169.254.1.2")

    lines = [
        "[Unit]",
        "Description=Jellyfin (Movies & TV, NVIDIA passthrough #2580)",
        "Wants=network-online.target",
        "After=network-online.target",
        "",
        "[Container]",
        "Image=docker.io/jellyfin/jellyfin:latest",
        f"ContainerName={JELLYFIN_CONTAINER}",
        f"PublishPort={port}:{port}",
        f"Environment=TZ={tz}",
    ]
    if public_domain:
        lines.append(
            f"Environment=JELLYFIN_PublishedServerUrl=https://{media_subdomain}.{public_domain}"
        )
        # Mirrors the pod's hostAliases entry: an isolated container
        # cannot reach the host's own LAN IP under rootless podman
        # (#817), so server-side calls to Authelia go through the
        # host-gateway address instead.
        lines.append(f"AddHost=auth.{public_domain}:{gateway_ip}")
    lines += [
        "# CDI device — the only form that actually attaches the card on",
        "# rootless podman 5.x. See #1026 / #2517 for the dead ends.",
        "AddDevice=nvidia.com/gpu=all",
        "# Required for NVML init under SELinux, and it is also what keeps",
        "# the shared /media tree from being relabelled (#1731).",
        "SecurityLabelDisable=true",
        f"Volume={data_dir}/media/jellyfin-config:/config",
        f"Volume={data_dir}/media/jellyfin-cache:/cache",
        f"Volume={media_path}:/media:ro",
        "AutoUpdate=registry",
        "",
        "[Service]",
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ]
    return "\n".join(lines)


def install_gpu_quadlet_fallback() -> bool:
    """Swap the just-deployed `media.kube` unit for a `.container` Quadlet
    that carries the CDI device (#2580, mechanism from #1026).

    Returns True when the service is (or has just become) GPU-backed,
    False when it stays a plain CPU pod — the caller uses that to decide
    whether to switch Jellyfin's own transcoding setting to NVENC.
    Pointing Jellyfin at NVENC without the device would turn every
    transcode into an error, so the two must move together.

    Idempotent in both directions:
      * no `/etc/cdi/nvidia.yaml` → no card → returns False, touches
        nothing. This is what makes the default-on toggle safe on a box
        with no GPU.
      * `media.container` already present → the swap happened on an
        earlier deploy; ServiceBay's `reconcileContainerQuadletShadow`
        retires the freshly re-written `.kube`/`.yml` after this script
        returns (#2174), so there is nothing to do here.

    Data is untouched: the `.container` unit binds the same three host
    paths the pod did, so an existing install keeps its Jellyfin
    database, cache and library exactly where they were."""
    if not os.path.exists(CDI_NVIDIA_SPEC):
        log(f"ℹ️ No CDI NVIDIA spec at {CDI_NVIDIA_SPEC} — this host has no GPU to hand over. "
            "Jellyfin stays on the plain pod and transcodes in software.")
        return False

    systemd_dir = os.path.expanduser(SYSTEMD_USER_DIR)
    kube_path = os.path.join(systemd_dir, "media.kube")
    container_path = os.path.join(systemd_dir, "media.container")

    if os.path.exists(container_path):
        log("ℹ️ media.container already in place — GPU passthrough is already wired; "
            "ServiceBay retires the shadowing media.kube after this script (#2174).")
        return True

    # Stop the .kube-backed unit first. Both unit files generate
    # `media.service`, so leaving the .kube in place would let systemd's
    # generator pick either one at reload time.
    subprocess.run(["systemctl", "--user", "stop", "media.service"], check=False, capture_output=True)
    if os.path.exists(kube_path):
        try:
            os.unlink(kube_path)
        except OSError as e:
            log(f"⚠️ Could not remove {kube_path} ({e}) — Quadlet may generate two units for media.service. "
                "Remove it by hand and run `systemctl --user daemon-reload`.")

    try:
        with open(container_path, "w") as f:
            f.write(build_jellyfin_container_unit())
        os.chmod(container_path, 0o644)
    except OSError as e:
        log(f"⚠️ Could not write {container_path} ({e}) — GPU passthrough not applied; "
            "Jellyfin keeps transcoding in software.")
        return False

    # The old pod container holds the name; the generated unit runs
    # `podman run --replace`, but clear it explicitly so a failure to
    # replace can't leave the CPU container in place.
    subprocess.run(["podman", "rm", "-f", JELLYFIN_CONTAINER], check=False, capture_output=True)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False, capture_output=True)
    started = subprocess.run(
        ["systemctl", "--user", "start", "media.service"], capture_output=True, text=True,
    )
    if started.returncode != 0:
        log(f"⚠️ media.service did not start from the .container Quadlet: {started.stderr.strip()[:400]}")
        return False

    log("✅ Jellyfin swapped to a .container Quadlet with AddDevice=nvidia.com/gpu=all — the card is attached.")
    return True


# ── Jellyfin first-run + Quick Connect + Music library ───────────────


# Pseudo-device identity sent to /Users/AuthenticateByName so Jellyfin's
# auth log shows where the token came from. The Device + DeviceId pair
# also lets the operator revoke this token cleanly from
# Dashboard → API Keys if they want a clean audit trail.
JELLYFIN_AUTH_HEADER = (
    'MediaBrowser Client="ServiceBay", Device="post-deploy", '
    'DeviceId="servicebay-postdeploy", Version="1.0"'
)


def jellyfin_wizard_completed(base_url: str) -> bool:
    """Probe `GET /System/Info/Public` over a bounded window and report
    whether Jellyfin's first-run wizard is already completed.

    Retried rather than single-shot (#2375). A redeploy that changes the
    pod's topology fully restarts the container, so Kestrel can still be
    coming up when the first probe fires. A single missed probe used to
    fall through to `jellyfin_wait_default_user`, whose /Startup/FirstUser
    poll can never return 200 on an already-initialized server — burning
    the whole JELLYFIN_READY_TIMEOUT and silently skipping every step
    gated behind first-setup (music providers, plugins, libraries, user
    access).

    A 200 answer is authoritative in *both* directions: a false
    `StartupWizardCompleted` means this really is a fresh install, so
    return immediately and let the first-run walk proceed instead of
    idling out the probe window. Returns False when the window elapses
    without any usable answer."""
    started = time.time()
    while True:
        code, info = request_json("GET", f"{base_url}/System/Info/Public", timeout=10)
        if code == 200 and isinstance(info, dict):
            return bool(info.get("StartupWizardCompleted"))
        if time.time() - started >= JELLYFIN_WIZARD_PROBE_TIMEOUT:
            return False
        time.sleep(JELLYFIN_READY_INTERVAL)


def jellyfin_wait_default_user(base_url: str) -> str:
    """Poll `GET /Startup/FirstUser` until Jellyfin's first-run state is
    settled. Returns one of:

      - `"ready"`             — 200: the default user now exists.
      - `"already_completed"` — 401/403: the route is locked down, i.e.
        the wizard finished long ago and there is nothing to wait for.
      - `"timeout"`           — the deadline passed with neither.

    A 200 runs the UserManager's async init pass — which creates
    Jellyfin's default user — *before* responding, so it both confirms
    Jellyfin is up AND guarantees the default user exists. `POST
    /Startup/User` does NOT initialize the UserManager; it just calls
    `GetFirstUser()` and returns 404 ("NotFound") when no user exists
    yet. So without this wait the admin seed races first-run init and
    Jellyfin answers 404. Phase 3C retired the install runner's
    per-template readiness probe that used to do this wait, so it has to
    live back in this script (#809).

    The 401 case is a *positive* signal, not a transient failure (#2375):
    Jellyfin locks the /Startup/* routes behind auth once
    `IsStartupWizardCompleted` is true in system.xml, so on an
    already-initialized server this endpoint answers 401 forever and the
    poll was structurally guaranteed to burn the full 5-minute budget."""
    started = time.time()
    last_beat = 0.0
    while time.time() - started < JELLYFIN_READY_TIMEOUT:
        code, _ = request_json("GET", f"{base_url}/Startup/FirstUser", timeout=10)
        if code == 200:
            return "ready"
        if code in (401, 403):
            return "already_completed"
        elapsed = time.time() - started
        if elapsed - last_beat >= 10:
            log(f"Waiting for Jellyfin to finish first-run init ({int(elapsed)}s elapsed)...")
            last_beat = elapsed
        time.sleep(JELLYFIN_READY_INTERVAL)
    return "timeout"


def jellyfin_run_first_setup(base_url: str, admin_user: str, admin_password: str, tz: str) -> bool:
    """Walk the /Startup/* sequence to bypass the interactive wizard.
    Returns True on a clean walk; on any non-2xx step the function bails
    early so the operator finishes setup in the browser instead of
    leaving Jellyfin half-configured."""
    # Idempotent guard: if the public info already says wizard is done,
    # skip — this lets the post-deploy re-run without resetting admin.
    # Probed over a bounded window, not once, so a container restart's
    # startup gap can't push a redeploy onto the first-run path (#2375).
    if jellyfin_wizard_completed(base_url):
        log("ℹ️ Jellyfin startup wizard already completed — leaving the existing admin.")
        return True

    # Wait for Jellyfin's UserManager to finish initializing before
    # touching any /Startup/* endpoint (#809) — POST /Startup/User 404s
    # until the default user exists.
    state = jellyfin_wait_default_user(base_url)
    if state == "already_completed":
        # 401 on /Startup/FirstUser ⇒ the wizard is done and the route is
        # locked; the guard above just didn't get a clean answer in time.
        log("ℹ️ Jellyfin: /Startup/FirstUser is locked down (HTTP 401) — the startup wizard is already completed; leaving the existing admin.")
        return True
    if state != "ready":
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


# Disk-import sorts content into `file-share/data/<category>` (shared) and
# `file-share/data/<owner>/<category>` (per-user). These are the categories
# Jellyfin serves → (display name, Jellyfin collectionType). `photos` is Immich's
# domain and `documents`/`notes`/`files` are Filebrowser's — deliberately NOT
# Jellyfin libraries. `_superseded` is the conflict-park tree.
JELLYFIN_MEDIA_CATEGORIES: dict[str, tuple[str, str]] = {
    "music": ("Music", "music"),
    "movies": ("Movies", "movies"),
    "tv": ("Shows", "tvshows"),
    "audiobooks": ("Audiobooks", "books"),
}
# Top-level dirs that are categories (media or not), NOT per-user owner dirs.
_NON_OWNER_DIRS = set(JELLYFIN_MEDIA_CATEGORIES) | {
    "photos", "documents", "notes", "files", "podcasts", "_superseded",
}


def _dir_nonempty(path: str) -> bool:
    """True iff `path` is a directory with at least one entry. Cheap (no walk)."""
    try:
        with os.scandir(path) as it:
            return any(True for _ in it)
    except OSError:
        return False


def _jellyfin_create_library(base_url: str, token: str, name: str, collection_type: str, container_path: str) -> str:
    """Create one Jellyfin library. Returns 'created' / 'exists' / 'error'.
    Idempotent: a 400 'already exists' is a no-op success — a redeploy never
    duplicates a library. `refreshLibrary=false` so we scan ONCE at the end,
    not once per library."""
    qs = (
        f"?name={urllib.parse.quote(name)}"
        f"&collectionType={collection_type}&refreshLibrary=false"
    )
    code, body = request_json(
        "POST", f"{base_url}/Library/VirtualFolders{qs}",
        {"LibraryOptions": {"PathInfos": [{"Path": container_path}], "EnableRealtimeMonitor": False}},
        extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
    )
    if code in (200, 204):
        return "created"
    if code == 400 and "exist" in str(body).lower():
        return "exists"
    log(f"   (note) could not create library '{name}' → {container_path} (HTTP {code})")
    return "error"


def ensure_jellyfin_bookshelf_plugin(base_url: str, token: str) -> bool:
    """Install the official `jellyfin-plugin-bookshelf` so a `books`-type library
    indexes AUDIOBOOKS (mp3/m4a/m4b/flac) as playable AudioBook items, not just
    ebooks (#2028). Jellyfin's built-in Books collection type only handles
    pdf/epub WITHOUT this plugin — the audiobooks library would show 0 playable
    tracks. Must run BEFORE jellyfin_provision_libraries creates the `books`
    library.

    Best-effort + idempotent: Jellyfin no-ops a re-install of an already-present
    plugin, so this is safe every deploy. A failure just logs a note (the
    operator can install 'Bookshelf' from Dashboard → Plugins → Catalog) — it
    never blocks the deploy."""
    code, _ = request_json(
        "POST", f"{base_url}/Packages/Installed/Bookshelf",
        None,
        extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
    )
    if code in (200, 204):
        log("   ✅ Jellyfin Bookshelf plugin install requested (audiobooks → playable AudioBook items).")
        return True
    log(f"   (note) Could not request Bookshelf plugin install via API (HTTP {code}); "
        "if audiobooks don't appear, install 'Bookshelf' from Dashboard → Plugins → Catalog.")
    return False


def jellyfin_provision_libraries(base_url: str, token: str, media_root: str) -> dict[str, object]:
    """Create PUBLIC libraries from the shared `file-share/data/<category>` dirs
    and PRIVATE per-user libraries from `data/<owner>/<category>` dirs, mirroring
    how disk-import sorts content. Each private library is named `<Category>
    (<owner>)`. Idempotent + self-healing on every deploy. A single library scan
    is triggered only when something new was actually created.

    Returns the library GUIDs so access can be wired immediately:
    `{'public': [guid,…], 'private_by_user': {owner: [guid,…]}}`. `/media` is the
    container-side mount of `media_root` (the host file-share data root)."""
    public_names: list[str] = []
    private_names_by_user: dict[str, list[str]] = {}
    created_any = False
    try:
        entries = sorted(os.listdir(media_root))
    except OSError as exc:
        log(f"(note) cannot read media root {media_root} ({exc}) — skipping library auto-provision.")
        return {"public": [], "private_by_user": {}}

    for entry in entries:
        host_path = os.path.join(media_root, entry)
        if not os.path.isdir(host_path):
            continue
        if entry in JELLYFIN_MEDIA_CATEGORIES:
            # shared category → PUBLIC library
            disp, ctype = JELLYFIN_MEDIA_CATEGORIES[entry]
            if _dir_nonempty(host_path):
                outcome = _jellyfin_create_library(base_url, token, disp, ctype, f"/media/{entry}")
                if outcome != "error":
                    public_names.append(disp)
                    created_any = created_any or outcome == "created"
        elif entry not in _NON_OWNER_DIRS:
            # a per-user owner dir → PRIVATE library per media subdir it holds
            try:
                subs = sorted(os.listdir(host_path))
            except OSError:
                continue
            for sub in subs:
                if sub in JELLYFIN_MEDIA_CATEGORIES and _dir_nonempty(os.path.join(host_path, sub)):
                    disp, ctype = JELLYFIN_MEDIA_CATEGORIES[sub]
                    name = f"{disp} ({entry})"
                    outcome = _jellyfin_create_library(base_url, token, name, ctype, f"/media/{entry}/{sub}")
                    if outcome != "error":
                        private_names_by_user.setdefault(entry, []).append(name)
                        created_any = created_any or outcome == "created"

    # Resolve names → library GUIDs (the ItemId Jellyfin uses in user policies).
    code, folders = request_json(
        "GET", f"{base_url}/Library/VirtualFolders", None,
        extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
    )
    byname = {f["Name"]: f["ItemId"] for f in folders} if isinstance(folders, list) else {}
    public_guids = [byname[n] for n in public_names if n in byname]
    private_by_user = {
        owner: [byname[n] for n in names if n in byname]
        for owner, names in private_names_by_user.items()
    }
    if created_any:
        request_json(
            "POST", f"{base_url}/Library/Refresh", None,
            extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
        )
    n_private = sum(len(v) for v in private_by_user.values())
    log(f"✅ Jellyfin libraries: {len(public_guids)} public, {n_private} private"
        + (" (scan started)" if created_any else " (no change)") + ".")
    return {"public": public_guids, "private_by_user": private_by_user}


def jellyfin_set_user_access(base_url: str, token: str, public_guids: list[str], private_by_user: dict[str, list[str]]) -> None:
    """Grant every non-admin Jellyfin user access to the PUBLIC libraries plus
    THEIR OWN private libraries (matched by username). Admins keep
    `EnableAllFolders` (full access). Idempotent — re-applies the same set each
    deploy. New users who haven't logged in yet are covered by the LDAP-Auth
    plugin's `EnabledFolders` default (public libs); their private libraries are
    granted here on the first deploy after they log in."""
    if not public_guids and not private_by_user:
        return
    code, users = request_json(
        "GET", f"{base_url}/Users", None,
        extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
    )
    if not isinstance(users, list):
        log(f"(note) could not list Jellyfin users (HTTP {code}) — skipping per-user library access.")
        return
    for user in users:
        policy = user.get("Policy", {})
        if policy.get("IsAdministrator"):
            continue
        enabled = list(dict.fromkeys(public_guids + private_by_user.get(user.get("Name", ""), [])))
        policy["EnableAllFolders"] = False
        policy["EnabledFolders"] = enabled
        st, _ = request_json(
            "POST", f"{base_url}/Users/{user['Id']}/Policy", policy,
            extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'},
        )
        ok = st in (200, 204)
        log(f"   {user.get('Name')}: {len(enabled)} libraries" + ("" if ok else f" (FAILED HTTP {st})"))


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
    enabled_folders: list[str] | None = None,
) -> str:
    """Render the Jellyfin LDAP-Auth plugin's `LDAP-Auth.xml`.

    Mirrors how Radicale binds LLDAP (templates/radicale/template.yml):
      - server  ldap://host.containers.internal:3890
      - base    the LLDAP base DN (e.g. dc=example,dc=com), users under ou=people
      - bind    uid=admin,ou=people,<base DN>
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
    # Library access for AUTO-PROVISIONED users (CreateUsersFromLdap): grant the
    # PUBLIC libraries by default (their GUIDs), NOT EnableAllFolders=true — that
    # would leak every user's PRIVATE library to everyone. A user's own private
    # libraries are granted per-user by jellyfin_set_user_access after they exist.
    folders_xml = "".join(f"<string>{f}</string>" for f in (enabled_folders or []))
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
        "  <EnableAllFolders>false</EnableAllFolders>\n"
        f"  <EnabledFolders>{folders_xml}</EnabledFolders>\n"
        "</PluginConfiguration>\n"
    )


def _read_existing_enabled_folders(config_path: str) -> list[str]:
    """Best-effort: pull the `<EnabledFolders><string>…</string></EnabledFolders>`
    library GUIDs out of an existing LDAP-Auth.xml, so a token-less deploy that
    rewrites the config preserves the public-libs default rather than wiping it.
    Returns [] when the file is absent/unreadable/has none."""
    try:
        with open(config_path, encoding="utf-8") as fh:
            content = fh.read()
    except OSError:
        return []
    import re
    block = re.search(r"<EnabledFolders>(.*?)</EnabledFolders>", content, re.S)
    if not block:
        return []
    return re.findall(r"<string>([^<]+)</string>", block.group(1))


def ensure_jellyfin_ldap_plugin(
    base_url: str,
    token: str | None,
    ldap_port: str,
    base_dn: str,
    bind_password: str,
    enabled_folders: list[str] | None = None,
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
    # No fallback DN (#2439): the search base, bind DN and admin-group DN below
    # are all built from it, so a guessed value writes a plugin config that
    # binds against a tree that does not exist — LDAP logins then fail with an
    # opaque error instead of the plugin being visibly absent.
    if not base_dn:
        log("   ℹ️ Jellyfin LDAP wiring skipped — LLDAP_BASE_DN is empty "
            "(set it to the base DN the `auth` stack initialised LLDAP with).")
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
    # The config is rewritten every deploy. If THIS run couldn't determine the
    # public library GUIDs (no admin token → no library provisioning), preserve
    # whatever EnabledFolders the existing config already has, so a token-less
    # deploy doesn't wipe the public-libs default new users rely on.
    folders = enabled_folders if enabled_folders else _read_existing_enabled_folders(config_path)
    xml = render_ldap_plugin_config(
        ldap_host, ldap_port, base_dn, bind_dn, bind_password, admin_group_dn, folders,
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


# ── Jellyfin music metadata providers + LrcLib lyrics (durable on reinstall) ──


# TheAudioDB + MusicBrainz are BUNDLED metadata providers (no plugin install);
# enabling them on the Music library makes Jellyfin fetch artist/album art +
# tags. These are the fetcher ids Jellyfin uses for the MusicArtist/MusicAlbum
# item types.
_MUSIC_METADATA_FETCHERS = ["TheAudioDB", "MusicBrainz"]
_MUSIC_IMAGE_FETCHERS = ["TheAudioDB"]


def jellyfin_enable_music_providers(base_url: str, token: str, folders: object) -> None:
    """Turn on internet metadata providers (TheAudioDB + MusicBrainz) for every
    `music` library, so artist/album art + tags are fetched. Read-modify-write:
    each library's EXISTING LibraryOptions (from GET /Library/VirtualFolders) is
    preserved and only the provider fields are merged in, then POSTed back via
    /Library/VirtualFolders/LibraryOptions.

    Best-effort + idempotent: re-asserts the same values every deploy, so a fresh
    reinstall never loses the music-metadata config. A failure just logs a note;
    it never blocks the deploy."""
    if not isinstance(folders, list):
        return
    auth = {"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'}
    type_options = [
        {
            "Type": item_type,
            "MetadataFetchers": list(_MUSIC_METADATA_FETCHERS),
            "MetadataFetcherOrder": list(_MUSIC_METADATA_FETCHERS),
            "ImageFetchers": list(_MUSIC_IMAGE_FETCHERS),
            "ImageFetcherOrder": list(_MUSIC_IMAGE_FETCHERS),
        }
        for item_type in ("MusicArtist", "MusicAlbum")
    ]
    for folder in folders:
        if not isinstance(folder, dict) or folder.get("CollectionType") != "music":
            continue
        item_id = folder.get("ItemId")
        if not item_id:
            continue
        # Read-modify-write: keep the library's existing options, merge providers.
        options = dict(folder.get("LibraryOptions") or {})
        options["EnableInternetProviders"] = True
        options["TypeOptions"] = type_options
        code, _ = request_json(
            "POST", f"{base_url}/Library/VirtualFolders/LibraryOptions",
            {"Id": item_id, "LibraryOptions": options},
            extra_headers=auth,
        )
        name = folder.get("Name", item_id)
        if code in (200, 204):
            log(f"   ✅ Jellyfin music metadata providers enabled for '{name}' (TheAudioDB + MusicBrainz).")
        else:
            log(f"   (note) Could not enable music metadata providers for '{name}' (HTTP {code}); "
                "set them in Dashboard → Libraries → (Music) → Metadata downloaders.")


# LrcLib is a COMMUNITY-repo plugin (lyrics provider). Its manifest is not in
# Jellyfin's default catalog, so the plugin repository has to be registered
# before the package install can resolve it.
JELLYFIN_LRCLIB_REPO_NAME = "LrcLib"
JELLYFIN_LRCLIB_REPO_URL = (
    "https://raw.githubusercontent.com/dishmoth/jellyfin-plugin-lrclib/main/manifest.json"
)
JELLYFIN_LRCLIB_PACKAGE = "LrcLib"


def ensure_jellyfin_lrclib_plugin(base_url: str, token: str) -> bool:
    """Register the LrcLib community plugin repository (if not already present)
    and request the LrcLib package install, so Jellyfin can fetch lyrics. (The
    Solaris engine reading those lyrics is a separate ticket.)

    Best-effort + idempotent: the repo-add is skipped when the manifest URL is
    already registered, and Jellyfin no-ops a re-install of a present plugin. A
    failure just logs a breadcrumb (operator can add it from Dashboard → Plugins
    → Catalog) and continues — it never blocks the deploy."""
    auth = {"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'}

    # 1. Ensure the community plugin repository is registered.
    code, repos = request_json("GET", f"{base_url}/Repositories", None, extra_headers=auth)
    if code not in (200, 204) or not isinstance(repos, list):
        log(f"   (note) Could not read Jellyfin plugin repositories (HTTP {code}); "
            "add LrcLib from Dashboard → Plugins → Catalog if lyrics are missing.")
        return False
    have_repo = any(
        isinstance(r, dict) and r.get("Url") == JELLYFIN_LRCLIB_REPO_URL for r in repos
    )
    if not have_repo:
        merged = [r for r in repos if isinstance(r, dict)]
        merged.append({
            "Name": JELLYFIN_LRCLIB_REPO_NAME,
            "Url": JELLYFIN_LRCLIB_REPO_URL,
            "Enabled": True,
        })
        code, _ = request_json("POST", f"{base_url}/Repositories", merged, extra_headers=auth)
        if code not in (200, 204):
            log(f"   (note) Could not register the LrcLib plugin repository (HTTP {code}); "
                "add it from Dashboard → Plugins → Catalog if lyrics are missing.")
            return False
        log("   ✅ Jellyfin LrcLib plugin repository registered.")

    # 2. Request the package install (idempotent — Jellyfin no-ops a re-install).
    pkg = urllib.parse.quote(JELLYFIN_LRCLIB_PACKAGE)
    code, _ = request_json("POST", f"{base_url}/Packages/Installed/{pkg}", None, extra_headers=auth)
    if code in (200, 204):
        log("   ✅ Jellyfin LrcLib plugin install requested (lyrics provider).")
        return True
    log(f"   (note) Could not request LrcLib plugin install via API (HTTP {code}); "
        "install 'LrcLib' from Dashboard → Plugins → Catalog if lyrics are missing.")
    return False


# ── Jellyfin built-in DLNA server (durable on reinstall, #2369) ──────────────

# Jellyfin ≥10.9 ships DLNA as the catalog plugin "DLNA" ("Adds DLNA capability
# to Jellyfin"), whose manifest is in the DEFAULT Jellyfin repository — so a
# plain package install resolves it without registering a repo (unlike LrcLib).
# Older cores compile DLNA in; the install then no-ops and the config write
# below is what turns the server on. The named-configuration key is "dlna".
JELLYFIN_DLNA_PACKAGE = "DLNA"


def ensure_jellyfin_dlna_server(base_url: str, token: str) -> bool:
    """Enable Jellyfin's built-in DLNA server by default so LAN TVs / DLNA
    clients can browse the libraries straight from the TV without any manual
    Dashboard step (#2369). Two best-effort halves:

      1. Request the DLNA plugin install (idempotent — Jellyfin no-ops a
         re-install of a present plugin; a core with DLNA built in no-ops too).
      2. Read-modify-write the `dlna` named configuration: GET the current
         DlnaOptions, flip `EnableServer` on, POST it back — every other DLNA
         option is preserved, exactly like `jellyfin_enable_music_providers`
         merges into a library's existing LibraryOptions.

    Best-effort + idempotent: re-asserts EnableServer=true every deploy, so a
    fresh reinstall never loses it. A failure just logs a breadcrumb (operator
    can flip it in Dashboard → DLNA); it never blocks the deploy."""
    auth = {"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'}

    # 1. Request the DLNA plugin install (idempotent — no-ops if already present
    #    or built into the core). Resolves from the default catalog.
    pkg = urllib.parse.quote(JELLYFIN_DLNA_PACKAGE)
    code, _ = request_json(
        "POST", f"{base_url}/Packages/Installed/{pkg}", None, extra_headers=auth,
    )
    if code in (200, 204):
        log("   ✅ Jellyfin DLNA plugin install requested.")
    else:
        log(f"   (note) Could not request DLNA plugin install via API ({render_http_code(code)}); "
            "if DLNA is missing, install 'DLNA' from Dashboard → Plugins → Catalog.")

    # 2. Read-modify-write the DLNA named configuration to enable the server.
    code, options = request_json(
        "GET", f"{base_url}/System/Configuration/dlna", None, extra_headers=auth,
    )
    if code not in (200, 204) or not isinstance(options, dict):
        log(f"   (note) Could not read Jellyfin DLNA configuration ({render_http_code(code)}); "
            "enable the DLNA server from Dashboard → DLNA if LAN TVs can't see Jellyfin.")
        return False
    options["EnableServer"] = True
    code, _ = request_json(
        "POST", f"{base_url}/System/Configuration/dlna", options, extra_headers=auth,
    )
    if code in (200, 204):
        log("   ✅ Jellyfin built-in DLNA server enabled (LAN TVs/DLNA clients can browse).")
        return True
    log(f"   (note) Could not enable the Jellyfin DLNA server ({render_http_code(code)}); "
        "enable it from Dashboard → DLNA if LAN TVs can't see Jellyfin.")
    return False


# Codecs to hand NVDEC when we are the ones switching hardware
# acceleration on. Jellyfin's stock list is `h264, vc1` — fine while
# acceleration is off, but it leaves HEVC (i.e. most 4K) decoding in
# software on a box that has just been given a card. Jellyfin falls back
# to software for any codec the hardware can't do, so an over-broad list
# costs nothing.
JELLYFIN_NVDEC_CODECS = ["h264", "hevc", "mpeg2video", "mpeg4", "vc1", "vp8", "vp9", "av1"]


def jellyfin_enable_nvenc(base_url: str, token: str) -> bool:
    """Point Jellyfin's own transcoding configuration at NVENC (#2580).

    **Seeing the device is not using it.** Handing the container the card
    changes nothing on its own: Jellyfin picks its encoder from
    `HardwareAccelerationType` in its encoding configuration, which
    defaults to `none`, so a deploy that stops at `AddDevice=` still
    burns CPU cores on every re-encode. This is the other half.

    Read-modify-write on the `encoding` named configuration — the same
    shape `ensure_jellyfin_dlna_server` uses — so nothing else in the
    operator's transcoding setup is disturbed. That is what makes it
    safe on an EXISTING install: the settings survive, only the
    acceleration keys move.

    Non-destructive in the other direction too: an operator who
    deliberately chose a different accelerator (vaapi, qsv, …) keeps it.
    Only `none`/unset is taken over. Re-asserted on every deploy, so a
    reinstall never silently drops back to software."""
    auth = {"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{token}"'}

    code, options = request_json(
        "GET", f"{base_url}/System/Configuration/encoding", None, extra_headers=auth,
    )
    if code not in (200, 204) or not isinstance(options, dict):
        log(f"   (note) Could not read Jellyfin's transcoding configuration ({render_http_code(code)}); "
            "set Dashboard → Playback → Hardware acceleration to 'Nvidia NVENC' by hand.")
        return False

    current = str(options.get("HardwareAccelerationType") or "").strip()
    if current.lower() not in ("", "none", "nvenc"):
        log(f"   (note) Jellyfin's hardware acceleration is already set to '{current}' — leaving it alone. "
            "Switch it to 'Nvidia NVENC' in Dashboard → Playback if you want the card used.")
        return False

    turning_on = current.lower() in ("", "none")
    options["HardwareAccelerationType"] = "nvenc"
    options["EnableHardwareEncoding"] = True
    if turning_on:
        # We are switching acceleration on, so the decode side is ours to
        # set: the list Jellyfin carries while acceleration is off is a
        # default, not a decision. Once it IS on, leave the list alone —
        # a narrower list from then on is the operator's choice.
        options["HardwareDecodingCodecs"] = list(JELLYFIN_NVDEC_CODECS)
        # Only touch keys this Jellyfin actually has — the encoding
        # options object gains and loses fields across releases, and
        # posting one it doesn't know is a needless 400 risk.
        for key in ("EnableEnhancedNvdecDecoder", "EnableDecodingColorDepth10Hevc", "EnableDecodingColorDepth10Vp9"):
            if key in options:
                options[key] = True

    code, _ = request_json(
        "POST", f"{base_url}/System/Configuration/encoding", options, extra_headers=auth,
    )
    if code in (200, 204):
        log("   ✅ Jellyfin transcoding set to NVENC (hardware encode + NVDEC decode).")
        return True
    log(f"   (note) Could not write Jellyfin's transcoding configuration ({render_http_code(code)}); "
        "set Dashboard → Playback → Hardware acceleration to 'Nvidia NVENC' by hand.")
    return False


def main() -> int:
    host = env("HOST", "<server-ip>")

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

    # ── GPU passthrough (#2580) ──────────────────────────────────────
    # Runs FIRST: the swap restarts the container, and everything below
    # talks to the Jellyfin API — better to point it at the unit that
    # will still be running when this script exits. `gpu_engaged` also
    # gates the NVENC setting further down: telling Jellyfin to use a
    # card it hasn't got turns every transcode into an error.
    gpu_engaged = install_gpu_quadlet_fallback() if gpu_requested() else False
    if not gpu_engaged and gpu_requested():
        log("ℹ️ Jellyfin will transcode in software on this box. That costs several CPU cores per "
            "stream — if this host does have an NVIDIA card, register it with `nvidia-ctk cdi generate` "
            "and redeploy `media`.")

    # ── Jellyfin first-run + Quick Connect + Music library ───────────
    # `jellyfin_run_first_setup` waits for the UserManager's async init
    # (via GET /Startup/FirstUser) before seeding the admin — see #809.
    if jf_password:
        jellyfin_base = f"http://127.0.0.1:{jf_port}"
        ready = jellyfin_run_first_setup(
            jellyfin_base, jf_user, jf_password, env("TZ", "Europe/Berlin"),
        )
        jf_token: str | None = None
        # Library GUIDs from provisioning — fed into the LDAP-Auth plugin's
        # EnabledFolders default (public libs for auto-provisioned users).
        public_lib_guids: list[str] = []
        if ready:
            jf_token = jellyfin_get_token(jellyfin_base, jf_user, jf_password)
            if jf_token:
                jellyfin_enable_quick_connect(jellyfin_base, jf_token)
                # Auto-create PUBLIC libraries (shared `data/<category>`) +
                # PRIVATE per-user libraries (`data/<owner>/<category>`), mirroring
                # how disk-import sorts content (#1725: Jellyfin also serves
                # audiobooks now). Then grant each user the public libs + their own
                # private libs. Music/Movies/Shows/Audiobooks; photos→Immich,
                # documents→Filebrowser.
                # Bookshelf MUST be installed before the `books`-type Audiobooks
                # library so audiobooks index as playable AudioBook items (#2028).
                ensure_jellyfin_bookshelf_plugin(jellyfin_base, jf_token)
                libs = jellyfin_provision_libraries(
                    jellyfin_base, jf_token,
                    env("JELLYFIN_MEDIA_PATH", "/mnt/data/stacks/file-share/data"),
                )
                public_lib_guids = list(libs["public"])  # type: ignore[arg-type]
                jellyfin_set_user_access(
                    jellyfin_base, jf_token,
                    public_lib_guids, libs["private_by_user"],  # type: ignore[arg-type]
                )
                # Enable music metadata providers (TheAudioDB + MusicBrainz) on
                # the Music library + register the LrcLib lyrics plugin, so a
                # fresh reinstall never loses them. Best-effort, never blocks.
                _, folders = request_json(
                    "GET", f"{jellyfin_base}/Library/VirtualFolders", None,
                    extra_headers={"X-Emby-Authorization": f'{JELLYFIN_AUTH_HEADER}, Token="{jf_token}"'},
                )
                jellyfin_enable_music_providers(jellyfin_base, jf_token, folders)
                ensure_jellyfin_lrclib_plugin(jellyfin_base, jf_token)
                # Enable the built-in DLNA server by default so LAN TVs /
                # DLNA clients can browse Jellyfin with no manual step (#2369).
                ensure_jellyfin_dlna_server(jellyfin_base, jf_token)
                # The card is attached — now make Jellyfin actually use it
                # (#2580). Without this the device is present and every
                # transcode still runs on the CPU.
                if gpu_engaged:
                    jellyfin_enable_nvenc(jellyfin_base, jf_token)

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
            env("LLDAP_BASE_DN"),
            env("LLDAP_ADMIN_PASSWORD"),
            public_lib_guids,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
