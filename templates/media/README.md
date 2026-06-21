# Media Stack

Jellyfin in a single pod — Music, Audiobooks, and optionally Video/Photos later. One media server, one robust LLDAP house login.

> **v5 (#1725):** Audiobookshelf is **retired for fresh installs**. Audiobooks are now served by Jellyfin (content type Books) at `/media/audiobooks`. Upgrades keep any existing ABS container + data untouched on disk — see the CHANGELOG. #1717's ABS OIDC self-heal still applies to those existing installs.

## Containers

1. **Jellyfin** — Music, Movies, Shows, and Audiobooks. Default port `8096`. Authenticates via **LDAP → LLDAP** (#1718) so the family signs in with their Authelia/LLDAP credentials; the local admin stays a break-glass login. Mobile apps (Symfonium, Findroid, Streamyfin) pair via **Quick Connect** — 6-digit code in the app, confirm once on the web UI, done.

   **Libraries auto-provision** on every deploy from how disk-import sorts the share: a **public** library per shared `file-share/data/<category>` (Music/Movies/Shows/Audiobooks — `photos` is Immich's, `documents`/`notes`/`files` are Filebrowser's), plus a **private** `<Category> (<user>)` library per `data/<user>/<category>` dir. Every user sees the public libraries; private libraries are visible only to their owner (new users auto-get the public set on first LDAP login).

## Default library paths

Jellyfin defaults to reading from the **file-share** stack's shared volume so anything dropped into Samba/Syncthing/FileBrowser shows up automatically:

| Variable | Default |
|---|---|
| `JELLYFIN_MEDIA_PATH`  | `/mnt/data/stacks/file-share/data` (whole tree, mounted read-only at `/media`) |

Folder names are lowercase by convention so they sit cleanly alongside the existing `notes/` sibling under the same data root — see #1018.

Jellyfin's post-deploy auto-adds two libraries: `/media/music` ("Music") and `/media/audiobooks` ("Books"). Both registrations are idempotent — a redeploy never duplicates them. Other folders (`movies/`, `tv/`, `photos/`) you add manually in **Dashboard → Libraries → Add Media Library** — Jellyfin's metadata sources differ per type, so we don't commit to a default.

Override `JELLYFIN_MEDIA_PATH` in the wizard's Configure step if your media lives elsewhere.

## Authentication

* **Jellyfin web UI + mobile** — LDAP → LLDAP (#1718). ServiceBay installs the LDAP-Authentication plugin and writes its config (host-side, every deploy → idempotent + self-healing) so family members sign in with their Authelia/LLDAP credentials. The local `admin` account (auto-seeded from `JELLYFIN_ADMIN_PASSWORD`) stays a working break-glass login.
* **Jellyfin mobile apps** — Quick Connect. Enabled automatically by post-deploy. In the app: sign-in screen → "Quick Connect" → app shows a 6-digit code → open Jellyfin web → Dashboard → Quick Connect → enter the code → app is paired.

## Subdomains

* `https://media.<your-domain>` → Jellyfin (LLDAP login; mobile apps via Quick Connect)

## Data Layout

```
{{DATA_DIR}}/media/
  jellyfin-config/          ← Jellyfin settings + user DB + plugin data
  jellyfin-cache/           ← Jellyfin transcoding cache (purge-safe)
  audiobookshelf-config/    ← (only on upgraded installs) ABS settings + DB — preserved, no longer started
  audiobookshelf-metadata/  ← (only on upgraded installs) ABS scan metadata cache — preserved
  navidrome.bak/            ← (only after v3 → v4 migration) old Navidrome data, safe to rm -rf
```
