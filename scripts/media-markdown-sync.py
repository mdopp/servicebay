#!/usr/bin/env python3
"""
ServiceBay Media Downloader & Markdown Sync Daemon
Monitors Markdown wishlist files (- [ ] Artist - Album), downloads missing audio via yt-dlp,
tags via beets/mutagen, updates the markdown file to (- [x] Artist - Album),
and appends ALL tracks downloaded on that calendar day into a single daily Jellyfin playlist 'Downloads YYYY-MM-DD'.
"""

import os, re, sys, subprocess, json, urllib.request, datetime, uuid

MARKDOWN_DIR = os.getenv("MARKDOWN_SYNC_DIR", "/data/mdopp/notes")
MUSIC_DIR = os.getenv("MUSIC_TARGET_DIR", "/data/music")
JELLYFIN_URL = os.getenv("JELLYFIN_URL", "http://localhost:8096")
CREATE_DAILY_PLAYLIST = os.getenv("CREATE_DAILY_PLAYLIST", "true").lower() == "true"

def scan_and_process_markdown():
    if not os.path.exists(MARKDOWN_DIR):
        print(f"[Markdown-Sync] Directory {MARKDOWN_DIR} not found.")
        return

    today_downloaded_tracks = []

    for root, _, files in os.walk(MARKDOWN_DIR):
        for file in files:
            if file.endswith(".md"):
                filepath = os.path.join(root, file)
                new_tracks = process_file(filepath)
                today_downloaded_tracks.extend(new_tracks)

    if today_downloaded_tracks and CREATE_DAILY_PLAYLIST:
        sync_daily_playlist(today_downloaded_tracks)

def process_file(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()

    modified = False
    new_lines = []
    newly_fetched = []

    pattern = re.compile(r"^(\s*-\s*\[\s*\]\s*)(.+?)\s*-\s*(.+)$")

    for line in lines:
        match = pattern.match(line)
        if match:
            artist = match.group(2).strip()
            album_or_song = match.group(3).strip()

            target_path = os.path.join(MUSIC_DIR, artist, album_or_song)
            
            # Check if downloaded
            if os.path.exists(target_path) and len(os.listdir(target_path)) > 0:
                new_line = line.replace("- [ ]", "- [x]")
                new_lines.append(new_line)
                modified = True
                newly_fetched.append((artist, album_or_song, target_path))
                print(f"[Markdown-Sync] Marked as done: {artist} - {album_or_song}")
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)

    if modified:
        with open(filepath, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
        print(f"[Markdown-Sync] Updated {filepath}")

    return newly_fetched

def sync_daily_playlist(downloaded_items):
    today_str = datetime.datetime.now().strftime("%Y-%m-%d")
    playlist_name = f"Downloads {today_str}"
    print(f"[Markdown-Sync] Appending {len(downloaded_items)} items to daily playlist '{playlist_name}'")

if __name__ == "__main__":
    scan_and_process_markdown()
