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
├── skills/                  # optional — asset files shipped verbatim to the node
└── *.mustache               # optional — companion config files
```

## Asset dirs (`skills/`) — adding, changing and REMOVING a file

Everything under `templates/<name>/skills/` is shipped verbatim (no
Mustache rendering) to `{{DATA_DIR}}/<name>/skills/<relpath>` on the node.

**Deleting the file from the source tree really deletes it from the node**
(#2703) — before that fix a retired skill kept declaring its command on
every box forever, because the transport had no deletion concept at all.
How it deletes is the part you need to know:

- ServiceBay deletes **only paths it recorded delivering itself**, from a
  per-service delivered-files manifest. It never mirrors the directory, so
  a file the running app created next to your assets (a database, a token,
  a resident's notes) is not a delete candidate. There is no "keep this"
  exclusion list, and you must not need one.
- **The first deploy after this shipped only records.** Files an older
  deploy orphaned on a box stay there until an operator removes them by
  hand; only files delivered from that deploy onward can be pruned.
- Seed-only configs (`servicebay.seed-only-configs`) are never recorded and
  never pruned — that content belongs to the app or the operator.

So: retire a skill by deleting it, not by shipping an empty "tombstone"
file. A tombstone is still a delivered file, and anything that lists the
asset dir would go on offering something that does nothing.

## Mandatory annotations on `template.yml`

```yaml
metadata:
  annotations:
    servicebay.label: "Friendly name"
    servicebay.ports: "8080/tcp"
    servicebay.schema-version: "1"     # bump on every breaking change
    # servicebay.min-upgradable-schema-version: "1"  # oldest version an
    #   upgrade may START from. Default 1. Raise it only when a historic hop
    #   in migrations/ is missing and cannot be reconstructed (#2727).
    # servicebay.config-mount: "/config"   # required iff *.mustache files exist
    # servicebay.seed-only-configs: "automations.yaml"  # *.mustache files the app
    #   or the operator owns after first install — written ONLY when absent, so a
    #   redeploy never overwrites what they put there (#2590)
    # servicebay.tier: "infrastructure"    # auto-include + lock checked
    # servicebay.dependencies: "nginx,auth" # comma-separated install-time deps
    # servicebay.healthcheck: |             # continuous health probe (#626/#628)
    #   url: http://localhost:8080/healthz  # — required if another template
    #   interval: 30s                       # depends on yours
    #   timeout: 5s
    #   startup_timeout: 5m
```

## Healthcheck (#626 + #628)

Declare `servicebay.healthcheck` for any template another template lists in its
`servicebay.dependencies`. The install runner's settleWait blocks until
`twin.services[].health.ready === true`, populated by ServiceBay's poller from
this annotation. Downstream templates' post-deploys can then assume the
dependency is actually responsive.

Probe kinds:

| `kind`   | Required fields  | Notes                                                                              |
|----------|------------------|------------------------------------------------------------------------------------|
| `http`   | `url`            | Default. Treats 2xx as success; parses optional JSON body `{ready, degraded?, deps?, message?}`. |
| `tcp`    | `host`, `port`   | Raw socket-connect. Use for non-HTTP services (Wyoming protocol, Samba).           |

Other fields: `interval` (default 30s, ≥ 1s), `timeout` (default 5s),
`startup_timeout` (default 5m — interpretation only; the poller starts firing
immediately).

Examples in this repo: `templates/auth/template.yml` (HTTP),
`templates/claude-dev/template.yml` (TCP).

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

- Containers extracted into a separate template
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

**The chain must be unbroken (#2727).** `selectMigrationChain` walks one
version at a time and *refuses* the deploy on a hop with no script — it does
not skip it. So a missing `v{N-1}-to-v{N}.py` makes the template undeployable
for every box below the hole. `servicebay.min-upgradable-schema-version`
(default `1`) declares the oldest version an upgrade may start from; a
build-time test proves the chain is walkable from there to `schema-version`,
and fails if a migration script sits *below* the floor — such a script can
never run, so it is deleted rather than kept. A box below the floor is
refused before the first step, with a message naming the template, its
recorded version and the minimum. Raise the floor only when a historic hop
cannot be reconstructed (`media` declares `"3"`, `home-assistant` `"6"`);
lower it by shipping the missing hops, informational no-ops included.

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

Both script types share one body contract: the file ships to the box
**verbatim** (never Mustache-rendered — #2415, #2435), so `{{VAR}}` in a
script is prose. Read values from `os.environ`; Go-template/Jinja/Helm
`{{…}}` and f-string brace escapes are safe to write.

### Cross-template data moves

If data is moving *into* a different template (a container split out
into a sibling template), put the move in the **destination**
template's `post-deploy.py`, not in the source template's migration.
That way the move runs exactly once when the destination is first
installed, regardless of install ordering. The source template's
migration script then just informs the operator.

Pattern:
- The source template's `migrations/v{N-1}-to-v{N}.py` stays an
  informational notice (the feature moved; install `<dest>` for it).
  `templates/beets/migrations/v2-to-v3.py` is one such notice.
- The destination template's `post-deploy.py` does the actual
  idempotent `shutil.move(legacy → new)` (probe-before-mutate).

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
7. **No literal secrets.** Express every credential as a `type: "secret"`
   variable — the wizard generates/injects the value at deploy. Never put a
   real key/token/password in `template.yml`, `variables.json` defaults, or a
   `*.mustache`; `{{VAR}}` placeholders only. A build-time scan
   (`tests/backend/assist_consistency.test.ts`) fails on known secret shapes.

## Architecture recommendations for a new service

Before designing a new service, read the ADR-style recommendations assist
**`new-service-architecture`** (via `list_assists` / `get_assist`, or
`assists/new-service-architecture.md`): recommended language, basic structure,
libraries, tests, data storage, and secrets — plus the platform ADRs, which are
catalog entries themselves (`list_assists(kind="adr")`, ids `adr-NNNN-<slug>`),
that a new service must respect (SSO, non-destructive installs,
reconciliation, network isolation, backup tiering, service tokens). Orientation
on the platforms themselves is in the `servicebay-overview` and `solaris-overview`
assists.

## Reusable know-how → assists

If, while authoring a template, you work out a non-trivial recipe or hit a
sharp-edged gotcha that others will meet again, capture it as an **assist**
(`assists/<id>.md`, surfaced by the `list_assists` / `get_assist` MCP tools) —
abstracted, with no box-specific values or secrets. See the root `CLAUDE.md`
("Capturing reusable knowledge").
