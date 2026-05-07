# Radicale — CalDAV / CardDAV Server

Self-hosted calendar + contact server. Authentication is delegated directly to LLDAP via the LDAP backend, so any LLDAP user can log in with their existing credentials — **no separate Radicale account to manage**.

## Variables

| Variable | Description | Default |
|---|---|---|
| `RADICALE_PORT` | CalDAV/CardDAV HTTP port | `5232` |
| `LLDAP_HOST` | LLDAP hostname | `localhost` |
| `LLDAP_LDAP_PORT` | LLDAP LDAP-protocol port | `3890` |
| `LLDAP_BASE_DN` | LLDAP base DN | `dc=dopp,dc=cloud` |
| `LLDAP_ADMIN_PASSWORD` | LLDAP admin password (used as Radicale's reader bind) | inherited from lldap template |

## How auth works

CalDAV/CardDAV clients (DAVx⁵, Thunderbird, iOS, macOS, Outlook) send HTTP Basic auth on every request — they can't complete an interactive Authelia login. So Radicale **bypasses Authelia entirely** and validates credentials directly against LLDAP via the LDAP protocol:

1. Client → `https://caldav.<domain>/<username>/calendar/`
2. NPM forwards (no Authelia rule on this subdomain)
3. Radicale BIND-DN checks `uid=<username>,ou=people,<base-dn>` against LLDAP
4. Match → request authorized; user reads/writes their own collections at `/<username>/`

The `[rights] type = owner_only` policy enforces that user X can only see/edit collections at `/X/`. To share a calendar between users, put the principal-collection-set together via the Radicale web UI.

## Setup

1. Deploy via ServiceBay
2. Web UI: `https://caldav.<domain>` — log in with any LLDAP user → collection-management interface
3. Mobile / desktop CalDAV clients use the **base URL** with the user's path:

   ```
   Server  : https://caldav.<your-domain>
   Username: <lldap-username>
   Password: <lldap-password>
   ```

   Most clients auto-discover collections from there.

## Apps

| Platform | App | Notes |
|---|---|---|
| Android | **DAVx⁵** (F-Droid + Play Store) | One-time setup, syncs into the system Calendar/Contacts apps |
| iOS / macOS | Settings → Calendar/Contacts → Add Account → Other → CalDAV | Native, no extra app |
| Windows | Thunderbird with the *TbSync + Provider for CalDAV* extension | |
| Linux | Evolution, GNOME Calendar | |

## Data Layout

```
{{DATA_DIR}}/radicale/
  config/config              ← LDAP-backed auth config
  data/collections/<user>/   ← per-user calendars & address books
```
