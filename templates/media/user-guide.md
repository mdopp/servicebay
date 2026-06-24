---
# Jellyfin serves everything behind this template — music, audiobooks and
# (optionally) video/photos — on one subdomain. Audiobookshelf was retired
# (#1725/#1730); audiobooks are now a Jellyfin library, so the family portal
# shows ONE "Media" card whose Open button routes to Jellyfin. The legacy
# `books.<domain>` URL still resolves (it redirects to Jellyfin) but no longer
# gets its own tile.
cards:
  - subdomain_var: "MEDIA_SUBDOMAIN"
    label: "Media"
    lucide_icon: "headphones"
    tagline: "Music, audiobooks and video from your Jellyfin library — pair mobile apps with Quick Connect, no shared password needed."
    recommended_apps:
      - name: "Symfonium"
        url: "https://symfonium.app/"
        platforms: ["android"]
        note: "Polished music + audiobook client with first-class Jellyfin support — great for car audio + offline play. Paid, but worth it."
      - name: "Streamyfin"
        url: "https://apps.apple.com/app/streamyfin/id6593660679"
        platforms: ["ios"]
        note: "Native Jellyfin client for iPhone — music, audiobooks and video, with Quick Connect pairing."
      - name: "Findroid"
        url: "https://github.com/jarnedemeulemeester/findroid"
        platforms: ["android"]
        note: "Clean open-source Jellyfin client focused on video — pairs with the same Quick Connect flow."
---

# Getting started with Media

Everything here is served by **Jellyfin** — music, audiobooks, and optionally
video and photos. One server, one login, polished mobile apps that work offline
once content is downloaded.

## Pick an app and pair it

Pick a client and pair it with **Quick Connect** — no shared password to type on
the phone:

- **Symfonium** (Android) — fast, polished client for music *and* audiobooks, with Bluetooth car audio. Paid app but worth it.
- **Streamyfin** (iOS) — native Jellyfin client for iPhone: music, audiobooks and video.
- **Findroid** (Android) — clean open-source client focused on video.
- **Browser** — Jellyfin's web UI works on every device without an app install.

**Pairing with Quick Connect:** open the app → *Quick Connect* → the app shows a
6-digit code → open Jellyfin web (signed in) → *Dashboard → Quick Connect* →
enter the code. The app is paired — no password shared. (For SSO on the web
login, the admin can install `jellyfin-plugin-sso` later.)

## Audiobooks

Audiobooks are a Jellyfin library too — browse them in the same app, alongside
your music. Tap a book → *Download* to keep it on the phone for offline
listening (great for flights / commute). Playback position and finished/unfinished
state stay per-user, so each family member keeps their own progress.

## Adding content

The admin drops music into the **file-share `music/` folder** and audiobooks into
the **`audiobooks/` folder** (browse via the *Files* card / Samba). Jellyfin's
library scan picks them up automatically — no manual import. Other folders
(`movies/`, `tv/`, `photos/`) the admin adds as Jellyfin libraries under
*Dashboard → Libraries*.

## Tips

- **Offline downloads are per-device.** Downloading a book or album on your phone doesn't take it off the server; it's just cached locally.
- **Multiple users keep separate progress.** Each family member's playback position, bookmarks, and finished/unfinished list is private to them.
