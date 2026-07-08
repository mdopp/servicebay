# ServiceBay — Features worth bragging about

The shop window. One line per capability, grouped by what it does *for you*,
with a link into the detail doc for the "how". Everything here is true against
the code — no roadmap items, no "coming soon".

New here? Start with the [README](../README.md) for the product pitch; this file
is the feature index. Each group below has a detail doc under
[`docs/features/`](features/).

---

## Es heilt sich selbst — it heals itself

The box recovers from the failure classes that normally mean a support ticket
or a wiped install. → **[features/self-heal.md](features/self-heal.md)**

- **Silent credential rekey.** Wipe the secrets group on a clean install and the
  service admin passwords re-sync *in place* — LLDAP, NPM, AdGuard, Immich,
  Audiobookshelf, Honcho's Postgres role — no crash-loop, no lockout, no
  re-typing. ([coverage matrix](CREDENTIAL_SELF_HEAL.md))
- **Its own crash leaves a readable trace.** When `servicebay.service` exit-loops
  and the UI goes dark, a host-side systemd hook drops `last-crash.json` *outside*
  the container — exit code, cause, journal tail — so the death isn't invisible.
- **GPU survives every redeploy.** GPU passthrough is declared through CDI; a host
  without a registered NVIDIA GPU fails fast at unit start rather than silently
  falling back to CPU. No "why is transcoding slow now?" after an update.

## Diagnose, die repariert — diagnostics that fix

Not a stack trace — a structured probe with a one-click action attached.
→ **[features/diagnose.md](features/diagnose.md)**

- **26 probes, each with typed `actions[]`.** SSO, TLS certs, DNS routing, dangling
  proxy routes, crash loops, disk pressure — caught and surfaced with a labelled
  fix button (Renew now · Restart auth · Delete route), not a wall of jargon.
- **SSO/cert/DNS/proxy caught before the family notices.** SSO is re-verified
  automatically after every auth install; cert expiry, DNS mis-routing and
  dead proxy hosts are continuously probed.
- **Destructive recovery always goes through the wizard** — a misread probe can't
  one-click a `rm -rf`.

## Lebende Netzwerkkarte — a living network map

Internet → Gateway → Service, rendered from what's *actually* running.
→ **[features/network-map.md](features/network-map.md)**

- **Edges from five sources.** nginx proxy routes, gateway port-forwards, declared
  template dependencies, observed live TCP flows, and edges *inferred from container
  env vars* (a service pointing at `http://host:port` in its config).
- **No service floats disconnected.** Anything still edge-less after all sources gets
  a fallback anchor to the host root — every card is reachable in the graph.
- **Ego-focus drill-down.** Click a service to collapse the map to its
  neighbourhood plus the Internet→service path.
- Rendered with **ELK layered layout + React Flow** custom orthogonal edges.

## SSO ohne Handarbeit — single sign-on with no hand-wiring

Deploy a service, get SSO. → **[features/sso.md](features/sso.md)**

- **OIDC client self-registers on deploy.** A template's `oidcClient` block is
  collected and POSTed to Authelia automatically — no console, no config edit.
- **Redeploy auth without breaking everyone.** Re-rendering the auth config merges
  back every stack's existing OIDC client (secret preserved) instead of dropping
  them — the old full-SSO-outage foot-gun is closed.
- **Family portal with self-service access requests.** Relatives request access from
  the portal; one admin click provisions the LLDAP account.

## Backup, das eine Neuinstallation übersteht — backup that survives a reinstall

Reinstall the box, get your config back. → **[features/backup.md](features/backup.md)**

- **Per-service manifest on the NAS.** Each service declares exactly which config
  paths to keep and which bulk data to skip.
- **Reinstall pulls config back.** Auto-restore re-seeds each service's config from
  the NAS before its pod starts — no re-typing passwords, no rebuilding dashboards.
- **Secrets stripped from archives.** Manifest strip-rules drop re-enterable secrets
  (LLM API keys, …) from the backup before it lands on the NAS.

## Von einem Agenten steuerbar — drivable by an agent

The whole control plane is an MCP surface. → **[features/mcp.md](features/mcp.md)**

- **62 scoped MCP tools** — deploy a template, create a proxy route, run a backup,
  and a jailed `write_file` confined to the data dir. ([setup guide](MCP.md))
- **Scoped, revocable tokens** — `read` / `lifecycle` / `mutate` / `destroy`,
  hashed at rest, with an `exec_command` denylist and auto-snapshot before
  destructive ops.
- **Time-limited token request/approve flow.** A narrow-scoped caller *requests* a
  token; an admin approves (only ever narrowing scope), and it's minted with a
  capped TTL. Least privilege by default.

## Erweitern ohne Code — extend without code

Every installable service is data, not code. → **[features/extensibility.md](features/extensibility.md)**

- **Templates are Git repos.** A `template.yml` (Pod manifest) + `variables.json` +
  optional Mustache config + Python `post-deploy.py`. Point ServiceBay at a repo
  and it shows up in the wizard. ([authoring guide](TEMPLATE_AUTHORING.md))
- **Templates evolve on live installs.** Bump `schema-version`, ship a
  `migrations/v{N-1}-to-v{N}.py`, and the engine walks the chain — fail-fast so a
  half-migration never boots on the new container.
- **Core has no per-template branches** — a CI test enforces the boundary.

## Shipped wie ein Produkt — shipped like a product

A broken build never becomes `:latest`. → **[features/shipped.md](features/shipped.md)**

- **Release-image smoke gate + lockfile CI gate + local typecheck gate.** The real
  release image is built and probed; `npm ci` lockfile drift fails CI; `tsc
  --noEmit` runs on every unit.
- **Box-verify on `:dev` gates the release.** Any change to a boot-critical path is
  verified against a real Fedora CoreOS box on the `:dev` channel *before* the
  `:latest` release PR is allowed to merge.
- **CI-enforced architecture invariants** — file size, module boundaries, security
  budgets. "All green" is a real answer. ([invariants](ARCHITECTURE_INVARIANTS.md))
