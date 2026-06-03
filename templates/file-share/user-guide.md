---
# The `file-share` template ships three access paths — FileBrowser
# (browser), Samba (network drive), and Syncthing (continuous sync).
# Two cards so the family-portal "Open" button routes to the right
# tool: Files = the polished Dropbox-style web UI, Syncthing = the
# device-pairing daemon that lives on a separate subdomain. Samba
# has no web UI, so it stays in the shared body text below.
cards:
  - subdomain_var: "FILEBROWSER_SUBDOMAIN"
    label: "Files"
    lucide_icon: "folder-open"
    tagline: "Browse and share files in your browser — upload, download, and share links like a private Dropbox."

  - subdomain_var: "SYNCTHING_SUBDOMAIN"
    label: "Syncthing"
    lucide_icon: "refresh-cw"
    tagline: "Keep folders on your phone and laptop in sync with the home server — automatic two-way."
    setup_assets:
      - kind: "basicsync_install_qr"
        label: "Install BasicSync on your phone"
        description: "Point your phone camera at this QR to download the BasicSync app (a trusted, open-source Syncthing client). Step 1: install it. Then use the pairing QR below to connect."
      - kind: "syncthing_qr"
        label: "Pair this device"
        description: "Shows a QR code with the home server's device ID. In BasicSync, tap \"Add Device → Scan QR\" to pick it up directly. Step 2 — after BasicSync is installed. When the server asks where to store a synced folder, use /var/syncthing/Sync/<name> — that's your shared drive (also in Files and the \\\\server\\data network drive). Avoid the default ~/ path and /mnt/data — they're not the shared vault (~/ is config-only; /mnt/data doesn't exist inside the container)."
    recommended_apps:
      - name: "BasicSync"
        url: "/api/system/downloads/basicsync?abi=arm64-v8a"
        platforms: ["android"]
        note: "The recommended Android sync client — trusted, open-source, actively maintained. This link always grabs the latest build for arm64 phones; for older or x86 devices change ?abi= to armeabi-v7a, x86_64 or x86. (Or just scan the install QR above.)"
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

The simplest path — no setup. Click the *Open* button on the **Files** card, log in with the family password, and you see every shared folder. You can upload, download, rename, share links — like Dropbox's web UI.

Best for: occasional access, sharing a link with someone outside the family, mobile browsers.

## From a laptop or PC (Samba)

Mount the share like a network drive — files show up in your file manager natively.

**On Windows:** open File Explorer, type `\\<your-server>` in the address bar, and a shared folder appears.

**On macOS:** Finder → Go → Connect to Server → `smb://<your-server>` → mount.

**On Linux:** in your file manager, *Other Locations* → `smb://<your-server>`.

The username + password are the family ones. Once mounted, drag files in/out as you would with any folder.

Best for: working with large files (video, photos), where uploading through a browser would be slow.

## On your phone (BasicSync)

BasicSync keeps a folder on your phone in sync with the home server in both directions. Photos you take, documents you save — they appear on the server within minutes. It's a trusted, open-source Syncthing-compatible client — no need to hunt for an app in the store.

1. **Install the app.** On Android, scan the *Install BasicSync on your phone* QR on the **Syncthing** card (or tap the BasicSync link) — it downloads the APK directly. On iOS, install **Möbius Sync** from the link.
2. **Pair the device.** Open the **Syncthing** card, tap *Pair this device*, and in BasicSync use *Add Device → Scan QR* to scan it (the QR carries the home server's device ID).
3. Pick which folders on your phone to sync.

> **Where do synced folders live on the server?** Use `/var/syncthing/Sync/<name>` — that's the shared family drive, the same tree you see in **Files** and the `\\server\data` network drive. When a phone or laptop shares a folder *to* the server, Syncthing prefills the accept-path as `~/<folderid>`; change it to `/var/syncthing/Sync/<name>`. Avoid the `~/` default (that's the config volume — not on Files/Samba and not in the data backup) and `/mnt/data` (it doesn't exist inside the container, so the folder would sync to an empty throwaway dir). This vault is shared with everyone who has file-share access, so keep it for shared, not private, files.

Best for: continuous backup of phone documents, two-way sync between phone and laptop.

## Tips

- **The three methods see the same files.** Upload via the browser → it's there in Samba and in Syncthing immediately.
- **Phone storage is limited.** Syncthing supports *receive-only* folders so the server keeps everything but the phone only carries what you actively use.
