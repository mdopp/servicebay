# Navidrome — Music Server

Self-hosted music collection server with a web UI and a Subsonic-compatible API. Plays nicely with **Symfonium**, **Subsonic-Music-Player**, **DSub**, **play:Sub**, and any other Subsonic client.

## Variables

| Variable | Description | Default |
|---|---|---|
| `NAVIDROME_PORT` | Web + API port | `4533` |
| `NAVIDROME_MUSIC_PATH` | Host path to your music library | `/mnt/data/stacks/file-share/data/Music` |

The default music path is **inside the file-share template's Samba volume**. If you have file-share installed, you can drop MP3s/FLACs into the Samba share's `Music/` folder from any device and Navidrome will pick them up on its next scan (every hour by default).

## Ports

| Port | Purpose |
|---|---|
| 4533 | Web UI + Subsonic API (HTTP) |

## Setup

1. Deploy via ServiceBay — the wizard auto-creates the admin user via Navidrome's `/auth/createAdmin` endpoint
2. Open `https://music.<your-domain>` (or `http://<server-ip>:4533`)
3. Log in with the credentials shown in the install log (default user `admin`, auto-generated password)
4. Drop music files into the Samba share's `Music/` folder (or whatever you set `NAVIDROME_MUSIC_PATH` to)
5. Wait up to 1h for the first scan, or hit "Scan now" in Navidrome's settings

## Symfonium (Android) configuration

Add server in Symfonium:
- **Type**: Subsonic
- **URL**: `https://music.<your-domain>` (HTTPS, exact subdomain)
- **Username + password**: the admin user you registered

> ℹ️ Symfonium calls the Subsonic API directly (`/rest/*` endpoints). Authelia in front of the subdomain can interfere — see the **Authelia + Subsonic API** section below if your setup blocks mobile apps.

## Authelia + Subsonic API

The Subsonic API used by mobile apps is at `/rest/ping.view`, `/rest/getArtists.view`, etc. The default Authelia `*.{{PUBLIC_DOMAIN}}` rule (one_factor) will block these calls because mobile apps cannot complete an interactive login.

**Options**:

1. **Use direct IP from mobile** — configure Symfonium with `http://<server-ip>:4533`. Bypasses Authelia entirely. Works on LAN, not from outside the network.
2. **Bypass Authelia for `/rest/.*`** — edit Authelia's `configuration.yml` to add a path-specific bypass:

   ```yaml
   access_control:
     rules:
       - domain: 'music.{{PUBLIC_DOMAIN}}'
         resources: ['^/rest/.*', '^/share/.*']
         policy: bypass
       - domain: 'music.{{PUBLIC_DOMAIN}}'
         policy: one_factor
         subject:
           - 'group:family'
           - 'group:admins'
   ```

   Restart Authelia. Now web UI requires SSO, mobile apps go through with just Subsonic auth.

## Data Layout

```
{{DATA_DIR}}/navidrome/
  data/             ← SQLite DB, cache, transcoded files
{{NAVIDROME_MUSIC_PATH}}  ← your music library (read-only mount)
```

## Recommended Library Layout

```
Music/
├── Artist Name/
│   ├── Album Name (Year)/
│   │   ├── 01 - Track Title.flac
│   │   └── ...
```

Navidrome reads ID3 tags. Folder structure is for your convenience.
