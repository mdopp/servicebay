---
title: Create & deploy a new ServiceBay service
whenToUse: You need to build a new service (its own repo/image) and deploy it to the box as a template, optionally behind Authelia SSO on a subdomain.
kind: recipe
tags: [service, template, deploy, subdomain, sso, proxy, image, install]
---

# Create & deploy a new ServiceBay service

A service is a **standalone container** shipped as a **template**, not code inside
this repo's `packages/`. The app lives in its own repo/image; a template deploys
that image and wires ports, mounts, subdomain, SSO, and health.

## Repo & image
- App code + `Dockerfile` + CI live in their **own repo**; CI builds a container
  image (e.g. `ghcr.io/<you>/<name>:latest`). The box must be able to **pull** it
  (public package, or registry credentials configured on the box).
- The **template** references that image; it does not build code.

## Template contract (`template.yml`, kube `Pod`)
Required annotations on `metadata.annotations`:
- `servicebay.label` — friendly name.
- `servicebay.ports` — e.g. `"{{MYAPP_PORT}}/tcp"`.
- `servicebay.schema-version` — `"1"` for a new template.
- `servicebay.dependencies` — comma-separated install-time deps, e.g.
  `"nginx,auth"` when you need the proxy + SSO (add `home-assistant` etc. if you
  mount another service's files).
- `servicebay.healthcheck` — an HTTP/TCP probe; gates install completion.

The pod MUST satisfy one of: `hostNetwork: true` **or** every `containerPort` has
an explicit `hostPort` — otherwise the deploy is silently unreachable. Use
`hostNetwork: true` if the app must reach another on-box service on loopback
(e.g. Home Assistant at `127.0.0.1:8123`).

Path resolution: `{{DATA_DIR}}` renders to **`/mnt/data/stacks`** (per-service
data), while ServiceBay's own data dir is **`/mnt/data/servicebay`** (config,
tokens, and `local-templates`/`local-assists` drop dirs).

## Subdomain + SSO (`variables.json`)
Add a `type: "subdomain"` variable — the install runner turns it into an NPM
proxy host at `<sub>.<PUBLIC_DOMAIN>`:
```json
"MYAPP_SUBDOMAIN": {
  "type": "subdomain",
  "default": "myapp",
  "exposure": "public",
  "proxyPort": "MYAPP_PORT",
  "proxyConfig": { "block_exploits": true, "ssl_forced": true,
                   "advanced_config": "__authelia_forward_auth__" }
}
```
- `advanced_config: "__authelia_forward_auth__"` = the classic Authelia login
  (forward-auth). The app itself needs no login; NPM injects a `Remote-User`
  header — require it in the app to prevent a direct-LAN bypass.
- **The template MUST reference `{{PUBLIC_DOMAIN}}`** somewhere (e.g. an env var),
  or the assembler won't inject it and the proxy host is silently skipped — see
  assist `footgun-subdomain-needs-public-domain`.
- On a **public** forward-auth host, do NOT rely on the sentinel's ACME bypass —
  it collides with NPM's own cert challenge location. See assist
  `footgun-forward-auth-acme-collision`.

## Ordered actions
1. **Bootstrap the repo against the standards catalog** — *before* the stack, the
   CI, the storage engine or the auth design. Call `get_service_standards`
   (flavor `servicebay`), read every id in its `assistsToRead` via
   `get_assist(id)`, and write the pointer block below into the new repo's
   `CLAUDE.md` so the next agent in that repo finds the catalog too:
   `npm run standards:bootstrap -- --write <repo>` (verify with `-- --check <repo>`).
   **If the ServiceBay MCP is not connected in this session, stop and say so** —
   an unconnected session cannot see the ADRs, so its stack/CI/auth choices are
   guesses (#2513: exactly how a sibling repo shipped without SSO awareness,
   without a health endpoint, and with a CI that didn't gate on tests).
2. **Image** — build + push it; confirm the box can `podman pull` it.
3. **Place the template** — push to a template registry, OR drop it under
   `/mnt/data/servicebay/local-templates/templates/<name>/` (survives reinstall,
   no git needed).
4. **Install** — `POST /api/install/assemble` `{items:[{name,checked:true}],
   prefilled:{...}, templateSource:"Local"}` → returns `{items, variables}` →
   `POST /api/install/start` `{source, input:{items, variables, wipeMode:"install",
   templateSource:"Local", host}}` → poll `/api/install/progress?jobId=…` until
   `phase:"done"`. (All accept a `lifecycle`-scoped `sb_` token.)
5. **Verify** — healthcheck 200; `https://<sub>.<PUBLIC_DOMAIN>/` unauthenticated
   returns **302 → auth.<domain>** (Authelia); the app's function works; and a
   request missing `Remote-User` is rejected (no SSO bypass).

## The `CLAUDE.md` standards pointer (step 1, verbatim)

Paste this into the new repo's `CLAUDE.md` — or let the script write it. It is
generated from `packages/backend/src/lib/mcp/serviceRepoBootstrap.ts` and served
by `get_service_standards` as its `repoBootstrap.claudeMdBlock`; the copy below
is kept byte-identical by `npm run check:arch`, so all three can't drift.

```markdown
<!-- BEGIN SERVICEBAY STANDARDS POINTER (generated — do not edit by hand) -->

## Standards: fetch them, never re-derive them

This repo is built for a ServiceBay box, so **ServiceBay's standards catalog is
the binding source of its architecture decisions** — this file only points at it.

1. **Before the first stack, CI, storage, or auth decision**, call the ServiceBay
   MCP tool `get_service_standards(flavor="servicebay")` and fetch every id it
   lists under `assistsToRead` via `get_assist(id)`. Read first, design second —
   a stack chosen before reading is a stack chosen against the ADRs by accident.
2. **Then call `get_service_standards(flavor="generic")` and read every id under
   `workingAgreements`.** They are the cross-repo agreements on how work enters,
   how it is gated, when to ask the operator, and how sessions hand over — they
   are platform-agnostic, so they hang off the *generic* flavor and the
   servicebay index does NOT repeat them. Fetching only one flavor is how a repo
   follows this file exactly and still never hears about them.
   Start with `get_assist("footgun-importing-a-working-agreement-from-another-repo")`:
   the questions and mechanisms port between repos, the thresholds and autonomy
   levels do not.
3. **If the ServiceBay MCP is not connected in this session, stop and say so.**
   An unconnected session cannot see the ADRs, so anything it decides about auth,
   health, storage, or CI is a guess. Connecting it is the first task, not an
   optional extra.
4. **The catalog wins.** Where this file and the catalog disagree, this file is
   the stale one — fix it here, not in your head. The catalog is read from the
   box at runtime, so it can be newer than any release you are running.
5. **Report gaps back.** A missing, ambiguous, or wrong standard is itself a
   finding: file a `standards-gap` issue on `mdopp/servicebay` and propose the
   assist/docs fix. See `get_assist("report-standards-gaps")`.

This block is generated. Regenerate or verify it from a `mdopp/servicebay`
checkout: `npm run standards:bootstrap -- --flavor servicebay --write <repo>` /
`-- --flavor servicebay --check <repo>`.

<!-- END SERVICEBAY STANDARDS POINTER -->
```

## Verify the proxy actually loaded
The install log can say "proxy hosts ensured" while nginx reverted the conf.
Check the host is really live: read NPM's DB `proxy_host.meta.nginx_online` /
`nginx_err` (open the sqlite `?mode=ro`, **not** `immutable=1` — that ignores the
WAL and shows a stale snapshot). A public host with no rendered `.conf` answers
with an SSL connect error (000).

## Reference material
- Assist `new-service-architecture` — recommended language/structure/libraries/
  tests/storage/secrets before you design. Assists `servicebay-overview` +
  `solaris-overview` — what the platforms are.
- Assist `service-ui-design-standard` — if the service has a frontend, adopt
  ServiceBay's design tokens (palette/accent, radii, typography, spacing) + the
  UX baseline (styled large file picker, streaming progress, responsive/mobile,
  focus states) so it looks and behaves like ServiceBay. Its companion
  `service-ui-user-language` covers what the UI *says* — state texts in the
  user's language, no CLI/env/header names in rendered HTML.
- `docs/TEMPLATE_AUTHORING.md`, `templates/CLAUDE.md` — the full template contract.
- Worked examples in-repo: `templates/file-share/` (forward-auth), `templates/vaultwarden/` (OIDC).
