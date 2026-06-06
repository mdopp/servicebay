# ADR 0006 — Authelia: the bare apex is default-deny; only `*.<domain>` subdomains are `one_factor`

- **Status:** Accepted (box-verified 2026-06-03)
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](0001-authentication-via-authelia-sso-or-lldap.md), [ADR 0005](0005-dns-topology-pattern-a.md)

## Context

Authelia's `access_control` is wildcard-scoped to subdomains. Verified against
the live Authelia (`192.168.178.100:9091`):

- `https://<domain>/` and `https://<domain>/portal` (**bare apex**) → **403**.
  The apex matches no `access_control` rule, falls through to
  `default_policy: deny`, and returns **no `Remote-User`/`Remote-Name`
  headers** — even for a valid session.
- `https://www.<domain>/` and any `*.<domain>` subdomain → **401** anon /
  **200 + identity headers** when authed (the `*.<domain>` `one_factor` rule).
  Even a nonexistent subdomain returns 401, confirming a true wildcard.
- `https://auth.<domain>/` → 200 (Authelia's own portal bypass).

This was the root cause of the portal showing "Don't have an account yet?" to
signed-in SSO users (#1606 / PR #1614): the identity probe was pointed at the
apex, which never returns identity.

## Decision

1. **Any server-side "who is this visitor" probe MUST set `X-Original-URL` to a
   subdomain** (e.g. `https://www.<domain>`), **never the apex** — otherwise
   identity is never returned.
2. Use the nginx forward-auth endpoint **`/api/authz/auth-request`**
   (Authelia 4.38+) with `X-Original-URL` + `X-Original-Method`, not the
   deprecated `/api/verify`. `X-Original-URL` must be **`https://`** (Authelia
   400s on `http://`).
3. **ServiceBay's own admin UI (`admin.<domain>`) is app-layer auth, not
   Authelia forward-auth** — deliberately excluded (`ADMIN_ONLY_HOSTS` in
   `diagnose/ssoVerify.ts`) and a LAN-only NPM host.

## Consequences

- The apex is intentionally a dead end for identity; don't "fix" a 403 there.
- Probes and integrations reuse the same `/api/authz/auth-request` path the
  proxy uses (`stackInstall/forwardAuth.ts`).
