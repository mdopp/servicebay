---
title: ServiceBay — structure & capabilities (orientation)
whenToUse: You (a client/agent) need to understand what ServiceBay is, how it's structured, and what it can do — before authoring a service, driving the MCP, or answering questions about the platform.
kind: guide
tags: [servicebay, overview, architecture, platform, mcp, templates, orientation]
---

# ServiceBay — what it is and what it can do

ServiceBay is the **control plane for a self-hosted home box**: it installs and
manages containerized services on a single node (Fedora CoreOS + rootless
Podman), fronts them with a reverse proxy + SSO, and keeps them healthy and
backed up. Think "a private, opinionated PaaS for one household server."

## Structure
- **Control-plane app** — `packages/{frontend,backend,api-client}` (Node/React/
  TypeScript), built into one image. The wizard/portal + REST API + the MCP
  server live here. This is NOT where services' code lives.
- **Services = templates** — `templates/<name>/` (a Podman kube `Pod` +
  `variables.json` + README, optional `post-deploy.py`, migrations, mustache
  configs). `stacks/<name>/` bundle templates. Contract: `docs/TEMPLATE_AUTHORING.md`,
  `templates/CLAUDE.md`.
- **Registries** — services come from built-in `templates/`, external git
  registries, or a `DATA_DIR/local-templates/` drop (precedence: Local > registry
  > built-in). `packages/backend/src/lib/registry.ts`.
- **On-disk layout** — per-service data at `/mnt/data/stacks/<name>/` (this is
  what `{{DATA_DIR}}` renders to); ServiceBay's own config/tokens at
  `/mnt/data/servicebay/`.

## Core capabilities
- **Install / reconcile** — a wizard-driven runner assembles a manifest
  (`/api/install/assemble`) and deploys it (`/api/install/start`) as Quadlet
  `.kube` units (`podman kube play`), wiring proxy hosts, SSO, certs, health,
  and running post-deploy hooks. Redeploy is idempotent reconciliation, never a
  wipe (ADR 0004, 0009).
- **Reverse proxy + SSO** — Nginx Proxy Manager publishes `<sub>.<PUBLIC_DOMAIN>`
  with Let's Encrypt certs; Authelia provides forward-auth (classic login) and
  OIDC. Every user-facing service authenticates (ADR 0001, 0006).
- **Identity** — LLDAP for users/groups; Authelia sessions; per-service tokens
  with scopes (ADR 0009-service-tokens).
- **Health & diagnose** — continuous health probes + a diagnose battery with
  self-heal; the portal surfaces service state.
- **Backup & restore** — tiered: critical config/state → NAS, bulk media →
  secondary drive (ADR 0002); full system restore supported.
- **DNS** — AdGuard as LAN DNS via the router (Pattern A, ADR 0005);
  split-horizon `*.<domain>` → box.
- **TUI + installer** — a Go/Bubble Tea TUI for the setup journey + stack
  desired-state editing (ADR 0008); FCoS USB install/reinstall flow.
- **MCP surface** — an agent can drive the box over `/mcp` with a scoped `sb_`
  token: read state, logs, health, templates; deploy/rename/delete services;
  manage proxy routes, health checks, backups; `exec_command` / `container_exec`;
  and discover help via `list_assists` / `get_assist`. Scopes: `read` <
  `lifecycle` < `mutate` < `reboot` < `destroy`, plus `exec`.

## Key decisions (see `docs/adr/`)
SSO-everywhere (0001), tiered backup (0002), release-please-only (0003),
non-destructive installs (0004), DNS Pattern A (0005), apex-deny (0006), network
isolation with carve-outs (0007), desired-state TUI (0008), repair =
reconciliation (0009), service tokens & trust (0009-service-tokens).

## Related assists
`solaris-overview` (the household-AI tier on top), `create-service` (build +
deploy a new service), `new-service-architecture` (recommended decisions).
