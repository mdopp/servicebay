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

**Isolated netns + an explicit `hostPort` on every published `containerPort`** —
a pod with neither that nor host networking is silently unreachable.
`hostNetwork: true` is reserved for the **closed, named** carve-out list in ADR
0007 Decision 2; a new service does not join it by arguing its case.

Needing to reach a loopback-bound sibling on the box is explicitly **not** a
carve-out (ADR 0007 Decision 3): the consumer stays isolated and addresses the
sibling as `http://host.containers.internal:<port>` — never `127.0.0.1`, never
`{{LAN_IP}}` — while the *sibling's* port variable carries `blockLanAccess: true`
so its wider bind stays off the LAN. Siblings first, consumer second. Full rule:
assist `adr-0007-container-network-isolation-and-carveouts`.

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
   `get_assist(id)`, then paste the block it hands back as
   **`repoBootstrap.claudeMdBlock`** into the new repo's `CLAUDE.md` so the next
   agent in that repo finds the catalog too. That field *is* the finished text —
   this recipe deliberately does not carry a second copy of it. (From a
   `mdopp/servicebay` checkout the same block is written by
   `npm run standards:bootstrap -- --write <repo>`, verified with `-- --check <repo>`.)
   **If the ServiceBay MCP is not connected in this session, stop and say so** —
   an unconnected session cannot see the ADRs, so its stack/CI/auth choices are
   guesses (#2513: exactly how a sibling repo shipped without SSO awareness,
   without a health endpoint, and with a CI that didn't gate on tests).
2. **Image** — build + push it; confirm the box can `podman pull` it.
3. **Place the template** — push to a template registry, OR write each file under
   `/mnt/data/servicebay/local-templates/templates/<name>/` (survives reinstall,
   no git needed). One `write_file` per file: it is jailed to `/mnt/data`,
   creates the parent dir, and sets `core:core` ownership so the install runner
   can read what you dropped. Check the result with `list_dir`.
4. **Install** — `install_template` `{names:["<name>"], templateSource:"Local",
   variables:{…}}` returns a `jobId`; then poll `get_install_progress`
   `{jobId, logsSince:<previous logsOffset>}` until `phase:"done"` (`error` /
   `needs_credentials` are the other outcomes to handle). This is the whole
   wizard flow — variable assembly, secret generation, subdomain→NPM proxy host,
   Authelia wiring, dependency ordering, migrations — not the raw-YAML
   `deploy_service` shortcut. Confirm the pod with `list_containers`, and read
   `get_logs` on the new container if it isn't up.
5. **Verify** — healthcheck 200; `https://<sub>.<PUBLIC_DOMAIN>/` unauthenticated
   returns **302 → auth.<domain>** (Authelia); the app's function works; and a
   request missing `Remote-User` is rejected (no SSO bypass).

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
