# Media (Audiobookshelf + Navidrome) — template changelog

## v2 (breaking) — #413

Navidrome moves from reverse-proxy-auth to OIDC. The previous setup
expected NPM to forward an Authelia-injected `Remote-User` header,
but the proxy host was never configured with Authelia forward-auth —
so the header never arrived, Navidrome's own login screen showed up,
and only the local admin worked.

What changed:

- `variables.json` declares `NAVIDROME_OIDC_ENABLED`,
  `NAVIDROME_OIDC_SECRET`, and an `oidcClient` block on
  `NAVIDROME_SUBDOMAIN` pinned via `clientSecretVar`. The same secret
  flows into Authelia's `clients[]` entry and Navidrome's env.
- `template.yml` drops `ND_REVERSEPROXYUSERHEADER` /
  `ND_REVERSEPROXYWHITELIST` and adds the Navidrome OIDC env vars
  (`ND_OIDC_ENABLED`, `ND_OIDC_ISSUER`, `ND_OIDC_CLIENTID`,
  `ND_OIDC_CLIENTSECRET`, `ND_OIDC_REDIRECTURL`, `ND_OIDC_AUTOREGISTER`).
  Requires Navidrome v0.52 or newer.

Operator impact: redeploy → Navidrome's login screen now shows a
*Sign in with Authelia* button. LLDAP users land in Navidrome on
first sign-in (auto-registered). Subsonic API clients (mobile apps)
keep using the local admin account because Subsonic doesn't speak
OIDC.

If you specifically want the silent header-trust pattern back, you
can re-add `ND_REVERSEPROXYUSERHEADER` after wiring NPM's
`advanced_config` for Navidrome up with Authelia forward-auth — but
that path isn't documented here, see issue #412 for the trade-offs.
