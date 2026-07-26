# Feature Proposal & Spec: Markdown-Driven Automated Music Downloader for ServiceBay

**Target Repo:** `mdopp/servicebay`  
**Feature ID:** `SB-FEAT-MEDIA-MARKDOWN-DOWNLOADER`  
**Status:** Feature Request / Specification & Implementation Plan

---

## 🎯 Goal & Problem Statement

Users maintain wishlists or procurement lists as Markdown files in their personal notes directory (e.g., `einkaufsliste_musik_alben.md` or `wishlist.md`).  
Currently, downloading missing music requires manually invoking `yt-dlp` or running custom scripts.

This feature introduces a ServiceBay background daemon / template extension that:
1. **Monitors a configured directory** of Markdown files for unchecked tasks (e.g. `- [ ] Artist - Album`).
2. **Automatically downloads audio** for missing tracks/albums via `yt-dlp`.
3. **Applies ID3 tagging & cover art** via `beets` / `mutagen`.
4. **Appends all tracks downloaded on that date** into a consolidated daily Jellyfin Playlist (e.g., `Downloads 2026-07-26`).
5. **Updates the Markdown source file**, checking off downloaded items (`- [x] Artist - Album`).

---

## 🛠️ System Architecture & Workflow

```mermaid
flowchart TD
    A[Markdown Wishlist File e.g. notes/wishlist.md] -->|1. File Watcher / Cron| B(ServiceBay Downloader Worker)
    B -->|2. Parse Unchecked Items - [ ]| C{Check Local Library}
    C -->|Already Exists| D[Mark Item as Checked - [x]]
    C -->|Missing| E[Trigger yt-dlp Audio Fetch]
    E --> F[Run beets / mutagen ID3 Tag & Cover Sync]
    F --> G[Move to /music/Artist/Album/]
    G --> H{Daily Playlist 'Downloads YYYY-MM-DD' Exists?}
    H -->|Yes| I[Append Tracks to Daily Playlist]
    H -->|No| J[Create Daily Playlist & Append Tracks]
    I --> D
    J --> D
    D -->|3. Rewrite Markdown File| A
    I -->|4. Trigger Jellyfin Scan| K(Jellyfin API /Library/Refresh)
    J -->|4. Trigger Jellyfin Scan| K
```

---

## 📋 Daily Playlist Behavior

- Playlist Name: `Downloads YYYY-MM-DD` (e.g. `Downloads 2026-07-26`).
- All downloads executed throughout the same calendar day accumulate into this single daily playlist.
- Multiple downloader runs on the same date append newly downloaded tracks without creating duplicate playlists.

---

## ⚙️ ServiceBay Template & Config Schema

Add the following environment variables to `templates/media/template.yml`:

```yaml
services:
  media-downloader:
    image: ghcr.io/mdopp/servicebay-media-downloader:latest
    environment:
      - MARKDOWN_SYNC_DIR=/data/mdopp/notes
      - MUSIC_TARGET_DIR=/data/music
      - JELLYFIN_URL=http://media:8096
      - CREATE_DAILY_PLAYLIST=true
      - CRON_SCHEDULE=0 */2 * * *
    volumes:
      - /mnt/data/stacks/file-share/data:/data
```

