# File Share — template changelog

Tracks breaking changes to the `file-share` template's pod structure /
variable shape. Each H2 corresponds to a value of
`servicebay.schema-version` in `template.yml`.

## v4 (breaking) — #494

**Per-user Samba accounts via LLDAP → tdbsam sync.**

Samba used to mount the share with a single shared service account
(`SHARE_USER` / `SHARE_PASSWORD`). Every family member typed the
same credentials — no audit trail, no per-user permissions, no way
to revoke one device without rotating everyone's password.

Now each LLDAP user maps to their own Samba `tdbsam` account.
Samba can't speak OIDC and the Argon2/bcrypt → NT-hash conversion
isn't reversible, so the password lives in Samba's own DB. Set or
regenerate it from **Settings → Integrations → File Share** —
clicking the per-user button flashes a fresh random password once
for the operator to copy and share.

The share's `SAMBA_VOLUME_CONFIG_data` no longer pins
`valid users = <SHARE_USER>`; any tdbsam user mounts the share with
their own LLDAP id. `SHARE_USER` + `SHARE_PASSWORD` remain as a
backward-compat fallback so existing installs keep working until
the operator migrates each family member onto their LLDAP account.

Lifecycle is automatic: every visit to **Settings → Integrations →
File Share** runs the LLDAP → tdbsam sync (adds missing accounts
with random initial passwords, removes orphans). LLDAP user
creation in another tab + clicking *Sync* surfaces the new user
ready for a password set.

Required action: redeploy `file-share`. Existing mounts on
`SHARE_USER` keep working with the same password. New LLDAP users
need their Samba password set once via the Settings panel before
they can mount.

## v3 (breaking)

**Syncthing GUI behind Authelia.**

The Syncthing web UI used to bind on `0.0.0.0:8384`, so any LAN
device could hit it directly and skip SSO. It now binds on
`127.0.0.1:8384` and is reachable only through
`https://<SYNCTHING_SUBDOMAIN>.<PUBLIC_DOMAIN>`, which NPM gates
with Authelia forward-auth.

Required action after re-deploy: log in to Syncthing via SSO at the
new URL (your `<sync>.<domain>` proxy host gets the forward-auth
snippet automatically). The Syncthing mobile/desktop apps continue
to work — they authenticate with API keys against the REST API,
not the GUI session.

FileBrowser's `advanced_config` block also moved to the shared
`__authelia_forward_auth__` sentinel. Pure refactor, no behaviour
change.

## v2

**FileBrowser bind address fix.**

FileBrowser was previously configured to bind on `127.0.0.1`. Because
the `nginx` template runs in its own pod netns (not hostNetwork),
NPM's `proxy_pass` to the host LAN IP could never reach a
loopback-only listener — `files.<domain>` always failed with a
502 / connection refused.

FB now binds on `0.0.0.0`. Auth bypass is still prevented by FB's
proxy-auth mode: any request without the `Remote-User` header set by
NPM's `auth_request` snippet is rejected with 403, so direct LAN hits
on `:8088` can't get past the login.

Required action: re-deploy the `file-share` template. Existing data
(Syncthing config, Samba shares, FileBrowser DB) is preserved.

## v1

Initial release. Bundled Syncthing + Samba + FileBrowser into a
single pod with the shared `/data` volume.
