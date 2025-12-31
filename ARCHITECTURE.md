# Architecture

## Overview

ServiceBay is a Next.js application designed to manage containerized services using Podman. It provides a web interface for creating, monitoring, and managing services defined as Kubernetes Pod YAMLs (Quadlet style).

## Plugin Architecture

The dashboard (`/`) is built using a modular plugin architecture. This allows for easy extension of the dashboard with new features without cluttering the main page logic.

### Core Concepts

- **Plugin Interface**: Defined in `src/plugins/types.ts`.
  ```typescript
  export interface Plugin {
    id: string;
    name: string;
    icon: LucideIcon;
    component: ReactNode;
  }
  ```
- **Plugin Registry**: `src/plugins/index.tsx` exports an array of available plugins.
- **Layout**: The main page uses a two-column layout (Sidebar + Main Content) similar to the Registry browser.

### Current Plugins

1.  **Services**: Manages the core "containered services" (systemd units).
2.  **Running Containers**: Lists all active Podman containers.
3.  **System Info**: Displays CPU, Memory, OS, Network, and Disk Usage information.
4.  **System Updates**: Checks for available package updates (apt-based).
5.  **SSH Terminal**: A fully functional web-based terminal using `xterm.js` and `node-pty` over WebSockets.

### Server Architecture

To support the SSH Terminal (WebSockets), the application uses a custom Node.js server (`server.ts`) instead of the default Next.js server.

- **Entry Point**: `server.ts`
- **Technologies**: `http`, `socket.io`, `node-pty`, `next`.
- **Flow**:
  1.  HTTP requests are handled by Next.js.
  2.  WebSocket connections are handled by Socket.io.
  3.  Socket.io spawns a PTY process (bash/powershell) via `node-pty`.
  4.  Input/Output is piped between the browser (xterm.js) and the PTY process.

### Diagram

```mermaid
graph TD
    User[User Browser] -->|HTTP| Server[Custom Node Server]
    User -->|WebSocket| Server
    
    subgraph Server Process
        NextApp[Next.js App]
        SocketIO[Socket.io Server]
        PTY[node-pty Process]
    end
    
    Server -->|Route Request| NextApp
    Server -->|Upgrade Connection| SocketIO
    SocketIO <-->|Pipe I/O| PTY
    PTY <-->|Shell| System[System Shell]
    
    NextApp -->|Render| Page[src/app/page.tsx]
    Page -->|Imports| PluginRegistry[src/plugins/index.tsx]
```

## Registry & Installation

- **Local Registry**: Templates are read from `templates/` and `stacks/` directories.
- **Installation Flow**:
  1.  User selects a Template or Stack.
  2.  `InstallerModal` opens.
  3.  User configures variables (Mustache templates).
  4.  Backend generates systemd unit and YAML files.

## Update System

ServiceBay includes a self-update mechanism to keep the application current.

- **Versioning**: Uses CalVer (`YYYY.MM.DD`) based on the release date.
- **Source**: Updates are fetched from GitHub Releases (`mdopp/servicebay`).
- **Process**:
  1.  **Check**: Compares local `package.json` version with the latest GitHub Release tag.
  2.  **Download**: Fetches the release tarball (`servicebay-linux-x64.tar.gz`).
  3.  **Install**: Extracts and overwrites the application files in `~/.servicebay`.
  4.  **Restart**: Triggers `systemctl --user restart servicebay`.
- **Automation**: Can be configured to check and update automatically on a schedule (default: daily at midnight).

## Installation

The installation is handled by `install.sh`, which:
1.  Clones the repository or downloads the release tarball.
2.  Installs dependencies (`npm install`).
3.  Builds the application (`npm run build`).
4.  Sets up a user-level systemd service (`servicebay.service`).
5.  Prompts the user for a port (default: 3000).

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS.
- **Backend**: Next.js Server Actions & API Routes.
- **Server**: Custom Node.js server (`server.ts`) for WebSocket support.
- **Container Engine**: Podman (via CLI).
- **System Integration**: `systemd` for service management.

## Plugin Guidelines

- **Navigation**: For complex views (e.g., Logs, Terminal, Detailed Info), always navigate to a new page (e.g., `/containers/[id]/logs`) instead of using overlays or modals. Overlays should be reserved for simple interactions like confirmation dialogs or small forms.
- **Design**: Follow the [Design Principles](DESIGN_PRINCIPLES.md) for consistent UI/UX.

