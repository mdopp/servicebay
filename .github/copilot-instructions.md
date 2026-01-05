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
1.  **Quadlet-First:** We do not use `podman run` or `docker-compose` directly. We generate `.container`, `.kube`, `.network`, and `.volume` files in `~/.config/containers/systemd/`.
2.  **Systemd Management:** Services are managed via `systemctl --user`. Reloading the daemon (`systemctl --user daemon-reload`) is required after file changes.
3.  **Multi-Node Support:** The application manages the local machine and remote nodes via SSH.
    - Always consider the `nodeName` context.
    - "Local" refers to the machine running ServiceBay.
    - Remote nodes are accessed via SSH keys (strictly `id_rsa` or configured identity files).
4.  **Containerized Infrastructure:** ServiceBay itself runs as a container. Nginx (Reverse Proxy) is also deployed as a container (`nginx-web`), not a host package.

## Coding Guidelines
- **Performance:**
    - **Batch SSH Commands:** Remote operations are high-latency. Combine multiple shell commands into a single script execution when possible (see `src/lib/manager.ts`).
    - **Parallel Fetching:** Use `Promise.all` for independent data fetches in API routes.
- **UI/UX:**
    - Support **Dark Mode** for all components using Tailwind's `dark:` modifiers.
    - Use `lucide-react` for icons.
    - Use the `useToast` hook for user notifications/errors.
- **Type Safety:**
    - Strictly type all interfaces, especially for API responses and Service configurations.
    - Avoid `any` wherever possible.

## Specific Implementation Details
- **Services:** A "Service" in this context is usually a Podman Quadlet (systemd service).
- **Templates:** We use YAML templates stored in `templates/` or external registries.
- **Nginx:** The reverse proxy is a Podman pod named `nginx-web`. Do not suggest installing `nginx` via `apt`/`yum`.
- **Gateway/Links:** "Internet Gateway" (FRITZ!Box) and "External Links" configurations are only valid for the **Local** node.

## File Structure
- `src/app`: Next.js App Router pages and API routes.
- `src/lib`: Backend logic (Podman manager, SSH executor, config).
- `src/components`: React client components.
- `templates`: Built-in service templates.

When suggesting changes, always verify if the change affects remote node compatibility or requires a systemd daemon reload.

