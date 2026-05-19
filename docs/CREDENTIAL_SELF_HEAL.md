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
| **NPM** | `config.reverseProxy.npm.password` | sqlite DB at `nginx-proxy-manager/data/database.sqlite` | post-deploy `bootstrapNpmAdmin` re-rotates via NPM API using the previous-pw fallback chain | ✅ |
| **AdGuard** | `config.adguard.password` | `adguard/conf/AdGuardHome.yaml` (bcrypt in plain YAML) | Mustache renders `AdGuardHome.yaml.mustache` on every deploy → bcrypt with new pw → `extraFiles` writes overwrite the on-disk YAML → AdGuard reads new config on next restart | ✅ |
| **Authelia** | `AUTHELIA_STORAGE_ENCRYPTION_KEY` (`enc:` in `config.json`) | `auth/authelia-data/db.sqlite3` (rows encrypted with the key) | Runner detects fresh key + non-empty data dir → wipes `authelia-data/` only (#619). LLDAP users at sibling `auth/lldap` host path are preserved. | ✅ |
| **LLDAP** | `LLDAP_ADMIN_PASSWORD` (`enc:` in `config.json`) | `auth/lldap/users.db` (admin bcrypt set on first start, never updated from env) | None — the LLDAP image does *not* rotate the admin password from env after the DB is initialised | ⚠️ documented edge case |
| **Cloudflare API key** | `config.dns.cloudflareToken` | n/a — operator-supplied | None possible; operator re-enters via wizard | n/a |
| **FritzBox** | `config.gateway.fritzbox.password` | n/a — operator-supplied | None possible | n/a |
| **SMTP** | `config.notifications.email.smtp.password` | n/a — operator-supplied | None possible | n/a |
| **Vaultwarden admin token** | n/a (per-vault) | inside the vault container | n/a — ServiceBay doesn't own | n/a |

## The LLDAP edge case

The pathological combination is **wipe `secrets`, preserve `identity`**:

1. Operator unchecks `secrets` in the clean-install dialog (non-default).
2. `secret.key` + `.auth-secret.env` + `config.json` deleted from
   `/mnt/data/servicebay/`.
3. `/mnt/data/stacks/auth/lldap/users.db` is preserved (identity kept).
4. Wizard generates a fresh `LLDAP_ADMIN_PASSWORD`.
5. Install deploys LLDAP, env var `LLDAP_LDAP_USER_PASS` is set to the
   new value.
6. LLDAP boots, sees an *existing* `users.db`, **does not update** the
   admin password from env.
7. Operator can't log in to LLDAP admin UI with the wizard's new
   password. They also can't recover the previous password (it's
   in the now-deleted `config.json`).

**Recovery**: SSH to the node and either:
- `rm -rf /mnt/data/stacks/auth/lldap/users.db` and redeploy (loses all
  user accounts — re-create them from the wizard's seed user list).
- Or use the LLDAP CLI on the host to reset the admin password against
  the live DB. This is undocumented and image-version-specific.

**Mitigation**: the diagnose page and S9 warning (#668) flag this
combination *before* the wipe runs so the operator picks the
intentional path.

The defaults (`preserve secrets + certs + identity`, wipe only
`service-data`) avoid this entirely.

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
