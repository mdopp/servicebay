# Media Stack

Audiobookshelf + Jellyfin in a single pod. Different libraries (audiobooks/podcasts vs music — and optionally video/photos later) but it's natural to enable them together — one stack to remember instead of two.

## Containers

1. **Audiobookshelf** — Audiobook + podcast library, web UI + native mobile apps. Default port `13378`. SSO via Authelia OIDC (auto-configured by post-deploy).
2. **Jellyfin** — Music (and optionally Video, Photos, Podcasts) library. Default port `8096`. Mobile apps (Symfonium, Findroid, Streamyfin) pair via **Quick Connect** — 6-digit code in the app, confirm once on the web UI, done. No shared passwords.

## Default library paths

Both containers default to reading from the **file-share** stack's shared volume so anything dropped into Samba/Syncthing/FileBrowser shows up automatically:

| Variable | Default |
|---|---|
| `ABS_AUDIOBOOKS_PATH`  | `/mnt/data/stacks/file-share/data/audiobooks` |
| `ABS_PODCASTS_PATH`    | `/mnt/data/stacks/file-share/data/podcasts` |
| `JELLYFIN_MEDIA_PATH`  | `/mnt/data/stacks/file-share/data` (whole tree, mounted read-only at `/media`) |

Folder names are lowercase by convention so they sit cleanly alongside the existing `notes/` sibling under the same data root — see #1018. Existing installs (pre-#1018) keep whatever path the operator originally accepted; the variable is wizard-overridable.

Jellyfin's post-deploy auto-adds `/media/music` (lowercase, matches the file-share Samba share layout) as a "Music" library. Other folders (`movies/`, `tv/`, `photos/`) you add manually in **Dashboard → Libraries → Add Media Library** — Jellyfin's metadata sources differ per type, so we don't commit to a default.

Override any of the paths in the wizard's Configure step if your media lives elsewhere.

## Authentication

* **Audiobookshelf** — OIDC via Authelia. ServiceBay registers the OIDC client and writes ABS's auth-settings via API. Just click "Login with Authelia".
* **Jellyfin web UI** — local admin account (auto-seeded from `JELLYFIN_ADMIN_PASSWORD`). For Authelia-redirect SSO on the web UI, install [`jellyfin-plugin-sso`](https://github.com/9p4/jellyfin-plugin-sso) manually (Dashboard → Plugins → Repositories → add the SSO repo).
* **Jellyfin mobile apps** — Quick Connect. Enabled automatically by post-deploy. In the app: sign-in screen → "Quick Connect" → app shows a 6-digit code → open Jellyfin web (logged in as admin) → Dashboard → Quick Connect → enter the code → app is paired.

## Subdomains

* `https://books.<your-domain>` → Audiobookshelf (SSO-gated via Authelia)
* `https://music.<your-domain>` → Jellyfin (local login; mobile apps via Quick Connect)

## Data Layout

```
{{DATA_DIR}}/media/
  audiobookshelf-config/    ← ABS settings + DB
  audiobookshelf-metadata/  ← ABS scan metadata cache
  jellyfin-config/          ← Jellyfin settings + user DB + plugin data
  jellyfin-cache/           ← Jellyfin transcoding cache (purge-safe)
  navidrome.bak/            ← (only after v3 → v4 migration) old Navidrome data, safe to rm -rf
```
