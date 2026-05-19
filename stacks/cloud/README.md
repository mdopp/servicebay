# Cloud stack

The personal-cloud bundle — services reachable from outside the LAN
that handle private data the household relies on:

- **vaultwarden** — Bitwarden-compatible password manager
- **immich** — Photos + AI search, mobile auto-upload
- **file-share** — Syncthing + Samba + FileBrowser (LDAP/SSO‑wired)
- **media** — Jellyfin streaming + Audiobookshelf for podcasts/books
- **radicale** — CalDAV/CardDAV (calendar + contacts), LDAP-bound

## Why a single stack

Each of these was its own stack pre-cleanup, which produced UI noise
and a fragmented Install screen. They share the same operational
profile (public domain proxying, family-account binding, off-site
sync intent) so wiping/installing them together is the natural
boundary.

If you want only some of them: install the stack, then delete the
templates you don't need via Settings → Services.

## Dependencies

Requires the `basic` stack (nginx + auth + adguard) — every service
here registers with NPM for the public subdomain and authenticates
against LLDAP.
