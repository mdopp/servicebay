# File Sharing Stack

A unified file-sharing solution combining three services in a single pod:

1. **WebDAV** — Access files from any OS file manager (Windows Explorer, macOS Finder, Linux) or WebDAV client
2. **Syncthing** — Bidirectional folder sync with native apps for Android and Windows
3. **Samba** — SMB/CIFS network shares for mapping as a Windows drive

All three containers share a single data volume, so files added through any method are immediately visible everywhere.

## Variables

| Variable | Description | Default |
|---|---|---|
| `DATA_DIR` | Base directory for persistent data (global) | `/mnt/data` |
| `SHARE_USER` | Username for WebDAV and SMB access | `user` |
| `SHARE_PASSWORD` | Password for WebDAV and SMB access | — |

## Ports

| Service | Port | Protocol |
|---|---|---|
| WebDAV | 8090 | HTTP |
| Syncthing UI | 8384 | HTTP |
| Syncthing Sync | 22000 | TCP/QUIC |
| Samba | 445 | TCP |

## Getting Started

### WebDAV

Connect from any file manager:

- **Windows Explorer**: Map network drive to `http://<server-ip>:8090`
- **macOS Finder**: Connect to Server → `http://<server-ip>:8090`
- **Linux**: Mount via `davfs2` or use your file manager's "Connect to Server"
- **Android**: Use [Total Commander WebDAV plugin](https://play.google.com/store/apps/details?id=com.ghisler.tcplugins.WebDAV) or similar

Credentials are the `SHARE_USER` / `SHARE_PASSWORD` configured during installation.

### Syncthing

Open `http://<server-ip>:8384` to access the Syncthing web UI. Add your devices:

- **Android**: Install [Syncthing](https://play.google.com/store/apps/details?id=com.nutomic.syncthingandroid) from Google Play
- **Windows**: Install [SyncTrayzor](https://github.com/canton7/SyncTrayzor) or the official [Syncthing app](https://syncthing.net/downloads/)

Pair devices by exchanging device IDs in the Syncthing UI, then share the default sync folder.

### Windows Network Drive (SMB)

1. Open File Explorer and enter `\\<server-ip>\share` in the address bar
2. Enter the `SHARE_USER` and `SHARE_PASSWORD` you configured during installation
3. Right-click the share and select **Map network drive** for permanent access

## Data Layout

```
{{DATA_DIR}}/file-share/
  data/             ← Shared files (WebDAV serves, Syncthing syncs, Samba shares)
  syncthing/        ← Syncthing config, keys, and database
```
