# LLDAP — Lightweight LDAP Server

A lightweight LDAP server for centralized user management. Provides a simple web UI for managing users and groups, and an LDAP interface for service authentication.

## Variables

| Variable | Description | Default |
|---|---|---|
| `LLDAP_PORT` | Web UI port | `17170` |
| `LLDAP_LDAP_PORT` | LDAP protocol port | `3890` |
| `LLDAP_BASE_DN` | LDAP base DN | `dc=dopp,dc=cloud` |
| `LLDAP_ADMIN_PASSWORD` | Admin password | — |
| `LLDAP_JWT_SECRET` | JWT secret for sessions | — (auto-generated) |

## Ports

| Service | Port | Protocol |
|---|---|---|
| Web UI | 17170 | HTTP |
| LDAP | 3890 | TCP |

## Getting Started

1. Deploy the service via ServiceBay
2. Open `http://<server-ip>:17170` to access the LLDAP web UI
3. Log in with username `admin` and the password you configured
4. Create users and groups (e.g. `admins`, `users`)

### Recommended Groups

| Group | Purpose |
|---|---|
| `admins` | Full access to all admin panels (ServiceBay, NPM, AdGuard) |
| `family` | Access to user-facing services (Vaultwarden, Immich, File Share, Home Assistant) |

## Integration

Other services connect to LLDAP via LDAP on port 3890:

- **Bind DN**: `uid=admin,ou=people,{{LLDAP_BASE_DN}}`
- **Base DN**: `{{LLDAP_BASE_DN}}`
- **Users DN**: `ou=people,{{LLDAP_BASE_DN}}`
- **Groups DN**: `ou=groups,{{LLDAP_BASE_DN}}`

## Data Layout

```
{{DATA_DIR}}/lldap/
  data/       ← LLDAP database and configuration
```
