# File Sharing Stack

A unified file-sharing solution combining three services in a single pod:

1. **FileBrowser** — Web-based file explorer for browsing, uploading, downloading, and sharing files via link
2. **Syncthing** — Bidirectional folder sync with native apps for Android and Windows
3. **Samba** — SMB/CIFS network shares for mapping as a Windows drive

All three containers share a single data volume, so files added through any method are immediately visible everywhere.

## Variables

| Variable | Description | Default |
|---|---|---|
| `DATA_DIR` | Base directory for persistent data (global) | `/mnt/data` |
| `SMB_USER` | Samba username for SMB access | — |
| `SMB_PASSWORD` | Samba password for SMB access | — |

## Ports

| Service | Port | Protocol |
|---|---|---|
| FileBrowser | 8090 | HTTP |
| Syncthing UI | 8384 | HTTP |
| Syncthing Sync | 22000 | TCP/QUIC |
| Syncthing Discovery | 21027 | UDP |
| Samba | 445 | TCP |

## Host Requirement: Sysctl for Port 445

Rootless Podman cannot bind privileged ports by default. For Samba (port 445), the host needs:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0
```

To make this permanent on Fedora CoreOS, add it to your Butane/Ignition config or create a sysctl drop-in:

```bash
echo "net.ipv4.ip_unprivileged_port_start=0" | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf
sudo sysctl --system
```

## Getting Started

### FileBrowser

Open `http://<server-ip>:8090`. Default credentials: **admin / admin** — change the password immediately after first login.

### Syncthing

Open `http://<server-ip>:8384` to access the Syncthing web UI. Add your devices:

- **Android**: Install [Syncthing](https://play.google.com/store/apps/details?id=com.nutomic.syncthingandroid) from Google Play
- **Windows**: Install [SyncTrayzor](https://github.com/canton7/SyncTrayzor) or the official [Syncthing app](https://syncthing.net/downloads/)

Pair devices by exchanging device IDs in the Syncthing UI, then share the default sync folder.

### Windows Network Drive (SMB)

1. Open File Explorer and enter `\\<server-ip>\share` in the address bar
2. Enter the `SMB_USER` and `SMB_PASSWORD` you configured during installation
3. Right-click the share and select **Map network drive** for permanent access

## Data Layout

```
{{DATA_DIR}}/file-share/
  data/             ← Shared files (Samba serves, Syncthing syncs, FileBrowser browses)
  syncthing/        ← Syncthing config, keys, and database
  filebrowser/      ← FileBrowser SQLite database
```
