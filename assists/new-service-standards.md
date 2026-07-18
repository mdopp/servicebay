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
(`flavor: 'servicebay'`) assembles a live version of this index — the ADR
one-liners are scanned from `docs/adr/*.md` titles at runtime so they never
drift from the source.

## mustRespectAdrs — the platform decisions a new service is bound by

A new service does not get to re-litigate these. Read the one-liner, then the
full ADR at the given path when it touches your service.

- **0001** — every user-facing service authenticates via Authelia SSO (or at
  minimum LDAP against LLDAP). `docs/adr/0001-authentication-via-authelia-sso-or-lldap.md`
- **0003** — versioning and releases go through release-please only; never
  hand-bump a version, keep commit subjects parser-clean.
  `docs/adr/0003-releases-via-release-please-only.md`
- **0004** — installs/redeploys are non-destructive; they never wipe other
  services. `docs/adr/0004-installs-are-non-destructive.md`
- **0007** — app containers run in an isolated netns; only named carve-outs stay
  on host networking. `docs/adr/0007-container-network-isolation-and-carveouts.md`
- **0009** — the token & trust model between services (scoped, short-lived
  grants; no ambient authority). `docs/adr/0009-service-tokens-and-trust.md`
- **0010** — the Node runtime tracks the Node 20 line, kept consistent across
  all sources. `docs/adr/0010-node-20-minor-floats.md`

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
