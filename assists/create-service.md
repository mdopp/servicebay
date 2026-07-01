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
1. **Image** — build + push it; confirm the box can `podman pull` it.
2. **Place the template** — push to a template registry, OR drop it under
   `/mnt/data/servicebay/local-templates/templates/<name>/` (survives reinstall,
   no git needed).
3. **Install** — `POST /api/install/assemble` `{items:[{name,checked:true}],
   prefilled:{...}, templateSource:"Local"}` → returns `{items, variables}` →
   `POST /api/install/start` `{source, input:{items, variables, wipeMode:"install",
   templateSource:"Local", host}}` → poll `/api/install/progress?jobId=…` until
   `phase:"done"`. (All accept a `lifecycle`-scoped `sb_` token.)
4. **Verify** — healthcheck 200; `https://<sub>.<PUBLIC_DOMAIN>/` unauthenticated
   returns **302 → auth.<domain>** (Authelia); the app's function works; and a
   request missing `Remote-User` is rejected (no SSO bypass).

## Verify the proxy actually loaded
The install log can say "proxy hosts ensured" while nginx reverted the conf.
Check the host is really live: read NPM's DB `proxy_host.meta.nginx_online` /
`nginx_err` (open the sqlite `?mode=ro`, **not** `immutable=1` — that ignores the
WAL and shows a stale snapshot). A public host with no rendered `.conf` answers
with an SSL connect error (000).

## Reference material
- `docs/TEMPLATE_AUTHORING.md`, `templates/CLAUDE.md` — the full template contract.
- Worked examples in-repo: `templates/file-share/` (forward-auth), `templates/vaultwarden/` (OIDC).
