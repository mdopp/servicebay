# Full Home Server Stack

Komplette Home-Server-Installation mit Reverse Proxy, DNS-Werbeblocker,
Passwort-Manager, Foto-Verwaltung, Dateifreigabe und Smart-Home.

## Included Services

- [x] nginx — Reverse-Proxy + automatische Let's-Encrypt-Zertifikate für alle Services
- [x] auth — LLDAP-Verzeichnisdienst + Authelia-SSO/2FA-Portal (zusammen, gemeinsamer Pod)
- [x] adguard — Netzwerkweiter DNS-Werbe- und Tracker-Blocker (DNS-Sinkhole)
- [x] vaultwarden — Selbst gehostetes Bitwarden: Passwörter, Notizen, TOTP, mit Apps für alle Plattformen
- [x] immich — Selbst gehostete Foto- und Video-Sicherung mit AI-Suche, Mobile-Apps und Auto-Upload
- [x] file-share — Datei-Sync (Syncthing) + Windows-Netzlaufwerk (Samba) + Web-Dateimanager (FileBrowser, SSO via Authelia)
- [x] home-assistant — Smart-Home-Hub, Z-Wave-/Matter-Bridges (Sprachassistent läuft im separaten `voice`-Template)
- [x] voice — Lokale Sprach-Pipeline (Wyoming: Faster Whisper STT + Piper TTS + openWakeWord); HA verbindet sich via `localhost:10300/10200/10400`
- [x] media — Musik (Navidrome / Subsonic-API) + Hörbücher & Podcasts (Audiobookshelf, eigene Mobile-Apps)
- [x] radicale — CalDAV/CardDAV-Server, authentifiziert direkt gegen LLDAP (DAVx⁵, iOS, Thunderbird)

## Reverse Proxy

Proxy routes werden automatisch via Nginx Proxy Manager konfiguriert.
Domain und Subdomains sind bei der Installation anpassbar.

| Subdomain | Service | Port | WebSocket | Besonderheiten |
|-----------|---------|------|-----------|----------------|
| nginx.{domain} | Nginx Proxy Manager | 8081 | — | LAN-Zugriff empfohlen |
| ldap.{domain} | LLDAP | 17170 | — | Benutzerverwaltung, LAN-Zugriff empfohlen |
| auth.{domain} | Authelia | 9091 | Ja | SSO-Portal, OIDC-Provider |
| vault.{domain} | Vaultwarden | 8222 | Ja | HTTP/2 deaktiviert (WS-Kompatibilität) |
| photos.{domain} | Immich | 2283 | Ja | Unbegrenzter Upload, lange Timeouts |
| dns.{domain} | AdGuard Home | 8083 | — | LAN-Zugriff empfohlen |
| home.{domain} | Home Assistant | 8123 | Ja | 24h Timeouts, kein Buffering |
| drive.{domain} | File Share (WebDAV) | 8090 | — | Unbegrenzter Upload |
| music.{domain} | Navidrome | 4533 | Ja | Subsonic-API für Mobile-Apps (siehe Template-README für Authelia-Bypass) |
| books.{domain} | Audiobookshelf | 13378 | Ja | Hörbücher + Podcasts, eigene Mobile-Apps |
| files.{domain} | FileBrowser | 8088 | — | Web-UI für die Samba-Freigabe; Authelia-SSO via auth_request (kein eigener Login) |
| caldav.{domain} | Radicale | 5232 | — | **Kalender UND Adressbücher** (CalDAV + CardDAV auf demselben Host — kein separates `carddav.`); auth direkt gegen LLDAP, kein Authelia (Mobile-Clients = Basic-Auth) |

## Nach der Installation

### 0. Routing-Modell entscheiden

Bevor du DNS / Port-Forwarding anfasst, kläre für dich:

| Modell | Wer kann zugreifen? | Voraussetzungen | Let's Encrypt? |
|---|---|---|---|
| **A — nur LAN** | Geräte im Heimnetz | Nichts am Router, AdGuard-Rewrite reicht | Nein (selfsigned reicht im LAN) |
| **B — öffentlich** | jedes Gerät weltweit | Public-DNS + Router-Port-Forward 80/443 | Ja (HTTP-01) |
| **C — Tailscale / WireGuard** | nur deine Geräte über VPN | VPN-Mesh statt Port-Forward | Optional (DNS-01 Challenge) |

Die Schritte unten sind für **Modell B**. Für A überspringst du DNS + Port-Forward und fügst stattdessen unter Schritt 4 einen AdGuard-Rewrite ein (`||dopp.cloud^$dnsrewrite=192.168.x.y`). Modell C ist außerhalb des Scope dieser Anleitung.

### 1. DNS konfigurieren

**Statische Public-IP**: bei deinem Domain-Registrar Wildcard-A-Record setzen, oder pro Subdomain einzeln:

```
*.dopp.cloud         → <PUBLIC-IP>
# oder einzeln:
nginx.dopp.cloud     → <PUBLIC-IP>
vault.dopp.cloud     → <PUBLIC-IP>
...
```

**Dynamische Public-IP** (Standard bei Telekom / Vodafone / 1&1): du brauchst Dynamic-DNS. Optionen:

- **MyFRITZ!** — kostenlos, FritzBox aktualisiert automatisch. Du bekommst eine Adresse wie `12345abcdef.myfritz.net`. Nachteil: kein Wildcard, du musst pro Subdomain einen CNAME bei deinem Registrar setzen, der auf den MyFRITZ!-Hostname zeigt.
- **DuckDNS / Cloudflare Dynamic DNS** — ein DDNS-Updater im Server (oder in der FritzBox unter Internet → Freigaben → DynDNS) hält den A-Record aktuell. Cloudflare erlaubt Wildcards.
- **Eigene Domain auf Cloudflare** + Cloudflare-DDNS-Updater im Container — entkoppelt dich vom Registrar und ermöglicht Wildcard-Records.

### 2. Port-Forwarding (FritzBox-Beispiel)

Für Modell B: der Router muss `:80` und `:443` von außen an deine Server-LAN-IP weiterleiten.

In der FritzBox:

1. **Internet → Freigaben → Portfreigaben → Gerät für Freigaben hinzufügen**
2. Gerät: deinen Server auswählen (oder LAN-IP eintragen, z.B. `192.168.178.100`)
3. **Neue Freigabe → Portfreigabe**
   - Anwendung: HTTP-Server, Protokoll: TCP, Port an Gerät: `80`, Port extern: `80`
   - Wiederholen für HTTPS: TCP, Port `443` → `443`
4. ⚠️ **Niemals Port 22 (SSH), 53 (DNS) oder 17170 (LDAP)** öffentlich freigeben — diese sind nur intern gedacht. Cert-Issuance über HTTP-01 (Port 80) und alle Web-Services laufen ausschließlich über 443.

> 🔒 **Sicherheit**: Bevor du 443 öffnest, stelle sicher dass alle Subdomains hinter Authelia (one\_factor mindestens, two\_factor für Admin-Services) liegen — die Authelia-Wildcard-Rule deckt das ab.

### 3. SSL-Zertifikate einrichten

Sobald DNS + Port-Forward stehen, in NPM (`https://nginx.{domain}` oder `http://<SERVER-IP>:8081`) für jeden Proxy Host:

- Edit → SSL → "Request a new SSL Certificate"
- "Force SSL" ist bereits aktiviert
- Let's Encrypt mit E-Mail-Adresse bestätigen → Certbot löst HTTP-01 Challenge automatisch

> 💡 Tipp: NPM kann auch ein Wildcard-Cert für `*.dopp.cloud` ziehen (DNS-01 Challenge), wenn dein DNS-Provider eine API hat (Cloudflare, Hetzner, …). Dann brauchst du Port 80 nicht offen zu halten.

### 4. Zugriffsbeschränkungen (empfohlen)

Für Admin-Services (Nginx Admin, AdGuard) eine Access List anlegen:
- NPM → Access Lists → Add → Allow: `192.168.0.0/16`, `10.0.0.0/8`
- Dann bei den entsprechenden Proxy Hosts die Access List zuweisen

### 5. Geräte-DNS umstellen

Router-DNS oder Geräte-DNS auf `<SERVER-IP>:53` zeigen lassen, damit AdGuard Home netzwerkweit Werbung blockiert.

### 6. LLDAP-User + Gruppen anlegen

Der ServiceBay-Wizard hat den LLDAP-Admin und die Gruppen `admins` + `family` automatisch erstellt. Damit deine Familie sich aber tatsächlich an Vaultwarden / Immich / Home Assistant anmelden kann, brauchst du **echte User**:

1. `https://ldap.{domain}` (oder `http://<SERVER-IP>:17170`) öffnen → Login mit `admin` + Auto-Gen-Passwort aus dem Install-Log
2. **Users → Create user** für jedes Familienmitglied
   - Mail-Adresse muss gesetzt sein (Authelia identifiziert User darüber)
   - Initial-Passwort vergeben
3. **Groups → admins** (für dich) und **Groups → family** (alle) → User reinpacken

Wer in `family` ist, kommt durch alle Subdomains außer `admin.`, `nginx.`, `dns.`, `ldap.` (die brauchen `admins`).

### 7. OIDC-SSO pro Service einschalten (optional)

Authelia ist als OIDC-Provider konfiguriert und ServiceBay registriert pro Service einen OIDC-Client (siehe jeweilige Template-README). In jedem Service muss du den Client einmalig einrichten:

- **Audiobookshelf**: Settings → Authentication → OIDC aktivieren, Issuer + Client-ID + Secret eintragen (Secret findest du in Authelia's `configuration.yml`)
- **Home Assistant**: per HACS-Integration `auth_oidc` oder vergleichbar
- **Vaultwarden**: kann OIDC nicht selber, aber Authelia-Wildcard-Rule schützt die Vault-UI

Ohne diesen Schritt bleibt jeder Service bei seinem eigenen Login-Formular — die Authelia-Wildcard-Rule schützt sie aber zumindest auf Browser-Ebene.
