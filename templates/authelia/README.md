# Authelia — SSO & OIDC Provider

Authelia is a Single Sign-On (SSO) and identity provider that works with LLDAP to provide centralized authentication with OpenID Connect (OIDC) for all services.

## Variables

| Variable | Description | Default |
|---|---|---|
| `AUTHELIA_PORT` | Web portal port | `9091` |
| `AUTHELIA_JWT_SECRET` | JWT secret for identity verification | — (auto-generated) |
| `AUTHELIA_SESSION_SECRET` | Session encryption secret | — (auto-generated) |
| `AUTHELIA_OIDC_HMAC_SECRET` | OIDC HMAC signing secret | — (auto-generated) |
| `AUTHELIA_OIDC_RSA_PRIVATE_KEY` | OIDC RSA signing key (PEM, 2048-bit) | — (auto-generated, written to `/config/oidc.pem`) |
| `AUTHELIA_STORAGE_ENCRYPTION_KEY` | SQLite encryption key (min 20 chars) | — (auto-generated) |
| `LLDAP_HOST` | LLDAP host address | `localhost` |
| `LLDAP_LDAP_PORT` | LLDAP LDAP port | `3890` |
| `LLDAP_BASE_DN` | LDAP base DN | `dc=dopp,dc=cloud` |
| `LLDAP_ADMIN_PASSWORD` | LLDAP admin password | — |
| `PUBLIC_DOMAIN` | Public domain for access rules | `dopp.cloud` |

## Ports

| Service | Port | Protocol |
|---|---|---|
| Authelia Portal | 9091 | HTTP |

## Prerequisites

- **LLDAP** must be deployed and running before Authelia
- Create at least the `admins` and `family` groups in LLDAP
- Ensure the `PUBLIC_DOMAIN` matches your reverse proxy configuration

## Getting Started

1. Deploy LLDAP first and create users/groups
2. Deploy Authelia with matching LLDAP credentials
3. The configuration file is generated at `{{DATA_DIR}}/authelia/config/configuration.yml`, the RSA signing key at `{{DATA_DIR}}/authelia/config/oidc.pem`
4. Access the Authelia portal at `https://auth.{{PUBLIC_DOMAIN}}`

> **Authelia 4.39 note:** the OIDC `jwks` block must reference a real RSA key — the older "key gets auto-generated" behaviour was removed. ServiceBay generates a 2048-bit key at install time and writes it to `oidc.pem`; the configuration uses `key_path` to reference it.

## OIDC Clients

ServiceBay is pre-configured as an OIDC client. Other services (Vaultwarden, Immich, Home Assistant) can declare their own OIDC integration — see each service template's README for the client config to add here.

| Client | Client ID | Redirect URI |
|---|---|---|
| ServiceBay | `servicebay` | `https://admin.{{PUBLIC_DOMAIN}}/api/auth/oidc/callback` |

## Access Control Rules

| Domain | Policy | Required Group |
|---|---|---|
| `auth.{{PUBLIC_DOMAIN}}` | bypass | — (public) |
| `admin.{{PUBLIC_DOMAIN}}` | two_factor | `admins` |
| `nginx.{{PUBLIC_DOMAIN}}` | two_factor | `admins` |
| `dns.{{PUBLIC_DOMAIN}}` | two_factor | `admins` |
| `ldap.{{PUBLIC_DOMAIN}}` | two_factor | `admins` |
| `*.{{PUBLIC_DOMAIN}}` | one_factor | `family` or `admins` |

## Data Layout

```
{{DATA_DIR}}/authelia/
  config/           ← configuration.yml
  data/             ← SQLite database and notification log
```
