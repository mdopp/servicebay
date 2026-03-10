# File Sharing Stack

A file-sharing solution combining two services in a single pod:

1. **Syncthing** — Bidirectional folder sync with native apps for Android and Windows
2. **Samba** — SMB/CIFS network shares for mapping as a Windows drive

Both containers share a single data volume (`/mnt/data`), so files added through either method are immediately visible everywhere.

## Variables

| Variable | Description | Default |
|---|---|---|
| `DATA_DIR` | Base directory for persistent data (global) | `/mnt/data` |
| `SHARE_USER` | Username for Samba access | `user` |
| `SHARE_PASSWORD` | Password for Samba access | — |

## Ports

| Service | Port | Protocol |
|---|---|---|
| Syncthing UI | 8384 | HTTP |
| Syncthing Sync | 22000 | TCP/QUIC |
| Samba | 445 | TCP |

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

## Data Layout

```
/mnt/data/                ← Shared files (Syncthing syncs, Samba shares)
{{DATA_DIR}}/file-share/
  syncthing/              ← Syncthing config, keys, and database
```
