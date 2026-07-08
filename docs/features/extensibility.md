# Extend without code

[← back to FEATURES](../FEATURES.md)

Every installable service in ServiceBay is a **template** — a self-contained
directory of data, not core code. You can add, edit, or remove a service without
touching ServiceBay itself, and a template can evolve on a running install without
breaking it. The full on-disk contract is
[docs/TEMPLATE_AUTHORING.md](../TEMPLATE_AUTHORING.md); this page is the *why* and
the shape.

## Templates are Git repos

**What it does.** A template is a directory:

```
templates/<name>/
├── template.yml       # required — kube Pod manifest with {{MUSTACHE}} placeholders
├── variables.json     # required — variable schema (text/password/secret/subdomain/oidcClient/…)
├── README.md          # required — wizard description
├── post-deploy.py     # optional — host-side glue after the unit starts
├── migrations/        # optional — schema-version migration scripts
└── *.mustache         # optional — companion config files, rendered with the user's vars
```

Point ServiceBay at a Git repo that follows this layout (Settings → template
registries; `config.registries[]`) and its templates show up in the install
wizard **with the same SSO + DNS + reverse-proxy + auto-backup wiring** as the
built-ins. The registry sync clones sparsely
(`--depth 1 --filter=blob:none --sparse`) and overrides built-ins of the same
name, so you can ship a custom variant of any bundled template.

**Why it exists.** A homelab manager that only runs the services its authors
shipped isn't a platform. Making the catalog data means a contributor can add
Paperless-ngx (or fork Vaultwarden's template) without a ServiceBay release — and
an LLM can author one through the same MCP path (`install_template`).

**What you get for free** (no per-template code):

- `subdomain`-typed variables register an NPM proxy host.
- `oidcClient` blocks register an Authelia OIDC client ([SSO](sso.md)).
- `password` / `secret` / `bcrypt` / `rsa-private` variables are auto-generated.
- A `service`-type health check is created automatically on deploy.

## Templates evolve on live installs

**What it does.** When a template's structure changes (a container split out, a
variable renamed, data moved), it declares a new `servicebay.schema-version` and
ships a migration so existing installs upgrade cleanly.

**How it works.**

- Bump `servicebay.schema-version` in `template.yml`.
- Add a `## v{N}` section to `CHANGELOG.md` — the wizard surfaces every section
  between the operator's deployed version and the template's current version, and
  gates the deploy on an acknowledgement checkbox for `(breaking)` sections.
- Drop `migrations/v{N-1}-to-v{N}.py` — one file per one-step hop; the engine
  walks the chain in order for a box that's several versions behind.

Migrations are **fail-fast and idempotent by contract**: a non-zero exit aborts
the deploy *before* the new YAML lands (the existing service keeps running), so a
half-completed data migration never boots on the new container. Every run is
recorded to `config.serviceMigrations[<name>]` and failed runs surface in
diagnose.

> Any `schema-version` bump — even a config-only one — needs its migration file, or
> the runner aborts every redeploy ("migration chain incomplete"). This is enforced,
> not advisory.

## Core has no per-template branches

**What it does.** ServiceBay's engine has **no hardcoded knowledge** of any
built-in template name. The one allowed exception (the NPM-credentials tri-state
prompt) is explicitly listed in a consistency test.

**How it works.** `tests/backend/template_consistency.test.ts` fails the build if a
new `if (templateName === 'foo')` branch appears in the install engine. Need
per-service behaviour? Extend the *protocol* (a new env var, a new `__SB_*`
marker, a `post-deploy.py` step) — not core. This boundary is the reason external
templates get the same treatment as bundled ones.

## Related

- [TEMPLATE_AUTHORING.md](../TEMPLATE_AUTHORING.md) — the authoritative contract:
  annotations, variable types, SSO wiring, migrations, external registries.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — the three first-PR extension points (MCP
  tool, capability handler, diagnose probe).
- [SSO](sso.md) — the zero-click OIDC wiring a template opts into.
