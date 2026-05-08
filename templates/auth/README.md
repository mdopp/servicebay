# Auth Stack

LLDAP + Authelia in a single pod. Authelia depends on LLDAP for its user/group directory; bundling them removes the cross-pod handshake and a class of bootstrap-order problems.

## Containers

1. **LLDAP** — Lightweight LDAP server. Web UI at `:17170` for user/group management, LDAP socket on `:3890`.
2. **Authelia** — SSO portal + OIDC identity provider. Reads the user directory from LLDAP via `localhost:3890`.

## Variables

| Variable | Description | Default |
|---|---|---|
| `LLDAP_PORT` | LLDAP web UI port | `17170` |
| `LLDAP_LDAP_PORT` | LDAP protocol port | `3890` |
| `LLDAP_BASE_DN` | LDAP base DN | `dc=dopp,dc=cloud` |
| `LLDAP_ADMIN_PASSWORD` | LLDAP admin password — auto-generated | — |
| `AUTHELIA_PORT` | Authelia portal port | `9091` |
| `AUTHELIA_*_SECRET` | JWT / session / OIDC HMAC / storage secrets — auto-generated | — |
| `AUTHELIA_OIDC_RSA_PRIVATE_KEY` | RSA-2048 PEM, server-generated at install time | — |

## Subdomains

* `https://ldap.<your-domain>` → LLDAP web UI (forward-auth via Authelia, two-factor for admins)
* `https://auth.<your-domain>` → Authelia portal (bypass — must be publicly reachable)

## Data Layout

```
{{DATA_DIR}}/auth/
  lldap/                ← LLDAP user/group DB + JWT keys
  authelia-config/      ← configuration.yml (rendered from mustache template)
  authelia-data/        ← session DB, OIDC token store
```

## Adding family members

After install, open `https://ldap.<your-domain>`, log in as `admin` (password from Settings → Integrations → LLDAP), and add users to the `family` group. They get one-factor SSO across every service that has an Authelia forward-auth or OIDC config.
