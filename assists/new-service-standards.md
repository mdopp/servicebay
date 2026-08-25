---
title: ServiceBay service-standards index — what a new service must respect
whenToUse: You're starting a new ServiceBay service and need the curated pointer index — which platform ADRs to respect, the enforced invariants + gate commands, which assists to read in full, and where the template contract lives.
kind: checklist
tags: [standards, new-service, adr, invariants, template-contract, index, servicebay]
---

# ServiceBay service-standards index

A curated *pointer* index (not the full text) for building a new ServiceBay
service. Fetch the referenced assists in full via `get_assist(id)`, and read the
referenced `docs/` files directly. The `get_service_standards` MCP tool
(`flavor: 'servicebay'`) assembles a live version of this index — the ADRs are
read from the assist catalog at runtime, so their titles never drift and every
pointer is one you can actually follow with `get_assist(id)`.

## repoBootstrap — step 1, before any stack/CI/storage/auth choice

A standard nobody consults is not a standard. So the first step of building a
service repo is consulting this catalog, and the new repo carries the pointer
back to it **from its first commit** (#2513):

- Call `get_service_standards` (flavor `servicebay`) and read every id it lists
  under `assistsToRead` via `get_assist(id)` **before** picking a stack, a CI
  shape, a storage engine, or an auth design.
- Write the generated pointer block into the new repo's `CLAUDE.md`:
  `npm run standards:bootstrap -- --write <repo>`; verify with `-- --check <repo>`
  (exit 1 when the pointer is missing or has drifted). The block itself is the
  `repoBootstrap.claudeMdBlock` field of the tool's output and is reproduced
  verbatim in the `create-service` recipe.
- **If the ServiceBay MCP is not connected, stop and say so.** A session that
  cannot reach the catalog cannot make these decisions; connecting it is the
  first task, not an optional extra.

## mustRespectAdrs — the platform decisions a new service is bound by

A new service does not get to re-litigate these. Read the one-liner, then the
full ADR at the given path when it touches your service.

- **0001** — every user-facing service authenticates via Authelia SSO (or at
  minimum LDAP against LLDAP). `assists/adr-0001-authentication-via-authelia-sso-or-lldap.md`
- **0003** — versioning and releases go through release-please only; never
  hand-bump a version, keep commit subjects parser-clean.
  `assists/adr-0003-releases-via-release-please-only.md`
- **0004** — installs/redeploys are non-destructive; they never wipe other
  services. `assists/adr-0004-installs-are-non-destructive.md`
- **0007** — app containers run in an isolated netns; only named carve-outs stay
  on host networking. `assists/adr-0007-container-network-isolation-and-carveouts.md`
- **0009** — the token & trust model between services (scoped, short-lived
  grants; no ambient authority). `assists/adr-0009-service-tokens-and-trust.md`
- **0010** — the Node runtime tracks the Node 20 line, kept consistent across
  all sources. `assists/adr-0010-node-20-minor-floats.md`

## enforcedInvariants — mechanically checked, run the gates

The full list lives in `docs/ARCHITECTURE_INVARIANTS.md`. They are enforced by
scripts, not prose, so run the gates before an architecture change and before
opening a PR:

- `npm run check:arch` — architecture invariants + dependency-cruiser.
- `npm run lint` — zero errors; don't raise the warning count.
- Diff-coverage floor: **70 %** on changed lines.

## assistsToRead — fetch these in full via `get_assist(id)`

- `new-service-architecture` — recommended defaults (language, structure,
  libraries, tests, storage, secrets) plus the ADRs a new service must respect.
- `create-service` — the concrete recipe to build and deploy a service repo
  behind SSO.
- `servicebay-overview` — what the platform is and how the pieces fit together.
- If the service has a UI: `service-ui-design-standard` (how it looks) **and**
  `service-ui-user-language` (what it says — state texts in the user's language,
  no CLI/env/header names in rendered HTML).
- Footguns to skim: `footgun-forward-auth-acme-collision`,
  `footgun-subdomain-needs-public-domain`.

Read `whenToUse` on each (via `list_assists`) to self-select, then
`get_assist(id)` for the full body.

## templateContract — where the template rules live

Services ship as **templates**, not code. The contract:

- `docs/TEMPLATE_AUTHORING.md` — how to author a template (variables, secrets,
  kube pod shape).
- `templates/CLAUDE.md` — the template contract that auto-loads under
  `templates/`.
