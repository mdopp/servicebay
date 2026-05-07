# Audiobookshelf — Audiobooks + Podcasts

Self-hosted server for audiobooks and podcasts. Has its own web UI, official iOS + Android apps, and also exposes a Subsonic-compatible API so apps like Symfonium can be pointed at it as a "music server" for audiobook listening.

## Variables

| Variable | Description | Default |
|---|---|---|
| `ABS_PORT` | Web UI + API port | `13378` |
| `TZ` | Timezone (used for podcast download schedules) | `Europe/Berlin` |
| `ABS_AUDIOBOOKS_PATH` | Host path to your audiobook library | `/mnt/data/stacks/file-share/data/Audiobooks` |
| `ABS_PODCASTS_PATH` | Host path where Audiobookshelf saves downloaded podcast episodes | `/mnt/data/stacks/file-share/data/Podcasts` |

Both library paths default into the **file-share template's Samba volume** — drop M4B/MP3 files into `Audiobooks/<Author>/<Title>/` from any device, refresh the library in Audiobookshelf, and they show up.

## Ports

| Port | Purpose |
|---|---|
| 13378 | Web UI + REST API + Subsonic API |

## Setup

1. Deploy via ServiceBay — the wizard auto-creates the root admin via Audiobookshelf's `/init` endpoint, so the first-launch wizard is skipped.
2. Open `https://books.<your-domain>` (or `http://<server-ip>:13378`)
3. Log in with the credentials shown in the install log (default user `root`, auto-generated password)
4. Add libraries:
   - `Audiobooks` → folder `/audiobooks` (mounted from `ABS_AUDIOBOOKS_PATH`)
   - `Podcasts` → folder `/podcasts` (mounted from `ABS_PODCASTS_PATH`)
5. Add podcast feeds: each library → ⋮ → "Add Podcast" → paste RSS URL

## Apps

| Platform | App | Notes |
|---|---|---|
| Android | **Audiobookshelf** (official, Play Store + F-Droid) | Best UX. Server URL = `https://books.<your-domain>`, regular login. |
| iOS | **Audiobookshelf** (official, App Store) | Same as Android. |
| Any Subsonic client (e.g. Symfonium) | Set type = Subsonic, URL = `https://books.<your-domain>`, login. | One app for music + audiobooks if you want a single player. |

## SSO via Authelia (OIDC)

Audiobookshelf supports OpenID Connect natively. ServiceBay auto-registers an OIDC client with Authelia when both are installed in the same stack — the client credentials end up in Authelia's `configuration.yml`. To finish wiring it up:

1. Open Audiobookshelf → **Settings** → **Authentication**
2. Enable **OpenID Connect**
3. Issuer URL: `https://auth.<your-domain>`
4. Client ID: `audiobookshelf`
5. Client Secret: (visible in Authelia's `configuration.yml` — under `identity_providers.oidc.clients`, look for `client_id: 'audiobookshelf'`, copy the `$plaintext$<value>` after `client_secret`)
6. Redirect URI: leave default (Audiobookshelf shows it back to you)
7. Save → log out → next browser login goes through Authelia

Mobile apps fall back to the Subsonic / built-in admin login as before.

## Authelia + mobile apps

Same caveat as Navidrome: the Audiobookshelf API endpoints (`/api/*`, `/socket.io/*`) cannot complete an interactive Authelia login from a mobile app. Either:

- **Use direct IP from mobile** (`http://<server-ip>:13378`) on LAN
- **Bypass Authelia for the API** by adding the following rules to Authelia's `configuration.yml` ahead of the wildcard rule:

  ```yaml
  access_control:
    rules:
      - domain: 'books.{{PUBLIC_DOMAIN}}'
        resources: ['^/api/.*', '^/socket\.io/.*', '^/feed/.*', '^/public/.*']
        policy: bypass
      - domain: 'books.{{PUBLIC_DOMAIN}}'
        policy: one_factor
        subject:
          - 'group:family'
          - 'group:admins'
  ```

  Restart Authelia after the change.

## Data Layout

```
{{DATA_DIR}}/audiobookshelf/
  config/             ← user DB, settings, server keys
  metadata/           ← cover art cache, transcoded segments

{{ABS_AUDIOBOOKS_PATH}}  ← your audiobook library
{{ABS_PODCASTS_PATH}}    ← downloaded podcast episodes
```

## Recommended Library Layout

```
Audiobooks/
└── Author Name/
    └── Book Title/
        ├── 01 - Chapter 1.m4b
        ├── 02 - Chapter 2.m4b
        └── cover.jpg

Podcasts/
└── (Audiobookshelf manages this; auto-downloads from RSS)
```

Audiobookshelf reads metadata tags but folder structure is the authoritative grouping for libraries.
