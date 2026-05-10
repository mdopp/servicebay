---
icon: "🔒"
tagline: "Save passwords once, autofill them on every phone, browser, and laptop in the family."
mobile_apps:
  - name: "Bitwarden for iOS"
    url: "https://apps.apple.com/app/bitwarden-password-manager/id1137397744"
  - name: "Bitwarden for Android"
    url: "https://play.google.com/store/apps/details?id=com.x8bit.bitwarden"
---

# Getting started with Passwords

Vaultwarden uses the same apps as Bitwarden — install **Bitwarden** (links above) on every device and point it at your home server.

## On your phone (one-time setup)

1. Install **Bitwarden** from the App Store or Play Store.
2. Open it — tap the gear icon (Settings) at the top-left of the login screen.
3. Tap **Self-hosted** and paste the URL from the *Open* button on this card (e.g. `http://vault.home.arpa`) into **Server URL**. Save.
4. Back on the login screen, log in with the family password.
5. Set a strong **master password** when prompted — this is what unlocks the vault on this device. Different from your family password.

## In your browser

1. Install the **Bitwarden** browser extension from your browser's add-on store.
2. Click the icon → gear → **Self-hosted** → paste the same URL → save.
3. Log in.

That's it. Save a password once and it autofills everywhere.

## Tips

- **The master password unlocks the vault locally.** If you forget it, you have to re-set up the vault — even the family admin can't recover it. Pick something memorable.
- **Sharing is via Collections.** Make a "Family" collection and any password added there is visible to everyone in the family group.
- **Autofill works offline.** Vaultwarden syncs new entries when the network is back, but logging in still works without it.
