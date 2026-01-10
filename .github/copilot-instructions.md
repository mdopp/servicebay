# ServiceBay Copilot Instructions

You are an expert developer working on **ServiceBay**, a web-based management interface for Podman containers using **Quadlet** (systemd integration).

## Helpfull tools
- **semantic code retrieval and editing tools:** Use **Serena** mcp, for code-centric tools like find_symbol, find_referencing_symbols and insert_after_symbol
- **Frontend Testing:** Use **Chrome DevTools** for inspecting and debugging the Next.js frontend.

## Tech Stack
- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Icons:** Lucide React
- **Runtime:** Node.js
- **Container Engine:** Podman (Rootless)

## Core Architecture Principles
1.  **Reactive Digital Twin (V4):** The system operates on a "Push" model.
    -   **Agent**: A Python script on the node pushes state changes (Containers, Services, Files) to the Backend.
    -   **Store**: The Backend maintains an in-memory "Digital Twin". The UI reads ONLY from this store, never polling the node directly.
    -   **Reliability**: The backend implements a "Circuit Breaker" to handle malformed agent streams.
2.  **Kube-First (Podman Kube):** We STRICTLY use `*.kube` files (referencing Pod YAMLs) for all managed services.
    -   We **DO NOT** use `*.container` files (Simple Quadlets).
    -   We **DO NOT** use `podman run` or `docker-compose` directly.
    -   Any `*.container` files or raw containers are considered **Unmanaged** and should be migrated to `*.kube` stacks.
3.  **Systemd Management:** Services are managed via `systemctl --user`. Reloading the daemon (`systemctl --user daemon-reload`) is required after file changes.
4.  **Multi-Node Support:** The application manages the local machine and remote nodes via SSH.
    - Always consider the `nodeName` context.
    - "Local" refers to the machine running ServiceBay.
    - Remote nodes are accessed via SSH keys (strictly `id_rsa` or configured identity files).
5.  **Source-Centric Truth:** Logic for identifying data properties (e.g., "Active Status", "Service Role") must reside as close to the source as possible (e.g., the Manager parsing layer) and be exposed as flags/fields. Upper layers (API/UI) should consume these flags rather than re-implementing identification logic. This ensures a single source of truth across the stack.

## Coding Guidelines

**Note:** Specific guidelines for Frontend, Backend, and Releases are located in `.github/instructions/*.md`.

### Testing Strategy
-   **Backend:** Use **Vitest**. Focus on Robustness (streams, Store validation) and API integration. Mock external dependencies (`fs`, `ssh2`).
-   **Frontend:** Use **Vitest + React Testing Library**. Focus on "Integration over Implementation". Mock `useDigitalTwin` to inject test scenarios.
-   **API:** Implement basic endpoint tests to verify critical paths.
-   **Type Safety:** Strictly type all interfaces. Fix linting errors before committing.

## Specific Implementation Details
-   **Services:** A "Service" is a Podman Quadlet (systemd service).
-   **Templates:** YAML templates stored in `templates/`.
-   **Nginx:** Managed as a Podman pod (`nginx-web`). No host `nginx` package.
-   **Gateway/Links:** Only valid for the **Local** node.

## File Structure
- `src/app`: Next.js App Router pages and API routes.
- `src/lib`: Backend logic (Podman manager, SSH executor, config).
- `src/components`: React client components.
- `templates`: Built-in service templates.

## Migrated Context (from README/ARCHITECTURE)
-   **Plugin Architecture:** Dashboard features are modular (see `src/plugins/`).
-   **Server:** Custom `server.ts` handles WebSockets (Socket.IO) + Next.js.
-   **Client Data:** `DigitalTwinProvider` handles deduplication and stale-while-revalidate fetching.
-   **Monitoring:** `MonitoringGateway` handles discovery and polling.
-   **Reverse Proxy:** Requires WebSocket support and `proxy_buffering off` for SSE.

When suggesting changes, always verify if the change affects remote node compatibility or requires a systemd daemon reload.

