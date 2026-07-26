# Feature Proposal & Ticket: ServiceBay Podcast Subscription & Scheduled Jobs Manager

**Target Repo:** `mdopp/servicebay` (ServiceBay / SolarisBay)  
**Feature ID:** `SB-FEAT-PODCAST-SCHEDULER`  
**Status:** Open Feature Request / Ticket & Architecture Spec

---

## 🎯 Summary & Objectives

This feature adds native **Podcast Subscription Management** and a centralized **Scheduled Jobs & Timers Dashboard** directly into ServiceBay (SolarisBay).

Instead of relying on unmanaged host OS systemd timers or external scripts, ServiceBay will:
1. **Manage Podcast Subscriptions:** Allow users to add, view, and manage RSS podcast feeds (e.g., *Lage der Nation*, *Logbuch Netzpolitik*) via ServiceBay UI and configuration files.
2. **Built-in Time-Controlled Downloader Engine:** Run automated podcast downloads, music syncs, and backup jobs using ServiceBay's managed job engine.
3. **UI Dashboard for Timers:** Display and manage all time-controlled downloaders, cron schedules, and active background timers in the ServiceBay Web UI.

---

## 🛠️ Feature Requirements

### 1. Podcast Subscription Management
- Users can subscribe to Podcast RSS feeds in the ServiceBay UI or `template.yml`.
- Configurable retention policy per podcast (e.g., *Keep last 5 episodes*, *Keep unplayed*).
- Target storage directory mapping (e.g., `/media/podcasts/`).

### 2. Scheduled Jobs & Timers Management UI
- **Dashboard View:** A dedicated "Timers & Scheduled Downloader" view in ServiceBay UI.
- **Job Status:** Displays last run time, next scheduled run, execution logs, and active status.
- **Controls:** Manual trigger ("Run Now"), enable/disable toggle, and schedule editor (cron expression / interval).

---

## ⚙️ ServiceBay Template & API Schema

### `templates/media/template.yml` Extension:
```yaml
services:
  podcast-manager:
    image: ghcr.io/mdopp/servicebay-podcast-manager:latest
    environment:
      - PODCAST_TARGET_DIR=/data/podcasts
      - JELLYFIN_URL=http://media:8096
      - DEFAULT_SCHEDULE=0 */6 * * *
    subscriptions:
      - name: "Lage der Nation"
        feed: "https://feeds.lagedernation.org/feeds/ldn-mp3.xml"
        keep_episodes: 5
      - name: "Logbuch Netzpolitik"
        feed: "https://logbuch-netzpolitik.de/feed/m4a"
        keep_episodes: 5
```

---

## 🚀 Implementation Plan

1. **Backend API Endpoints (`packages/server/src/routes/podcasts.ts`)**:
   - `GET /api/podcasts` -> List subscribed podcasts and episode download statuses.
   - `POST /api/podcasts/subscribe` -> Add new RSS feed.
   - `DELETE /api/podcasts/:id` -> Remove subscription.
   - `GET /api/timers` -> List all scheduled downloader timers and execution history.
   - `POST /api/timers/:id/run` -> Trigger manual execution.

2. **Frontend UI Component (`public/src/components/ScheduledJobsDashboard.tsx`)**:
   - Web UI view showing active timers, podcast subscriptions, next run times, and manual trigger controls.

3. **Background Job Engine Integration**:
   - ServiceBay worker process executing scheduled jobs and triggering Jellyfin library refreshes upon completion.

---

