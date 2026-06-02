---
# The `media` template hosts two services on different subdomains —
# Audiobookshelf at <books>.<domain> and Jellyfin at <music>.<domain>.
# One card per service so the family-portal "Open" button per row
# routes to the right place.
cards:
  - subdomain_var: "ABS_SUBDOMAIN"
    label: "Audiobooks"
    lucide_icon: "book-open"
    tagline: "Listen to audiobooks and podcasts — offline on your phone, with bookmark + progress sync between devices."
    setup_assets:
      - kind: "audiobookshelf_deeplink"
        label: "Open in Audiobookshelf app"
        description: "Pre-configures the server URL — works only after you've installed the app."
    recommended_apps:
      - name: "Audiobookshelf"
        url: "https://www.audiobookshelf.org/docs#mobile-apps"
        platforms: ["ios", "android"]
        note: "Official audiobook + podcast player. Bookmarks + progress sync between phone and tablet."

  - subdomain_var: "MEDIA_SUBDOMAIN"
    label: "Music"
    lucide_icon: "music"
    tagline: "Stream your music collection — pair mobile apps with Quick Connect, no shared password needed."
    recommended_apps:
      - name: "Symfonium"
        url: "https://symfonium.app/"
        platforms: ["android"]
        note: "Polished music client with first-class Jellyfin support — great for car audio + offline play. Paid, but worth it."
      - name: "Streamyfin"
        url: "https://apps.apple.com/app/streamyfin/id6593660679"
        platforms: ["ios"]
        note: "Native Jellyfin client for iPhone — music and video, with Quick Connect pairing."
      - name: "Findroid"
        url: "https://github.com/jarnedemeulemeester/findroid"
        platforms: ["android"]
        note: "Clean open-source Jellyfin client focused on video — pairs with the same Quick Connect flow."
---

# Getting started with Media

Two services live behind this card:
- **Audiobookshelf** for audiobooks and podcasts.
- **Jellyfin** for music (and optionally video and photos later).

Both have polished mobile apps that work offline once content is downloaded.

## Audiobooks (Audiobookshelf)

1. Install **Audiobookshelf** on your phone (links above).
2. Open it, tap *Add Server*, paste the URL from the *Open* button on this card (look for the audiobook subdomain — e.g. `http://audiobooks.home.arpa`).
3. Log in with the family password.
4. Tap a book → *Download* to keep it on the phone for offline listening (great for flights / commute).

Bookmarks, playback position, and listening history sync between devices — start in the car, finish on the couch.

## Music (Jellyfin)

Jellyfin serves your music collection (and video/photos if you add those libraries). Pick a client and pair it with **Quick Connect** — no shared password to type on the phone:

- **Symfonium** (Android) — fast, polished music client with great Jellyfin support and Bluetooth car audio. Paid app but worth it.
- **Streamyfin** (iOS) — native Jellyfin client for iPhone, music and video.
- **Browser** — Jellyfin's web UI works on every device without an app install.

**Pairing with Quick Connect:** open the Jellyfin app → *Quick Connect* → the app shows a 6-digit code → open Jellyfin web (signed in) → *Dashboard → Quick Connect* → enter the code. The app is paired — no password shared. (For SSO on the web login, the admin can install `jellyfin-plugin-sso` later.)

## Adding content

The admin drops audiobooks/podcasts into the server's **Audiobookshelf library folder** and music into the **file-share `music/` folder** (browse via the *Files* card / Samba). Jellyfin's library scan picks up `music/` automatically; Audiobookshelf picks up new files within a minute or two — no manual import. Other folders (`movies/`, `tv/`, `photos/`) the admin adds as Jellyfin libraries under *Dashboard → Libraries*.

## Tips

- **Offline downloads are per-device.** Downloading a book or album on your phone doesn't take it off the server; it's just cached locally.
- **Multiple users keep separate progress.** Each family member's listening position, bookmarks, and finished/unfinished list is private to them.
