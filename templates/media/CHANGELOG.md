# Media (Audiobookshelf + Navidrome) — template changelog

## v3 (breaking) — #560 + #559

Two SSO fixes uncovered during real-install diagnosis.

### Navidrome reverts to forward-auth (Remote-User)

Verified against upstream `navidrome/navidrome/conf/configuration.go`
(v0.61.2 + current master): Navidrome has zero native OIDC support.
The v2 attempt to wire `ND_OIDC_*` env vars (#413) was a misread —
those env vars are silently ignored, and operators landed on
Navidrome's own login form, which 401'd LLDAP credentials.

What changed:

- `template.yml` drops all `ND_OIDC_*` env vars and adds
  `ND_EXTAUTH_USERHEADER=Remote-User` +
  `ND_EXTAUTH_TRUSTEDSOURCES=127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`
  (the modern names; `ND_REVERSEPROXY*` are deprecated upstream).
- `variables.json` drops `NAVIDROME_OIDC_ENABLED`,
  `NAVIDROME_OIDC_SECRET`, and the `oidcClient` block on
  `NAVIDROME_SUBDOMAIN`. The proxy host's `advanced_config` now
  carries the `__authelia_forward_auth__` sentinel plus a
  `location /rest/` + `/share/` exception so Subsonic API mobile
  clients and public share links keep working.

Required action for existing installs:

1. Delete the `navidrome` OIDC client from Authelia's
   `configuration.yml` (the OIDC-clients route refuses to remove
   existing entries).
2. Reconfigure → `media` template, accept the new variable set.
3. Click "Sign in" on Navidrome — it should auto-redirect through
   Authelia. Subsonic mobile clients keep working unchanged.

### Audiobookshelf subfolder fix

ABS 2.17.4's `use-subfolder-for-oidc-redirect-uris` migration only
sets `authOpenIDSubfolderForRedirectURLs=''` for installs that
ALREADY had OIDC enabled at migration time. ServiceBay's install
order is `ABS deploy → migrations run → post-deploy enables OIDC`,
so the migration's "OIDC not enabled" branch leaves the key
undefined. ABS's web frontend then reads `undefined` literally and
POSTs `redirect_uri=https://books.<domain>/undefined/auth/openid/callback`
to Authelia, which rejects with `invalid_request` ("the
'redirect_uri' parameter does not match any of the OAuth 2.0
Client's pre-registered 'redirect_uris'").

`post-deploy.py` now sets `authOpenIDSubfolderForRedirectURLs=""`
explicitly when writing the auth-settings PATCH. ABS thereafter
posts the no-subfolder URI shape `/auth/openid/callback` that
matches the Authelia client registration.

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
