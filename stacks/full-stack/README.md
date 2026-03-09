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

## Reverse Proxy

Proxy routes werden automatisch via Nginx Proxy Manager konfiguriert.
Domain und Subdomains sind bei der Installation anpassbar.

| Subdomain | Service | Port | WebSocket | Besonderheiten |
|-----------|---------|------|-----------|----------------|
| nginx.{domain} | Nginx Proxy Manager | 8081 | — | LAN-Zugriff empfohlen |
| vault.{domain} | Vaultwarden | 8222 | Ja | HTTP/2 deaktiviert (WS-Kompatibilität) |
| photos.{domain} | Immich | 2283 | Ja | Unbegrenzter Upload, lange Timeouts |
| dns.{domain} | AdGuard Home | 8083 | — | LAN-Zugriff empfohlen |
| home.{domain} | Home Assistant | 8123 | Ja | 24h Timeouts, kein Buffering |
| drive.{domain} | File Share (WebDAV) | 8090 | — | Unbegrenzter Upload |

## Nach der Installation

### 1. DNS konfigurieren

Alle Subdomains als A-Record oder CNAME auf die Server-IP zeigen lassen:

```
nginx.dopp.cloud  → <SERVER-IP>
vault.dopp.cloud  → <SERVER-IP>
photos.dopp.cloud → <SERVER-IP>
...
```

### 2. SSL-Zertifikate einrichten

Nginx Proxy Manager unter `https://nginx.{domain}` (oder `http://<SERVER-IP>:8081`) öffnen.
Für jeden Proxy Host:
- Edit → SSL → "Request a new SSL Certificate"
- "Force SSL" ist bereits aktiviert
- Let's Encrypt mit E-Mail-Adresse bestätigen

### 3. Zugriffsbeschränkungen (empfohlen)

Für Admin-Services (Nginx Admin, AdGuard) eine Access List anlegen:
- NPM → Access Lists → Add → Allow: `192.168.0.0/16`, `10.0.0.0/8`
- Dann bei den entsprechenden Proxy Hosts die Access List zuweisen

### 4. AdGuard Setup-Wizard

Beim ersten Start `http://<SERVER-IP>:3000` öffnen und den Setup-Wizard durchlaufen.
Admin-Port auf **8083** setzen (oder den in der Installation konfigurierten Port).

### 5. Geräte-DNS umstellen

Router-DNS oder Geräte-DNS auf `<SERVER-IP>:53` zeigen lassen,
damit AdGuard Home netzwerkweit Werbung blockiert.
