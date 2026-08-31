# Architecture Decision Records (ADRs) — moved to the assist catalog

**The ADRs now live in [`assists/`](../../assists/), not here.** One copy, one
place (#2607). This directory is kept only as a set of signposts so that links
from older PRs, issues and code comments keep resolving.

Why they moved: an agent working over MCP sees the **assist catalog**
(`list_assists` / `get_assist` / the `assist://` resources), not the repository.
While the decisions sat under `docs/adr/` they were, at best, half-visible — a
title and a one-line note, with a path no tool could open. In `assists/` the
full text is retrievable, and each record's `whenToUse` line says *in which
situation* it applies, so it turns up when an agent self-selects.

## Where a decision goes now

- **New architecture decision** → `assists/adr-NNNN-title.md`, `kind: adr`,
  with a `whenToUse` line written for the *situation* an agent will be in when
  it needs the decision — not a restatement of the title. Next free number:
  **0015**.
- Format is unchanged: **Status · Context · Decision · Consequences**.
- **UX-surface** decisions still live in [../UX_DECISIONS.md](../UX_DECISIONS.md)
  and [../UX_PHILOSOPHY.md](../UX_PHILOSOPHY.md); the credential self-heal
  mechanics in [../CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md);
  ratcheted invariants in [../ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md).

## Index

| # | Assist id | Decision |
|---|-----------|----------|
| 0001 | [`adr-0001-authentication-via-authelia-sso-or-lldap`](../../assists/adr-0001-authentication-via-authelia-sso-or-lldap.md) | Every user-facing service authenticates via Authelia SSO, or at minimum LDAP→LLDAP |
| 0002 | [`adr-0002-tiered-backup-nas-config-vs-bulk-drive`](../../assists/adr-0002-tiered-backup-nas-config-vs-bulk-drive.md) | Tiered backup: critical config + HA-full + vault → NAS; bulk media → large drive |
| 0003 | [`adr-0003-releases-via-release-please-only`](../../assists/adr-0003-releases-via-release-please-only.md) | Versioning/releases via release-please only; commit subjects stay parser-clean |
| 0004 | [`adr-0004-installs-are-non-destructive`](../../assists/adr-0004-installs-are-non-destructive.md) | Installing a service never wipes others; system-wide reset is factory-reset-only |
| 0005 | [`adr-0005-dns-topology-pattern-a`](../../assists/adr-0005-dns-topology-pattern-a.md) | DNS: router hands out AdGuard as LAN DNS (Pattern A); deterministic over fallback |
| 0006 | [`adr-0006-authelia-apex-deny-vs-wildcard`](../../assists/adr-0006-authelia-apex-deny-vs-wildcard.md) | Authelia: bare apex is default-deny; only `*.<domain>` is `one_factor` |
| 0007 | [`adr-0007-container-network-isolation-and-carveouts`](../../assists/adr-0007-container-network-isolation-and-carveouts.md) | App pods move off `hostNetwork`; named carve-outs stay on host networking |
| 0008 | [`adr-0008-tui-desired-state-and-journey`](../../assists/adr-0008-tui-desired-state-and-journey.md) | TUI = desired-state stack editor + numbered setup-journey menu |
| 0009 | [`adr-0009-service-tokens-and-trust`](../../assists/adr-0009-service-tokens-and-trust.md) | Tokens & trust between services: per-box identity secrets, SSO, scoped named tokens, the LAN-only bootstrap reconnect bridge, allow-listed host exec |
| 0010 | [`adr-0010-node-20-minor-floats`](../../assists/adr-0010-node-20-minor-floats.md) | Node runtime tracks one LTS line (now Node 22; amended from Node 20, #2329); the minor floats, kept consistent across package.json / .nvmrc / CI / Dockerfile |
| 0011 | [`adr-0011-app-integrations-aggregate-server-side`](../../assists/adr-0011-app-integrations-aggregate-server-side.md) | App integrations aggregate server-side: Solaris is the BFF/Hub; the Companion App has one pairing, one token, one SSE; ServiceBay's `/napi` is consumed server-to-server |
| 0012 | [`adr-0012-repair-is-reconciliation-not-reinstallation`](../../assists/adr-0012-repair-is-reconciliation-not-reinstallation.md) | Repair is reconciliation, not reinstallation — with hard guardrails against a reconciler hell (**renumbered from a second 0009**, #2617) |
| 0013 | [`adr-0013-clients-request-their-own-access`](../../assists/adr-0013-clients-request-their-own-access.md) | Clients request their own access and a human only confirms; a three-class table decides which scopes may be self-requested at all, and the scope vocabulary exists exactly once |
| 0014 | [`adr-0014-assist-catalog-delivered-at-runtime`](../../assists/adr-0014-assist-catalog-delivered-at-runtime.md) | The assist catalog is delivered at runtime, not baked into the image — exactly one source, and a failed delivery is empty and loud rather than stale and quiet |

## The 0009 collision (#2617)

Two files used to claim number 0009 and only one was indexed. *Tokens & trust*
keeps **0009**; *Repair is reconciliation* became **0012**. Both of its old
paths — `0009-repair-is-reconciliation-not-reinstallation.md` and the new
`0012-…` name — resolve to signposts pointing at the same single record, so no
existing reference dead-ends.
