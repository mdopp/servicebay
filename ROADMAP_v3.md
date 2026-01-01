# ServiceBay v3 Roadmap: Network & Nginx Integration

## Vision
Transform ServiceBay from a container manager into a complete **Edge Service Gateway**. 
v3 will treat **Nginx** as a first-class citizen (required dependency), managing the flow of traffic from the edge (Router/FritzBox) to the services.

## Core Features

### 1. Nginx Management (The "Ingress Controller")
- **Requirement**: Nginx must be installed on the host.
- **Discovery**: Auto-detect existing Nginx configuration (`/etc/nginx`).
- **Management**:
  - Parse `nginx.conf` and `conf.d/*.conf` / `sites-enabled/*`.
  - Visualize Virtual Hosts (Server Blocks).
  - **Action**: Create/Edit Proxy Hosts directly from ServiceBay (similar to Nginx Proxy Manager, but integrated).
  - **Linkage**: When creating a ServiceBay Service, automatically generate an Nginx config for it.

### 2. Network Visualization (The "Map")
- **Goal**: A visual graph showing the traffic flow.
- **Nodes**:
  - `Internet / Router (FritzBox)`
  - `Nginx (Entry Point)`
  - `ServiceBay Services (Systemd/Podman)`
  - `Containers (Backend)`
- **Edges**:
  - Show ports and protocols (e.g., `80/443 -> 3000`).
  - Show status (Green/Red based on monitoring).

### 3. Traffic Analysis
- **Access Logs**: Parse Nginx access logs to show:
  - Requests per second.
  - Top clients/IPs.
  - Error rates (4xx/5xx).
- **Real-time**: Use `tail` on access logs + WebSocket to stream traffic stats to the dashboard.

## Technical Implementation Plan

### Phase 1: Discovery & Prerequisites
1.  **Check**: Add `nginx` check to `install.sh` and startup routine.
2.  **Config Parsing**: Implement a parser for Nginx configuration files (e.g., using `@webantic/nginx-config-parser` or custom regex).
3.  **Structure**: Define a standard structure for ServiceBay-managed Nginx configs (e.g., `/etc/nginx/conf.d/servicebay/*.conf`).

### Phase 2: The Network Graph
1.  **Data Collection**:
    - **FritzBox**: Get WAN IP and Port Forwardings (via TR-064).
    - **Nginx**: Get Listen Ports and Upstream Targets.
    - **Podman**: Get Container Ports and IP addresses.
2.  **Visualization**: Use a library like `React Flow` or `Vis.js` to render the node graph.

### Phase 3: Configuration Management
1.  **UI**: Add "Expose Service" option in the Service Creator.
    - Domain Name (e.g., `app.local`).
    - SSL (Let's Encrypt integration? Or just self-signed/manual for now).
2.  **Backend**: Generate Nginx server blocks. Reload Nginx (`nginx -s reload`).

### Phase 4: Traffic Stats
1.  **Log Parsing**: Watch `/var/log/nginx/access.log`.
2.  **Dashboard**: Add "Network" tab to the Monitoring plugin or a new "Traffic" plugin.

## Questions for the User
1.  **Nginx Flavor**: Standard `nginx` package or a containerized Nginx? (Host-based seems implied by "voraussetzen").
2.  **SSL**: Should we handle SSL certificates (Certbot)?
3.  **FritzBox**: Do we want to *manage* port forwardings (UPnP) or just *read* them?

