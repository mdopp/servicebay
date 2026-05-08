# Media Stack

Audiobookshelf + Navidrome in a single pod. They serve different libraries (audiobooks/podcasts vs music) but it's natural to enable them together — one stack to remember instead of two.

## Containers

1. **Audiobookshelf** — Audiobook + podcast library, web UI + native mobile apps. Default port `13378`.
2. **Navidrome** — Music library + Subsonic-API endpoint. Default port `4533`. Subsonic-compatible apps like Symfonium / Substreamer / play:Sub work out of the box.

## Default library paths

Both containers default to reading from the **file-share** stack's shared volume so anything dropped into Samba/Syncthing/FileBrowser shows up automatically:

| Variable | Default |
|---|---|
| `ABS_AUDIOBOOKS_PATH` | `/mnt/data/stacks/file-share/data/Audiobooks` |
| `ABS_PODCASTS_PATH`   | `/mnt/data/stacks/file-share/data/Podcasts` |
| `NAVIDROME_MUSIC_PATH` | `/mnt/data/stacks/file-share/data/Music` |

Override any of these in the wizard's Configure step if your media lives elsewhere.

## SSO

Both have authelia integration:

* **Audiobookshelf** — OIDC via Authelia. ServiceBay registers the OIDC client; you paste the `ABS_OIDC_SECRET` shown in the install log into **Settings → Authentication → OpenID Connect**.
* **Navidrome** — reverse-proxy SSO via the `Remote-User` header (limited to the loopback subnet). The Subsonic API uses Navidrome's own user/password.

## Subdomains

* `https://books.<your-domain>` → Audiobookshelf
* `https://music.<your-domain>` → Navidrome

## Data Layout

```
{{DATA_DIR}}/media/
  audiobookshelf-config/    ← ABS settings + DB
  audiobookshelf-metadata/  ← ABS scan metadata cache
  navidrome/                ← Navidrome scan DB
```
