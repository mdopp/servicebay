# ServiceBay

A Next.js web interface to manage Podman Quadlet services (Systemd).

## Features

- **Dashboard:** List and manage existing services in `~/.config/containers/systemd/`.
- **Monitoring:** Real-time health checks (HTTP/TCP), history visualization, and smart notifications.
- **Registry:** Install services from a GitHub template registry.
- **Editor:** Create and edit services with real-time YAML validation.
- **System Info:** View server resources (CPU, RAM, Disk) and manage OS updates.
- **Terminal:** Integrated web-based SSH terminal.
- **Mobile Ready:** Fully responsive design with dedicated mobile navigation.
- **Auto-Update:** Keep ServiceBay and your containers up to date.

## Installation

You can install ServiceBay with a single command:

```bash
curl -fsSL "https://raw.githubusercontent.com/mdopp/servicebay/main/install.sh?$(date +%s)" | bash
```

This will:
1. Clone the repository to `~/.servicebay`.
2. Build the application.
3. Install and start a user-level systemd service (`servicebay.service`).

The web interface will be available at [http://localhost:3000](http://localhost:3000).

## Reverse Proxy Configuration

If you are running ServiceBay behind a reverse proxy (like Nginx or Nginx Proxy Manager), you **must** configure it to support WebSockets and disable buffering for Live Logs (Server-Sent Events) to work correctly.

### Nginx Proxy Manager (NPM)
1. Edit the Proxy Host.
2. Enable **Websockets Support** in the "Details" tab.
3. Go to the **Advanced** tab and add the following to "Custom Nginx Configuration":
   ```nginx
   proxy_buffering off;
   proxy_request_buffering off;
   proxy_cache off;
   proxy_read_timeout 86400;
   ```

### Standard Nginx
Add the following to your `location /` block:
```nginx
location / {
    proxy_pass http://localhost:3000;
    
    # Required for Live Logs (SSE)
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;

    # Required for Terminal (WebSockets)
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    
    # Standard Headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Manual Development

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Documentation

- [Architecture & Tech Stack](ARCHITECTURE.md)
- [Frontend Design Principles](DESIGN_PRINCIPLES.md)

---

> **Note:** This project was completely **vibe-coded**. 🤙
