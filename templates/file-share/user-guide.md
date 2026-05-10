---
icon: "📁"
tagline: "Share documents across phones, laptops, and the family — like a private Dropbox."
setup_assets:
  - kind: "syncthing_qr"
    label: "📷 Pair this Syncthing device"
    description: "Shows a QR code with the home server's device ID. The Android Syncthing app's \"Add Device → Scan QR\" picks it up directly."
recommended_apps:
  - name: "Syncthing"
    url: "https://syncthing.net/downloads/"
    platforms: ["desktop", "android"]
    note: "Two-way folder sync between your devices and the home server."
  - name: "Möbius Sync"
    url: "https://apps.apple.com/app/m%C3%B6bius-sync/id1539203216"
    platforms: ["ios"]
    note: "Syncthing-compatible iOS client — Apple doesn't allow Syncthing itself on iOS."
  - name: "Obsidian"
    url: "https://obsidian.md"
    platforms: ["desktop", "ios", "android"]
    note: "Markdown notes — point your vault at a Syncthing folder and notes auto-sync across every device."
  - name: "KOReader"
    url: "https://koreader.rocks/"
    platforms: ["android"]
    note: "Beautiful e-reader for PDFs / EPUBs / comics — opens files directly from a Syncthing folder."
  - name: "VLC"
    url: "https://www.videolan.org/vlc/"
    platforms: ["desktop", "ios", "android"]
    note: "Plays videos from the SMB share without downloading — pick \"Local Network\" → your server."
---

# Getting started with Files

This service runs three different ways to access your files. Pick the one that fits how you'd normally use it.

## In the browser (FileBrowser)

The simplest path — no setup. Click the *Open* button on this card, log in with the family password, and you see every shared folder. You can upload, download, rename, share links — like Dropbox's web UI.

Best for: occasional access, sharing a link with someone outside the family, mobile browsers.

## From a laptop or PC (Samba)

Mount the share like a network drive — files show up in your file manager natively.

**On Windows:** open File Explorer, type `\\<your-server>` in the address bar, and a shared folder appears.

**On macOS:** Finder → Go → Connect to Server → `smb://<your-server>` → mount.

**On Linux:** in your file manager, *Other Locations* → `smb://<your-server>`.

The username + password are the family ones. Once mounted, drag files in/out as you would with any folder.

Best for: working with large files (video, photos), where uploading through a browser would be slow.

## On your phone (Syncthing)

Syncthing keeps a folder on your phone in sync with the home server in both directions. Photos you take, documents you save — they appear on the server within minutes.

1. Install **Syncthing** (Android) or **Möbius Sync** (iOS) from the links above.
2. The app shows a *device ID*. Add ServiceBay's device ID (you'll find it in the FileBrowser web UI under *Settings → Sync*).
3. Pick which folders on your phone to sync.

Best for: continuous backup of phone documents, two-way sync between phone and laptop.

## Tips

- **The three methods see the same files.** Upload via the browser → it's there in Samba and in Syncthing immediately.
- **Phone storage is limited.** Syncthing supports *receive-only* folders so the server keeps everything but the phone only carries what you actively use.
