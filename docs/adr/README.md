# Architecture Decision Records (ADRs)

Durable architecture/product decisions that are **not derivable from the code
alone** — recorded so they're versioned and reviewable, instead of living only
in tribal memory. Read the relevant ADR before "fixing" something that looks
deliberate; the weirdness is usually load-bearing.

Each ADR: **Status · Context · Decision · Consequences**. New decisions get the
next number: `docs/adr/NNNN-title.md`.

For *UX-surface* decisions see [../UX_DECISIONS.md](../UX_DECISIONS.md) and
[../UX_PHILOSOPHY.md](../UX_PHILOSOPHY.md); for the credential self-heal
mechanics see [../CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md); for
ratcheted invariants see [../ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md).

## Index

| # | Decision |
|---|----------|
| [0001](0001-authentication-via-authelia-sso-or-lldap.md) | Every user-facing service authenticates via Authelia SSO, or at minimum LDAP→LLDAP |
| [0002](0002-tiered-backup-nas-config-vs-bulk-drive.md) | Tiered backup: critical config + HA-full + vault → NAS; bulk media → large drive |
| [0003](0003-releases-via-release-please-only.md) | Versioning/releases via release-please only; commit subjects stay parser-clean |
| [0004](0004-installs-are-non-destructive.md) | Installing a service never wipes others; system-wide reset is factory-reset-only |
| [0005](0005-dns-topology-pattern-a.md) | DNS: router hands out AdGuard as LAN DNS (Pattern A); deterministic over fallback |
| [0006](0006-authelia-apex-deny-vs-wildcard.md) | Authelia: bare apex is default-deny; only `*.<domain>` is `one_factor` |
| [0007](0007-container-network-isolation-and-carveouts.md) | App pods move off `hostNetwork`; named carve-outs stay on host networking |
| [0008](0008-tui-desired-state-and-journey.md) | TUI = desired-state stack editor + numbered setup-journey menu |
