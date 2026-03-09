# Full Home Server Stack

Komplette Home-Server-Installation mit Reverse Proxy, DNS-Werbeblocker,
Passwort-Manager, Foto-Verwaltung, Dateifreigabe und Smart-Home.

## Included Services

- [x] nginx-web
- [x] adguard
- [x] vaultwarden
- [x] immich
- [x] file-share
- [x] home-assistant-stack

## Ports nach Installation

| Service | Port | Zweck |
|---------|------|-------|
| Nginx Proxy Manager | 8080/8443/8081 | HTTP/HTTPS/Admin |
| AdGuard Home | 53/3000→8083 | DNS/Setup→Admin |
| Vaultwarden | 8222 | Passwort-Manager |
| Immich | 2283 | Foto-Verwaltung |
| File Share | 8090/8384/445 | WebDAV/Syncthing/SMB |
| Home Assistant | 8123 | Smart Home |

## Nach der Installation

Nginx Proxy Manager unter http://<host>:8081 konfigurieren:
- vault.home → localhost:8222
- photos.home → localhost:2283
- dns.home → localhost:8083
- ha.home → localhost:8123
- files.home → localhost:8090
