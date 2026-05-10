---
# The `media` template hosts two services on different subdomains —
# Audiobookshelf at <books>.<domain> and Navidrome at <music>.<domain>.
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

  - subdomain_var: "NAVIDROME_SUBDOMAIN"
    label: "Music"
    lucide_icon: "music"
    tagline: "Stream your music collection — works with every Subsonic-compatible client."
    recommended_apps:
      - name: "Symfonium"
        url: "https://symfonium.app/"
        platforms: ["android"]
        note: "Best Subsonic-compatible music client on Android — paid, but worth it for car audio + offline play."
      - name: "play:Sub"
        url: "https://apps.apple.com/app/play-sub-music-streamer/id955329386"
        platforms: ["ios"]
        note: "Highly-rated Subsonic music client for iPhone — the iOS counterpart to Symfonium."
      - name: "Sonixd"
        url: "https://github.com/jeffvli/sonixd"
        platforms: ["desktop"]
        note: "Cross-platform Subsonic desktop client — great for big libraries on a laptop."
---

# Getting started with Media

Two services live behind this card:
- **Audiobookshelf** for audiobooks and podcasts.
- **Navidrome** for music.

Both have polished mobile apps that work offline once content is downloaded.

## Audiobooks (Audiobookshelf)

1. Install **Audiobookshelf** on your phone (links above).
2. Open it, tap *Add Server*, paste the URL from the *Open* button on this card (look for the audiobook subdomain — e.g. `http://audiobooks.home.arpa`).
3. Log in with the family password.
4. Tap a book → *Download* to keep it on the phone for offline listening (great for flights / commute).

Bookmarks, playback position, and listening history sync between devices — start in the car, finish on the couch.

## Music (Navidrome)

Navidrome serves your music collection over a protocol called **Subsonic**, which means dozens of apps work with it. Recommended:

- **Symfonium** (Android) — fast, polished, plays nicely with Bluetooth car audio. Paid app but worth it.
- **play:Sub** (iOS) — most-recommended Subsonic client on iPhone.
- **Browser** — Navidrome's web UI is good and works on every device without an app install.

In the app, configure a **Subsonic** server with the URL from the *Open* button (e.g. `http://music.home.arpa`) and the family credentials.

## Adding content

The admin drops audiobooks/podcasts into the server's **Audiobookshelf library folder** (browse via the *Files* card / Samba) and music into the **Navidrome music folder**. Both services pick up new files within a minute or two — no manual import.

## Tips

- **Offline downloads are per-device.** Downloading a book on your phone doesn't take it off the server; it's just cached locally.
- **Multiple users keep separate progress.** Each family member's listening position, bookmarks, and finished/unfinished list is private to them.
