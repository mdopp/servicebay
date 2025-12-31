# ServiceBay

A Next.js web interface to manage Podman Quadlet services (Systemd).

## Features

- **Dashboard:** List and monitor existing services in `~/.config/containers/systemd/`.
- **Registry:** Install services from a GitHub template registry.
- **Editor:** Create and edit services with real-time YAML validation.
- **Management:** Start, stop, restart, and view logs of your services.
- **Auto-Update:** Configure Podman AutoUpdate for your containers.

## Installation

You can install ServiceBay with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/install.sh | bash
```

This will:
1. Clone the repository to `~/.servicebay`.
2. Build the application.
3. Install and start a user-level systemd service (`servicebay.service`).

The web interface will be available at [http://localhost:3000](http://localhost:3000).

## Manual Development

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

---

> **Note:** This project was completely **vibe-coded**. 🤙
