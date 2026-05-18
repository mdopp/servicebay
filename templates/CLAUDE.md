# Template authoring — quick reference for assistants

Full contract: [../docs/TEMPLATE_AUTHORING.md](../docs/TEMPLATE_AUTHORING.md).
This file is the short version that auto-loads whenever you're working
in `templates/`, so a fresh assistant generating a new template
doesn't miss the versioning + migration machinery.

## Layout

```
templates/<name>/
├── template.yml             # required — kube Pod with {{MUSTACHE}} placeholders
├── variables.json           # required — variable schema
├── README.md                # required — short description
├── CHANGELOG.md             # recommended once schema-version ≥ 2
├── post-deploy.py           # optional — runs on the host after the unit starts
├── migrations/              # required once schema-version ≥ 2 AND data moves
│   └── v{N-1}-to-v{N}.py    # one file per single-step hop, idempotent
└── *.mustache               # optional — companion config files
```

## Mandatory annotations on `template.yml`

```yaml
metadata:
  annotations:
    servicebay.label: "Friendly name"
    servicebay.ports: "8080/tcp"
    servicebay.schema-version: "1"     # bump on every breaking change
    # servicebay.config-mount: "/config"   # required iff *.mustache files exist
    # servicebay.tier: "infrastructure"    # auto-include + lock checked
    # servicebay.dependencies: "nginx,auth" # comma-separated install-time deps
    # servicebay.readiness: |              # readiness probes (#613) — required
    #   - kind: http                       # if another template depends on yours
    #     url: http://localhost:8080/health
    #     expect_status: 200
    #     timeout: 60s
```

## Readiness probes (#613)

Declare `servicebay.readiness` for any template another template lists in its
`servicebay.dependencies`. The install runner blocks on these probes between
`systemctl start` and `post-deploy.py` — downstream templates' post-deploys
can then assume the dependency is actually responsive.

Probe kinds:

| `kind`    | Required fields              | Notes                                            |
|-----------|------------------------------|--------------------------------------------------|
| `http`    | `url`                        | `method` (GET/POST), `body`, `expect_status` (single int, `[lo, hi]`, or `"any"`). Default = `2xx–4xx`. |
| `tcp`     | `host`, `port`               | Connect-only — succeeds as soon as the listener accepts. |
| `ldap`    | `host`, `port`               | Optional `bind_dn` + `bind_password` to verify auth, not just port. |
| `command` | `command` (+ `container`)    | Shell-exec on the install node. Use for SQLite migrations / file-presence checks. Default `expect_exit: 0`. |

Every probe takes `timeout` (default `60s`, accepts `Ns`, `Nm`, `Nms`, or bare-number seconds).
The runner polls in parallel with a heartbeat every 15s — a probe deadline
lapsing aborts the deploy *before* `post-deploy.py` runs.

Migration tip when replacing in-script `wait_for_*` helpers: pick the same
endpoint/status the helper polled. Examples in this repo: `templates/auth/`,
`templates/file-share/`, `templates/media/`.

`servicebay.dependencies` is the single source of truth for hard install-time
dependencies. The wizard reads it to auto-check missing deps, block unchecking
a dep that something else needs, and topo-sort the deploy loop. Declare it
when your post-deploy talks to another template's API (e.g. registering an
OIDC client in Authelia) or when your subdomain is served via NPM. Example:
`servicebay.dependencies: "nginx,auth"` for anything that needs both proxy +
SSO at install time. No annotation = no install-time deps.

`servicebay.schema-version` defaults to `1` when missing — fine for
new templates. Bump it whenever the pod structure or variable shape
changes in a way the operator needs to know about:

- Containers extracted into a separate template (the voice/HA split in #348)
- Variables renamed
- Data paths moved on disk
- A new required mount that won't be auto-created

Plain image-tag bumps don't need a schema bump — Quadlet's
`AutoUpdate=registry` handles those transparently.

## Versioning workflow

When a template needs to evolve:

1. Bump `servicebay.schema-version` in `template.yml`.
2. Add a `## v{N}` section at the top of `CHANGELOG.md`, marked
   `(breaking)` if it needs operator action. The wizard surfaces
   every section between the operator's installed version and the
   template's current version, and gates the deploy on
   acknowledgement for every breaking section.
3. If on-disk data needs to move/transform, add
   `migrations/v{N-1}-to-v{N}.py`. Idempotent by contract — probe
   before mutating. Non-zero exit aborts the deploy (fail-fast).

## Migration script protocol

Same shell setup as `post-deploy.py` (env file → `source` →
`python3`, stdout streamed live), with two key differences:

1. **Fail-fast.** Non-zero exit aborts the deploy *before* the new
   yaml lands. Better to fail loudly than to deploy a new container
   onto un-migrated data.
2. **Idempotent.** Migrations re-run on every deploy until the
   version stamp is updated — always check the on-disk state
   before transforming it.

Extra env vars beyond what `post-deploy.py` gets:
- `OLD_SCHEMA_VERSION` / `NEW_SCHEMA_VERSION` — the hop this run
  represents (e.g. `1` / `2` for `v1-to-v2.py`).
- `OLD_DATA_DIR` / `NEW_DATA_DIR` — both default to `DATA_DIR`.

### Cross-template data moves

If data is moving *into* a different template (the voice extraction
case), put the move in the **destination** template's
`post-deploy.py`, not in the source template's migration. That way
the move runs exactly once when the destination is first installed,
regardless of install ordering. The source template's migration
script then just informs the operator.

Worked examples in this repo:
- `templates/home-assistant/migrations/v1-to-v2.py` — informational
  notice (voice was extracted; install the `voice` template).
- `templates/voice/post-deploy.py` — actual idempotent
  `shutil.move(legacy → new)` for the voice data.

## Audit log

Every migration run is appended to
`config.serviceMigrations[<name>]` with `ranAt`, `fromVersion`,
`toVersion`, `exitCode`, and a `stdoutTail`. Capped at 20 entries
per service. The diagnose page surfaces failures.

## Checklist before submitting a new template or schema bump

1. `template.yml` has all four annotations (`label`, `ports`,
   `schema-version`, plus `config-mount` if you ship `*.mustache`).
2. Every `{{VAR}}` placeholder is declared in `variables.json`.
3. `README.md` describes what the service does in one paragraph.
4. If `schema-version ≥ 2`: `CHANGELOG.md` has matching sections.
5. If data moves: matching `migrations/v{N-1}-to-v{N}.py` exists
   and is idempotent. Run `python3 -m py_compile templates/<name>/migrations/*.py`.
6. `npm test` passes — the consistency suite catches typos,
   dangling references, and bad migration filenames at build time.
