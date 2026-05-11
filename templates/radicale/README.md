# Radicale — CalDAV / CardDAV Server

Self-hosted calendar **and contact** server. Both protocols run on the same Radicale instance on the same subdomain — `caldav.<domain>` is just where the address ends up; CardDAV (contacts / address books) sits on the same host. Authentication is delegated directly to LLDAP via the LDAP backend, so any LLDAP user can log in with their existing credentials — **no separate Radicale account to manage**.

## Subdomain naming

ServiceBay ships a single `caldav.<domain>` proxy host that serves **both** CalDAV (calendars) and CardDAV (address books). The name reflects the calendar use-case most operators are familiar with; there's no separate `carddav.` host because there's no separate service — Radicale handles both protocols on one port (`5232`). Modern clients (DAVx⁵, iOS, macOS, Thunderbird, Outlook) auto-discover the right paths via `.well-known/caldav` and `.well-known/carddav`.

If you'd rather have a dedicated `carddav.` alias for clarity, add it as a second NPM proxy host pointing at the same backend (or add an AdGuard DNS rewrite mapping `carddav.<domain>` → ServiceBay's LAN IP). Functionally identical; just a friendlier-looking URL when someone asks "where do contacts live?"

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

1. Client → `https://caldav.<domain>/<username>/...`
2. NPM forwards (no Authelia rule on this subdomain)
3. Radicale BIND-DN checks `uid=<username>,ou=people,<base-dn>` against LLDAP
4. Match → request authorized; user reads/writes their own collections at `/<username>/`

The `[rights] type = owner_only` policy enforces that user X can only see/edit collections at `/X/`. To share a calendar between users, put the principal-collection-set together via the Radicale web UI.

## Setup

1. Deploy via ServiceBay.
2. Web UI: `https://caldav.<domain>` — log in with any LLDAP user → collection-management interface where you can create both calendars and address books.
3. Mobile / desktop clients use the **base URL** with the user's path:

   ```
   Server  : https://caldav.<your-domain>
   Username: <lldap-username>
   Password: <lldap-password>
   ```

   Most clients auto-discover both calendars and address books from there.

Per-user URL shapes (auto-discovery normally fills these in, but useful when a client wants them spelled out):

  - Calendars: `https://caldav.<domain>/<username>/calendar/`
  - Address books: `https://caldav.<domain>/<username>/contacts/`

## Apps

| Platform | App | What it picks up |
|---|---|---|
| Android | **DAVx⁵** (F-Droid + Play Store) | Calendars + address books, syncs into the system Calendar/Contacts apps in one go |
| iOS / macOS | Settings → Calendar/Contacts → Add Account → Other → CalDAV / CardDAV | Native, no extra app. Add the CalDAV and CardDAV accounts separately (same server URL + creds) — or use the *One-tap iOS setup* asset on the portal card which ships both as a single .mobileconfig |
| Windows | Thunderbird with the *TbSync + Provider for CalDAV* extension | Calendars + address books in Thunderbird |
| Linux | Evolution, GNOME Calendar / Contacts | |

## Data Layout

```
{{DATA_DIR}}/radicale/
  config/config              ← LDAP-backed auth config
  data/collections/<user>/   ← per-user calendars AND address books
```
