# ADR 0001 — Every user-facing service authenticates via Authelia SSO, or at minimum via LDAP against LLDAP

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md), [ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md), #1561

## Context

The whole reason this box runs **Authelia** (SSO) in front of **LLDAP** (the
single user directory) is that a family should have **one identity**: one
account, one password, used everywhere. That is the promise we sold when we
moved to Authelia.

Two concrete failures showed that services integrate authentication
inconsistently, breaking that promise:

1. **Jellyfin ships with a *local* admin account.** Logging into
   `music.dopp.cloud` does **not** accept the user's Authelia/SSO password —
   it expects a Jellyfin-local `admin` + generated password. A second
   credential nobody should need. SSO is bypassed entirely.

2. **Audiobookshelf's OIDC client secret drifted from Authelia's on
   reinstall.** ABS authenticates via native OIDC against Authelia, but after
   a reinstall the secret stored in ABS's preserved config DB no longer
   matched Authelia's registered client secret. Authelia's `/api/oidc/token`
   rejected every login with *"The provided client secret did not match the
   registered client secret"* → an endless login loop. The client was
   registered; only the secret had drifted. (Same class of problem as #1561 —
   a reinstall must not break login.)

Both are symptoms of the same gap: there is no **enforced rule** that a
service must hook into the central identity, and no guarantee that the auth
credentials linking a service to Authelia/LLDAP **survive a reinstall**.

## Decision

1. **Every user-facing service MUST authenticate users against the central
   identity.** In order of preference:
   - **a) Native OIDC SSO against Authelia** (e.g. Immich, Audiobookshelf).
   - **b) LDAP bind against LLDAP**, when the service has no OIDC support
     (e.g. Jellyfin via its LDAP plugin). Same family accounts, same
     passwords.
   - **c) Forward-auth via Authelia** (`Remote-User`) only when the service
     supports neither OIDC nor LDAP.

   A service-local user/password store is acceptable **only** for an
   unavoidable break-glass bootstrap admin — **never** for family users, and
   never as the path the user is expected to log in through day-to-day.

2. **Auth credentials must self-heal on every (re)deploy.** OIDC client
   secrets and LDAP bind credentials MUST be reconciled between the service
   and Authelia/LLDAP on each deploy, so a reinstall-over-preserved-data
   cannot leave them drifted (see [CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md)).
   A login that worked before a reinstall MUST work after it.

3. **New/changed service templates are reviewed against this ADR.** A
   template SHOULD declare its auth integration (`oidc` | `ldap` |
   `forward-auth`). Shipping a service that authenticates family users via a
   local-only account requires explicit, written justification in the
   template.

## Consequences

- **Jellyfin** must be wired to LLDAP (LDAP plugin → LLDAP) so the family logs
  in with their Authelia/LLDAP password. The local Jellyfin admin remains only
  as break-glass, not the normal login.
- **Audiobookshelf / Immich / other OIDC services** must reconcile their OIDC
  client secret with Authelia on deploy (the ABS drift above is a bug to fix,
  not an accepted state).
- A **diagnose probe / health check** should flag any installed user-facing
  service whose auth is *not* wired to Authelia or LLDAP — making violations of
  this ADR visible instead of silent.
- Some services will need extra setup (plugins, OIDC clients). That cost is
  accepted: one identity for the family is the point of the platform.

## Notes

This is the first ADR; it establishes the `docs/adr/NNNN-title.md` convention
(Status / Context / Decision / Consequences). Future architecture decisions
that are not derivable from the code alone go here; UX-specific decisions
continue to live in [UX_DECISIONS.md](../UX_DECISIONS.md).
