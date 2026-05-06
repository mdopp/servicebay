# LLDAP — Lightweight LDAP Server

A lightweight LDAP server for centralized user management. Provides a simple web UI for managing users and groups, and an LDAP interface for service authentication.

## Variables

| Variable | Description | Default |
|---|---|---|
| `LLDAP_PORT` | Web UI port | `17170` |
| `LLDAP_LDAP_PORT` | LDAP protocol port | `3890` |
| `LLDAP_BASE_DN` | LDAP base DN | `dc=dopp,dc=cloud` |
| `LLDAP_ADMIN_PASSWORD` | Admin password (user `admin`) | — (auto-generated, shown in install log + Settings → Integrations) |
| `LLDAP_JWT_SECRET` | JWT secret for sessions | — (auto-generated) |

## Ports

| Service | Port | Protocol |
|---|---|---|
| Web UI | 17170 | HTTP |
| LDAP | 3890 | TCP |

## Getting Started

1. Deploy the service via ServiceBay (the wizard auto-generates the admin password and prints it in the install log)
2. Open `http://<server-ip>:17170` to access the LLDAP web UI
3. Log in with username `admin` and the auto-generated password (also retrievable from Settings → Integrations → LLDAP)
4. Create users and groups (e.g. `admins`, `users`)

### Re-installing on top of an existing data volume

`LLDAP_LDAP_USER_PASS` only takes effect on **first DB initialization**. If you re-deploy LLDAP with a fresh password while the old SQLite DB is still on disk, LLDAP keeps the old admin password and the wizard's auto-seed will fail with HTTP 401. Wipe the data dir before re-installing:

```bash
sudo rm -rf {{DATA_DIR}}/lldap/data
```

Then redeploy from the wizard. (Or reset the admin password manually inside the LLDAP UI.)

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
