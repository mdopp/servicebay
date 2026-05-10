---
icon: "📷"
tagline: "Auto-backup the photos on your phone and browse them like Google Photos — but private to your family."
recommended_apps:
  - name: "Immich"
    url: "https://immich.app/"
    platforms: ["ios", "android"]
    note: "Official mobile app — does the photo upload from your phone in the background. Install on every family member's phone."
---

# Getting started with Photos

The Immich web app shows every photo and video you've uploaded. The mobile app does the actual uploading from your phone — install it on every family member's device.

## On your phone (one-time setup)

1. Install **Immich** from the App Store or Play Store (links above).
2. Open the app — it asks for a **server URL**. Paste the URL from the *Open* button on this card (e.g. `http://photos.home.arpa`).
3. Log in with the family password.
4. In **Settings → Backup**, turn on **Foreground backup** (and **Background backup** on Android — iOS doesn't allow true background uploads, but the app catches up whenever you open it).
5. Pick which albums to back up. *Camera Roll* covers most cases.

That's it — your photos start syncing in the background. New photos taken on the phone show up on the web in a minute or two.

## In the browser

- **Photos** view — every photo, newest first. Pinch / scroll-zoom changes the timeline density.
- **Albums** — share specific moments. Albums are private by default; only people you explicitly share with can see them.
- **People** — Immich auto-recognizes faces over time. You can name people once and the app groups their photos for you.
- **Search** — type plain English ("dog beach", "birthday cake") — it works without a cloud service because the recognition runs on the home server.

## Tips

- **Storage is on the server.** Deleting a photo on your phone doesn't delete it from Immich — and vice versa. Move photos you want gone to the *Trash* in Immich; they're auto-purged after 30 days.
- **Multiple uploaders are fine.** Every family member can install the app and back up their own roll. Albums let you choose what to share.
- **You don't need to be at home.** As long as the family password works for SSO, the app uploads from anywhere.
