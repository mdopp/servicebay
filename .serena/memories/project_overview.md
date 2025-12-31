# Project Overview: ServiceBay

**ServiceBay** is a Next.js web interface designed to manage Podman Quadlet services (Systemd). It provides a dashboard for monitoring, creating, and managing containerized services.

## Key Features
*   **Dashboard**: Monitor services in `~/.config/containers/systemd/`.
*   **Registry**: Install services from templates.
*   **Editor**: YAML editor with validation.
*   **Management**: Start/stop/restart services, view logs.
*   **Terminal**: Web-based SSH terminal.
*   **System Info**: Resource usage monitoring.

## Architecture
*   **Frontend**: Next.js (App Router), React, Tailwind CSS.
*   **Backend**: Next.js Server Actions & API Routes.
*   **Server**: Custom Node.js server (`server.ts`) using `socket.io` and `node-pty` for terminal support.
*   **Container Engine**: Podman (via CLI).
*   **System Integration**: `systemd`.

## Plugin System
The dashboard uses a modular plugin architecture (`src/plugins/`).
*   **Services**: Core service management.
*   **Containers**: Running container list.
*   **System**: System resource info.
*   **Updates**: System package updates.
*   **Terminal**: SSH terminal.

## Navigation Guidelines
For complex views (Logs, Terminal, Detailed Info), navigate to a new page (e.g., `/containers/[id]/logs`) instead of using overlays. Overlays are for simple interactions (confirmations, small forms).
