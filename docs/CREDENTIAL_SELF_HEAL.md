# Credential self-heal — coverage matrix

ServiceBay encrypts service admin credentials in `config.json` using
`/mnt/data/servicebay/secret.key`. When the operator wipes the
`secrets` group during a clean install, that key — and the AUTHELIA-
style `.auth-secret.env` — goes with it. Every existing `enc:v1:`
ciphertext in `config.json` becomes garbage.

What happens next depends on the *service*: some self-heal cleanly,
some drift, one is a known foot-gun.

## Coverage matrix

| Service | Stored cred | On-disk state | Self-heal path | Status |
|---|---|---|---|---|
| **ServiceBay admin login** | `config.auth.passwordHash` (bcrypt) | NextAuth session store (no separate DB) | At login time, if the stored hash rejects the candidate but `SERVICEBAY_PASSWORD` (env) accepts it, the login succeeds and the stored hash is re-keyed to the new password. Operator-changed passwords always win; the env fallback only fires when the stored hash is stale. | ✅ |
| **NPM** | `config.reverseProxy.npm.password` | sqlite DB at `nginx-proxy-manager/data/database.sqlite` | post-deploy `bootstrapNpmAdmin` re-rotates via NPM API using the previous-pw fallback chain | ✅ |
| **AdGuard** | `config.adguard.password` | `adguard/conf/AdGuardHome.yaml` (bcrypt in plain YAML) | Mustache renders `AdGuardHome.yaml.mustache` on every deploy → bcrypt with new pw → `extraFiles` writes overwrite the on-disk YAML → AdGuard reads new config on next restart | ✅ |
| **Authelia** | `AUTHELIA_STORAGE_ENCRYPTION_KEY` (`enc:` in `config.json`) | `auth/authelia-data/db.sqlite3` (rows encrypted with the key) | Runner detects fresh key + non-empty data dir → wipes `authelia-data/` only (#619). LLDAP users at sibling `auth/lldap` host path are preserved. | ✅ |
| **LLDAP** | `LLDAP_ADMIN_PASSWORD` (`enc:` in `config.json`) | `auth/lldap/users.db` (admin bcrypt set on first start) | Installer dynamically injects `LLDAP_FORCE_LDAP_USER_PASS_RESET=true` on deploy when a password regenerates, forcing LLDAP to reset its admin password to match `config.json` | ✅ |
| **Immich (OIDC secret)** | `config.installedSecrets[IMMICH_SSO_SECRET]` (mirrored into Authelia's client) | `immich` DB `system_metadata` row `system-config` → `oauth.clientSecret` | post-deploy first tries the admin-authenticated `PUT /api/system-config`; if the admin login fails (drifted `IMMICH_ADMIN_PASSWORD`), falls back to a no-token DB re-stamp of the stored secret via `podman exec immich-database psql … jsonb_set` (#1556) | ✅ |
| **Audiobookshelf (OIDC secret)** | `config.installedSecrets[ABS_OIDC_SECRET]` (mirrored into Authelia's `audiobookshelf` client) | `media` ABS `absdatabase.sqlite` `settings` row `server-settings` → `authOpenIDClientSecret` | post-deploy first tries the admin-authenticated `PATCH /api/auth-settings`; if the ABS admin login fails (drifted `ABS_ADMIN_PASSWORD`), falls back to a no-token DB re-stamp via `podman exec media-audiobookshelf sqlite3 … json_set`, then restarts the ABS container (#1717) | ✅ |
| **Jellyfin (LDAP→LLDAP)** | `LLDAP_ADMIN_PASSWORD` (bind DN), no per-service secret | `media/jellyfin-config/plugins/configurations/LDAP-Auth.xml` | post-deploy (re)writes the LDAP-Auth plugin config pointed at LLDAP on every deploy (idempotent), installs the plugin binary via the package API when an admin token is available, and bounces Jellyfin. Local Jellyfin `admin` stays a break-glass login (#1718) | ✅ |
| **Cloudflare API key** | `config.dns.cloudflareToken` | n/a — operator-supplied | None possible; operator re-enters via wizard | n/a |
| **FritzBox** | `config.gateway.fritzbox.password` | n/a — operator-supplied | None possible | n/a |
| **SMTP** | `config.notifications.email.smtp.password` | n/a — operator-supplied | None possible | n/a |
| **Vaultwarden admin token** | n/a (per-vault) | inside the vault container | n/a — ServiceBay doesn't own | n/a |

## The LLDAP edge case (Automated Self-Healing)

The pathological combination is **wipe `secrets`, preserve `identity`**:

1. Operator unchecks `secrets` in the clean-install dialog (non-default).
2. `secret.key` + `.auth-secret.env` + `config.json` deleted from `/mnt/data/servicebay/`.
3. `/mnt/data/stacks/auth/lldap/users.db` is preserved (identity kept).
4. Wizard generates a fresh `LLDAP_ADMIN_PASSWORD`.
5. Install deploys LLDAP. The installer detects that `LLDAP_ADMIN_PASSWORD` was regenerated and dynamically injects `LLDAP_FORCE_LDAP_USER_PASS_RESET=true` into the pod environment template.
6. LLDAP boots, sees the reset flag, and automatically synchronizes the admin password in the database to the environment variable.
7. Operator can log in to LLDAP admin UI with the wizard's new password immediately without loss of existing user/group identity tables!

**Mitigation & Recovery**: This dynamic self-healing runs automatically, eliminating the old lockout cycle entirely. The defaults (`preserve secrets + certs + identity`, wipe only `service-data`) still avoid database modifications entirely, but this safety net ensures any combination chosen remains fully working.

## Pattern: when to add a self-heal

A new service template needs an explicit self-heal entry above when
**both** of these are true:

1. The service stores admin credentials *in addition to*
   `config.json` (sqlite DB, encrypted column, bcrypt hash on disk).
2. The image does not re-key from env on every start.

If either is false, mustache overwrite (AdGuard pattern) or API-side
rotation (NPM pattern) is sufficient.

See [`feedback_ux_philosophy.md`](../.claude/projects/-home-mdopp-servicebay/memory/feedback_ux_philosophy.md)
— self-heal first, structured-action second.
