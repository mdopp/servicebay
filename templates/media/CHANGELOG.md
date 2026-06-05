# Media (Audiobookshelf + Jellyfin) — template changelog

## Pending — #1717 / #1718 (media SSO auth reconciliation)

Two auth-survival fixes; additive variables only, no on-disk data move,
no schema bump.

- **#1717 — Audiobookshelf OIDC client_secret self-heal.** After a
  reinstall-over-preserved-data the stored OIDC `client_secret` in ABS's
  `absdatabase.sqlite` drifts from Authelia's re-rendered value →
  `invalid_client` login loop. `configure_abs_oidc` already re-stamps it
  via the admin API, but that needs an admin login — which also fails when
  `ABS_ADMIN_PASSWORD` drifted. `post-deploy.py` now falls back to a
  no-login DB re-stamp (`podman exec media-audiobookshelf sqlite3 …
  json_set` on the `server-settings` row) and restarts ABS. Same class as
  the Immich DB reconcile (#1556). Idempotent; never touches ABS user data.
- **#1718 — Jellyfin wired to LLDAP (SSO).** Jellyfin previously used a
  local admin only. `post-deploy.py` now installs the Jellyfin
  LDAP-Authentication plugin and writes `LDAP-Auth.xml` (host-side, every
  deploy → idempotent + self-healing) pointed at LLDAP
  (`ldap://host.containers.internal:{{LLDAP_LDAP_PORT}}`, base
  `ou=people,{{LLDAP_BASE_DN}}`, bind `uid=admin,ou=people,…`, filter
  `(&(objectClass=person)(uid={username}))`, `lldap_admin` group → Jellyfin
  admin). The local Jellyfin `admin` stays a **break-glass** login — LDAP
  is added as an additional provider, not a replacement.
- `variables.json`: adds `LLDAP_LDAP_PORT`, `LLDAP_BASE_DN`,
  `LLDAP_ADMIN_PASSWORD` (inherited from the `auth` template — same as
  Radicale).

## Pending — #1018

Folder names under the file-share data root are lowercase by convention
now (`audiobooks/`, `podcasts/`, `music/`, `movies/`, `tv/`, `photos/`)
so they sit cleanly alongside the existing `notes/` sibling that
hermes + the OSCAR skills already use. Variable shape is unchanged
— only the default values flip. Existing installs keep whatever
path the operator originally accepted; the variable is
wizard-overridable.

- `variables.json`: `ABS_AUDIOBOOKS_PATH` default
  `/mnt/data/stacks/file-share/data/Audiobooks` → `/audiobooks`,
  `ABS_PODCASTS_PATH` default `…/Podcasts` → `/podcasts`.
- `post-deploy.py`: `jellyfin_add_music_library` now registers
  `/media/music` (was `/media/Music`); the operator-hint log line
  spells `movies/tv/photos` lowercase.
- `README.md` updated to match.

No schema-version bump — variable names are stable, only defaults
change. Schemata, on-disk layouts, and other templates are
unaffected.

## v4 (breaking) — #618

Swapped Navidrome out for Jellyfin. Audiobookshelf is unchanged.

### Why

Navidrome's only path for mobile-app authentication was the Subsonic
API's HTTP Basic Auth — every family member had to type the local
admin password into every device (Symfonium, DSub, play:Sub, etc.).
There's no OAuth/SSO branch in the Subsonic protocol spec, so this
was a protocol limitation, not a Navidrome bug.

Jellyfin's **Quick Connect** sidesteps this: the mobile app shows a
6-digit code, the operator (or family member) confirms it once in
the web UI, the app is paired — no shared password leaves the
operator's head. Web UI itself runs against Jellyfin's own user DB
by default; operators can install `jellyfin-plugin-sso` manually
later for Authelia-redirect SSO if they want, but Quick Connect
already covers the practical case.

### What changed

- `template.yml`: removed the `navidrome` container + its volumes;
  added a `jellyfin` container with `/config`, `/cache`, and a
  read-only `/media` mount (default
  `/mnt/data/stacks/file-share/data` — so Music/, Movies/, TV/,
  Audiobooks/ all live under the same Samba-visible tree).
- `variables.json`: dropped every `NAVIDROME_*` variable + the
  `NAVIDROME_SUBDOMAIN` block (which carried the forward-auth
  advanced_config); added `JELLYFIN_PORT` (8096),
  `JELLYFIN_ADMIN_USER`/`_PASSWORD`, `JELLYFIN_MEDIA_PATH`, and a
  `MEDIA_SUBDOMAIN` (still defaults to `music`) with a 100 MB upload
  cap (Jellyfin's cover-art import needs it).
- `post-deploy.py`: replaced the Navidrome seed with a Jellyfin
  setup that (1) waits for /System/Info/Public, (2) walks the
  /Startup/* sequence to skip the wizard and seed the admin from
  `JELLYFIN_ADMIN_PASSWORD`, (3) authenticates via
  /Users/AuthenticateByName, (4) enables Quick Connect, (5) adds
  /media/Music as a "Music" library so the scan starts immediately.
  Each step is best-effort with a clear breadcrumb if it fails.
- `migrations/v3-to-v4.py`: moves the old Navidrome data dir to
  `navidrome.bak` (operator deletes once confident) and surfaces
  the data-loss caveats up-front: play history, stars, playlists,
  per-user accounts are NOT carried across.

### Required action for existing installs

1. **Family members must re-pair** in their mobile apps: delete the
   old "Navidrome" backend, add a "Jellyfin" backend pointing at
   the same `music.<your-domain>` URL, choose "Quick Connect" as
   the sign-in method.
2. **Drop the `navidrome` OIDC client** from Authelia's
   `configuration.yml` — v4 doesn't register it, but a stale entry
   left over from v3 doesn't hurt (Authelia just ignores
   unreachable clients).
3. **Drop the Navidrome proxy-host's `advanced_config`** in NPM if
   you customized it; the v4 `MEDIA_SUBDOMAIN` carries a cleaner
   one (`client_max_body_size 100M` for Jellyfin cover-art uploads,
   nothing else).
4. Old `${DATA_DIR}/media/navidrome` is renamed to `navidrome.bak`
   by the migration — `rm -rf` it once you've confirmed Jellyfin
   is working.

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
