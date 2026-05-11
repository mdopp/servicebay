# File Sharing Stack

Three services in a single pod, sharing one `/data` volume:

1. **Syncthing** — Bidirectional folder sync (Android + desktop apps)
2. **Samba** — Single-user SMB share for the admin's primary Windows/macOS mount
3. **FileBrowser** — Family-facing web file manager (SSO-gated via Authelia)

> 🧭 **Design note**: family members aren't meant to use Samba. There's intentionally only **one** Samba account — the auto-generated admin password. Family-facing file access goes through **FileBrowser** at `https://files.<your-domain>`, which is wired to LLDAP/Authelia SSO and gives each user their own session against the same shared `/data` volume.

Files added through any of the three (Samba, Syncthing, FileBrowser) are immediately visible to the others.

## Variables

| Variable | Description | Default |
|---|---|---|
| `DATA_DIR` | Base directory for persistent data (global) | `/mnt/data` |
| `SHARE_USER` | Username for Samba access | `samba` |
| `SHARE_PASSWORD` | Password for Samba access | — (auto-generated, shown in install log) |
| `FILEBROWSER_PORT` | Loopback HTTP port for FileBrowser | `8088` |
| `FILEBROWSER_ADMIN_USER` | LLDAP user pre-promoted to FB admin | `admin` |

> ℹ️ Samba auth is local-only — no LDAP/Authelia integration. The single `SHARE_USER` is the credentials Windows/macOS prompts for when mounting the share. Syncthing devices pair via cryptographic device IDs and don't use LDAP either. FileBrowser is the SSO-gated path for everyone else.

## Ports

| Service | Port | Protocol |
|---|---|---|
| Syncthing UI | 8384 | HTTP |
| Syncthing Sync | 22000 | TCP/QUIC |
| Samba | 445 | TCP |
| FileBrowser | 8088 | HTTP (proxy-auth: needs Remote-User header) |

## Getting Started

### Syncthing

Open `http://<server-ip>:8384` to access the Syncthing web UI. Add your devices:

- **Android**: Install [Syncthing](https://play.google.com/store/apps/details?id=com.nutomic.syncthingandroid) from Google Play
- **Windows**: Install [SyncTrayzor](https://github.com/canton7/SyncTrayzor) or the official [Syncthing app](https://syncthing.net/downloads/)

Pair devices by exchanging device IDs in the Syncthing UI, then share the default sync folder.

### Windows Network Drive (SMB)

1. Open File Explorer and enter `\\<server-ip>\data` in the address bar
2. Enter the `SHARE_USER` and `SHARE_PASSWORD` you configured during installation
3. Right-click the share and select **Map network drive** for permanent access

### FileBrowser (Family)

Open `https://files.<your-domain>`. Authelia handles the login; on first SSO success FileBrowser auto-creates an account for that user. The `FILEBROWSER_ADMIN_USER` (default `admin`) is pre-promoted to FB admin during install so they immediately see the admin panel.

## Data Layout

```
{{DATA_DIR}}/file-share/
  data/                    ← Shared volume — Samba + Syncthing + FileBrowser see this
  syncthing/               ← Syncthing config, keys, database
  filebrowser-db/          ← FileBrowser SQLite (users, share links)
  filebrowser-config/      ← FileBrowser config file
```
