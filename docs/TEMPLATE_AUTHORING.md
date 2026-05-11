# Template authoring guide

ServiceBay treats every installable service as a **template** — a
self-contained directory that can be added, edited, or removed without
changing core code. This guide describes the on-disk contract.

The same model also applies to **stacks** (a `stacks/<name>/` directory
with a `README.md` whose `- [x] foo` lines reference template names).

## Anatomy of a template

```
templates/<name>/
├── template.yml                       # required — kube Pod manifest with mustache placeholders
├── variables.json                     # required — variable schema
├── README.md                          # required — short description for the wizard
├── CHANGELOG.md                       # optional — human-readable upgrade notes (Phase 1 of #352)
├── post-deploy.py                     # optional — runs on the host after the unit starts
├── migrations/                        # optional — schema-version migration scripts (Phase 3 of #352)
│   └── v1-to-v2.py                    # one file per one-step hop
└── *.mustache                         # optional — companion config files (e.g. authelia config)
```

### `template.yml`

A standard `kind: Pod` manifest with `{{MUSTACHE}}` placeholders that
the wizard substitutes at deploy time. Use these annotations under
`metadata.annotations`:

| Annotation | Required | Purpose |
|---|---|---|
| `servicebay.label` | yes | Friendly UI label shown in the wizard's configure step (e.g. `"Vaultwarden (Passwords)"`). Without it the section header falls back to the raw template name. |
| `servicebay.ports` | recommended | Comma-separated `port/proto` list. Drives gateway probes + the network graph. |
| `servicebay.config-mount` | required if any `*.mustache` files | Container mountPath that companion config files should land in. Avoids the `/config`-suffix heuristic picking the wrong volume in multi-container pods. |
| `servicebay.schema-version` | recommended (default `"1"`) | Bump when the pod structure or variable shape changes in a way operators need to be aware of (containers extracted, variables renamed, data paths moved). Plain image-tag bumps don't need this — Quadlet's `AutoUpdate=registry` handles those silently. Each bump should ship a `CHANGELOG.md` section + (if data needs to move) a `migrations/v{N-1}-to-v{N}.py` script. See #352. |

Use `metadata.labels` for `servicebay.role` (`dns`, `reverse-proxy`,
`media`, …) — those steer health-check defaults.

The pod must satisfy one of:
- `spec.hostNetwork: true`, OR
- every published `containerPort` declares an explicit `hostPort`

…otherwise the deploy is silently unreachable. The consistency test
enforces this.

### `variables.json`

Map of variable name to metadata. Recognized fields:

```jsonc
{
  "MY_PORT": {
    "type": "text",          // text | password | secret | rsa-private |
                             // bcrypt | select | device | subdomain
    "description": "Web UI port",
    "default": "8080",
    "options": ["a", "b"],   // for type=select
    "devicePath": "/dev/serial/by-id",  // for type=device
    "proxyPort": "MY_PORT",  // for type=subdomain — variable name OR literal port number
    "proxyConfig": {         // for type=subdomain — passed to NPM verbatim
      "block_exploits": true,
      "ssl_forced": true,
      "advanced_config": "client_max_body_size 0;"  // mustache-rendered
    },
    "oidcClient": {          // optional — registered with Authelia
      "client_id": "myapp",
      "client_name": "My App",
      "authorization_policy": "one_factor",
      "redirect_uris": ["/auth/callback"],
      "scopes": ["openid", "profile", "email"],
      "clientSecretVar": "MY_SSO_SECRET"  // optional — env-wired SSO
    },
    "bcryptSource": "ADMIN_PASSWORD"  // for type=bcrypt — name of the var to hash
  }
}
```

What each `type` does generically (no per-template code needed):

- **`text` / `select` / `device`** — rendered as a form input.
- **`password` / `secret`** — auto-generated random string, shown
  read-only with a regenerate button.
- **`rsa-private`** — auto-generated PEM, hidden from the UI.
- **`bcrypt`** — hash of `bcryptSource`'s value, hidden from the UI.
  Use this when you need both the plaintext (in env) and the hash
  (in a config file).
- **`subdomain`** — registers an NPM proxy host using `proxyPort` +
  `proxyConfig`. Mustache placeholders inside `advanced_config` are
  rendered against the user's variables, so cross-template wiring
  (`{{AUTHELIA_PORT}}`, `{{PUBLIC_DOMAIN}}`) works.
- **`oidcClient` on any var** — collected across every selected
  template and registered with Authelia in one POST. When
  `clientSecretVar` is set, the secret is wired into the container
  env (e.g. `SSO_CLIENT_SECRET`) automatically — no UI paste needed.

`templates/settings.json` declares a few global variables (`DATA_DIR`,
`LLDAP_HOST`, `LLDAP_LDAP_PORT`, `LLDAP_BASE_DN`) that every template
can reference without re-declaring.

### Companion mustache files (`*.mustache`)

Any `<name>.mustache` file in the template directory gets rendered with
the user's variables and shipped to the host as `<name>` (extension
stripped). The target path is derived from the volume that mounts the
container's `servicebay.config-mount`.

Use these for service config files that need substituted values
on first start (AdGuard's `AdGuardHome.yaml`, Authelia's
`configuration.yml`).

### `post-deploy.py`

Optional Python script that runs on the host **after** the unit starts.
This is where per-service glue lives — credential surfacing, admin
seeding, post-install validation, etc. There is no other extension
point: if you need it, put it here.

```python
#!/usr/bin/env python3
import json, os, sys

def emit_credential(**fields):
    sys.stdout.write("__SB_CREDENTIAL__ " + json.dumps(fields) + "\n")
    sys.stdout.flush()

def main() -> int:
    password = os.environ.get("MY_ADMIN_PASSWORD", "")
    if not password:
        return 0  # nothing to surface — early return is fine

    # Plain log lines stream into the install panel.
    print(f"🔑 My App admin (user: admin, password: {password})")

    # Credential markers go into the SAVE-THESE-NOW banner + Bitwarden CSV.
    emit_credential(
        service="My App",
        url=f"http://{os.environ.get('HOST', '<server-ip>')}:{os.environ.get('MY_PORT', '8080')}",
        username="admin",
        password=password,
        importance="critical",            # or "system" for DR-only secrets
        notes="Admin panel. Save now.",
    )
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

#### Environment available to the script

- Every wizard variable, exported as the same env var name
  (e.g. `MY_ADMIN_PASSWORD`, `PUBLIC_DOMAIN`).
- `HOST` — hostname the operator is browsing ServiceBay through.
- `SB_NODE` — node name the script is running on.
- `SB_API_URL` — `http://localhost:<servicebay-port>`. Use this to
  call back into ServiceBay (LLDAP probe, FileBrowser init, …).
- `SB_API_TOKEN` — internal token. Attach as `X-SB-Internal-Token`
  on POSTs to `SB_API_URL`; without it the same-origin guard
  rejects the call (see `auth/post-deploy.py` for the canonical
  pattern).

#### Output protocol

- **Plain stdout lines** — relayed to the install log as-is.
- **`__SB_CREDENTIAL__ {json}` lines** — parsed by the wizard. The
  JSON object goes into the SAVE-THESE-NOW banner and the Bitwarden
  CSV download. Required fields: `service`, `url`, `username`,
  `password`, `importance` (`critical` | `system`). Optional: `notes`.
- **Exit code** — `0` on success. Non-zero is logged but does **not**
  roll back the deploy (the unit is already running).

#### Wait loops

When your script needs the upstream service to be reachable before
seeding (LLDAP, FileBrowser, ABS), follow the pattern in the existing
scripts: 5-minute deadline, 10-second heartbeat log, sleep between
retries. The agent budget is 20 minutes, so leave slack.

### `CHANGELOG.md`

Optional but strongly recommended. Each `## v{N}` H2 section is one
schema version. Append `(breaking)` to the heading when the bump
*requires* operator action (data has moved, a variable was renamed,
a container was split out). The wizard surfaces every section
between the operator's currently-deployed version and the
template's current version, and gates the deploy on an
acknowledgement checkbox for every breaking section.

```markdown
## v2 (breaking)
- Voice extracted into the `voice` template. Required action:
  install the `voice` template from the registry if you want
  whisper/piper back.

## v1
Initial release.
```

There is no enforced field set inside each section — the body is
markdown and rendered verbatim. Two conventions worth following:
- Lead with the **required action** in one sentence if the section
  is breaking; everything else is supporting context.
- Reference the data paths that moved by absolute path
  (`${DATA_DIR}/...`) so operators can correlate with their host
  filesystem.

### `migrations/v{N}-to-v{M}.py`

Optional. Python scripts in the `migrations/` directory run on the
host **before** the new pod manifest lands when the operator's
installed schema-version is older than the template's current. One
file per one-step hop (`v1-to-v2.py`, `v2-to-v3.py`, …) — the
engine walks the chain in order if an operator's box is multiple
versions behind. See #352 phase 3.

The script protocol is identical to `post-deploy.py` (env file →
`source` → `python3`, stdout streamed live to the install log)
with two important differences:

1. **Migrations are fail-fast.** A non-zero exit aborts the deploy
   *before* the new yaml lands — the existing service keeps running
   and the operator is left with a clear error in the install log.
   This is the inverse of `post-deploy.py`, which logs a warning
   and continues. The reason: a half-completed data migration with
   the new container then booting on un-migrated data is the worst
   failure mode possible (silent data corruption); we'd rather fail
   loudly and let the operator inspect.
2. **Idempotent by contract.** Migrations *will* re-run on every
   deploy where the version delta hasn't been stamped to disk yet
   (a partial migration that didn't update `config.installedTemplates`).
   Always check the on-disk state before transforming it. The
   canonical pattern: probe for the source path, exit 0 with a
   "nothing to do" log line if it's absent, mutate only when the
   precondition is met.

```python
#!/usr/bin/env python3
import os, shutil, sys

def main() -> int:
    data_dir = os.environ.get("DATA_DIR") or os.environ.get("NEW_DATA_DIR") or "/mnt/data"
    legacy = os.path.join(data_dir, "myapp", "old-dir")
    current = os.path.join(data_dir, "myapp", "new-dir")
    if not os.path.isdir(legacy):
        print(f"v1→v2: no legacy data at {legacy}; nothing to migrate.")
        return 0
    if os.path.isdir(current) and any(os.scandir(current)):
        # New path already populated — treat as already-migrated.
        print(f"v1→v2: {current} is already populated; leaving {legacy} alone.")
        return 0
    os.makedirs(os.path.dirname(current), exist_ok=True)
    if os.path.exists(current):
        os.rmdir(current)  # empty placeholder
    shutil.move(legacy, current)
    print(f"v1→v2: moved {legacy} → {current}.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

#### Environment available to the script

All of the `post-deploy.py` env (every wizard variable, `HOST`,
`SB_NODE`, `SB_API_URL`, `SB_API_TOKEN`), plus:

- `OLD_SCHEMA_VERSION` / `NEW_SCHEMA_VERSION` — the hop this run
  represents (e.g. `1` / `2` for `v1-to-v2.py`).
- `OLD_DATA_DIR` / `NEW_DATA_DIR` — both default to the operator's
  `DATA_DIR`. The slot exists for future migrations that move data
  between distinct roots; today they're always equal.

#### Audit log

Every migration run (success or failure) is appended to
`config.serviceMigrations[<name>]` with `ranAt`, `fromVersion`,
`toVersion`, `exitCode`, and a `stdoutTail`. Capped at 20 entries
per service, most-recent first. The diagnose page surfaces failed
entries so operators can act on a half-completed upgrade without
trawling install logs.

#### Cross-template data moves

If the migration moves data *out of this template* and into another
(the voice extraction in #348 was this shape), put the move logic
in the **destination** template's `post-deploy.py`, not in this
template's migration. That way:
- The move runs exactly once, when the destination is first
  installed — regardless of whether the operator installs it
  immediately after this template's upgrade or weeks later.
- The source template's migration script stays a simple "voice has
  been extracted; install `voice` for it" notice.

`templates/voice/post-deploy.py` is the canonical example.

## What stays in core

These behaviours live in the engine and **cannot** be moved to a
template script — don't try:

- **NPM admin bootstrap** (`postInstall.ts:bootstrapNpmAdmin`) returns
  a tri-state result that drives the wizard's NPM-credentials prompt
  UI when bootstrap fails. This is the only `isSelected('nginx-web')`
  branch left, and the consistency test allows it.
- **Cross-template proxy-host aggregation** walks `subdomain`-typed
  variables across every selected template and POSTs once to the NPM
  REST API. A per-template script would need to know about every
  other template.
- **Cross-template OIDC client registration** walks
  `variables[].meta.oidcClient` across every selected template and
  POSTs once to `/api/system/authelia/oidc-clients`.
- **The variable-driven OIDC credential entry** in
  `credentialsManifest.ts` derives client_secret entries from
  `oidcClient.clientSecretVar`. Template-agnostic — adding a new OIDC
  client to a template just requires an `oidcClient` block in
  `variables.json`.

## Adding a new template

1. Create `templates/<my-name>/template.yml` with:
   - `metadata.annotations['servicebay.label']: "<friendly name>"`
   - `metadata.annotations['servicebay.ports']: "<port>/<proto>,..."`
   - `metadata.annotations['servicebay.schema-version']: "1"` (bump
     it later when you ship a breaking change; see Migrations above)
2. Create `templates/<my-name>/variables.json` declaring every
   `{{MUSTACHE}}` placeholder you used.
3. Write a one-paragraph `templates/<my-name>/README.md`.
4. (Optional) Add `<config>.mustache` files and the matching
   `servicebay.config-mount` annotation.
5. (Optional) Add `post-deploy.py` if the service needs any seeding,
   credential surfacing, or admin pre-promotion. Add a smoke test
   case to `tests/templates/test_post_deploy.py`.
6. Add a `- [x] <my-name> — <description>` line to whichever
   `stacks/<stack>/README.md` should offer it in the wizard.
7. Run `npm test` — the consistency suite catches the common typos
   (undeclared variables, dangling proxyPort references, missing
   labels, kube manifests that don't render to a valid Pod,
   migration filenames that don't match `v{N}-to-v{M}.py`).

When you later bump the schema-version of an existing template:

1. Bump `servicebay.schema-version` in `template.yml`.
2. Add a `## v{N} (breaking?)` section at the top of `CHANGELOG.md`
   describing what changed and what the operator needs to do. Mark
   it `(breaking)` if it requires manual action.
3. If on-disk data needs to move/transform, add a
   `templates/<name>/migrations/v{N-1}-to-v{N}.py` script. Keep it
   idempotent (probe before mutating).

## Editing or replacing a built-in template

You can freely change `template.yml`, `variables.json`,
`*.mustache`, `README.md`, or `post-deploy.py`. Core code has **no
hardcoded knowledge** of any built-in template name; the consistency
test (`tests/backend/template_consistency.test.ts > stackInstall has
no unauthorized per-template branches`) guards this boundary.

If you find yourself needing to add an `if (templateName === 'foo')`
branch in core, that is the build failure the test produces — please
either extend the script protocol (a new env var, a new
`__SB_*` marker) or document the case in the test's `ALLOWED` list
with a justifying comment.

## External registries

`config.registries[]` accepts git URLs that follow the same on-disk
layout (a `templates/` directory at the repo root). The `registry.ts`
sync clones with `--depth 1 --filter=blob:none --sparse`, then
`sparse-checkout set templates stacks`. External registries override
built-ins with the same name, so you can ship a custom variant of any
bundled template by publishing it under the same directory name.
