# AdGuard Home — template changelog

Tracks breaking changes to the `adguard` template's pod structure /
variable shape. Each H2 corresponds to a value of
`servicebay.schema-version` in `template.yml`.

## v2 (breaking)

**Admin UI behind Authelia forward-auth.**

The AdGuard admin UI used to bind on `0.0.0.0:{{ADGUARD_ADMIN_PORT}}`
with only AdGuard's local username/password as the gate. It now binds
on `127.0.0.1:{{ADGUARD_ADMIN_PORT}}` and is reachable to LAN devices
only via `https://<ADGUARD_SUBDOMAIN>.<PUBLIC_DOMAIN>`, which NPM
gates with Authelia forward-auth.

Required action after re-deploy: log in to AdGuard via SSO at the new
URL (the `<dns>.<domain>` proxy host is reconfigured automatically).
The local AdGuard credentials remain as a recovery backstop reachable
from the host loopback (SSH tunnel or `curl localhost:{{ADGUARD_ADMIN_PORT}}`),
which is the safety net for Authelia-down scenarios.

`servicebay.dependencies` now lists `auth` in addition to `nginx`,
which the wizard's deploy ordering respects automatically.

## v1

Initial release.
