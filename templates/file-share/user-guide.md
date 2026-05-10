---
icon: "📁"
tagline: "Share documents across phones, laptops, and the family — like a private Dropbox."
mobile_apps:
  - name: "Syncthing for Android"
    url: "https://play.google.com/store/apps/details?id=com.fsck.syncthing"
  - name: "Möbius Sync for iOS"
    url: "https://apps.apple.com/app/m%C3%B6bius-sync/id1539203216"
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
