---
icon: "🎵"
tagline: "Stream your music collection and listen to audiobooks — offline-capable on phones."
mobile_apps:
  - name: "Audiobookshelf for iOS"
    url: "https://apps.apple.com/app/audiobookshelf/id1610212799"
  - name: "Audiobookshelf for Android"
    url: "https://play.google.com/store/apps/details?id=com.audiobookshelf.app"
  - name: "Symfonium for Android (music)"
    url: "https://play.google.com/store/apps/details?id=app.symfonik.music.player"
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
