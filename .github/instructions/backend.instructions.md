---
applyTo: "{src/lib/**/*.ts,server.ts,src/app/api/**/*.ts}"
---

# ServiceBay Backend Instructions

You are working on the **ServiceBay** backend (Node.js + Podman/Quadlet).

## Core Architecture
1.  **Quadlet-First**: Generate `.container`, `.kube`, `.network`, `.volume` files in `~/.config/containers/systemd/`.
    -   Do NOT use `podman run` commands for persistent services.
    -   Reload systemd after file changes: `systemctl --user daemon-reload`.
2.  **Container Context**: ServiceBay runs *inside* a container.
    -   **Paths**:
        -   Data: `/app/data` (mapped to host `~/.servicebay`).
        -   SSH Keys: `/app/data/ssh` (Persistent). Do NOT use `~/.ssh` or `/root/.ssh` for generated keys.
3.  **SSH / Remote Nodes**:
    -   "Local" node: The machine running ServiceBay.
    -   "Remote" nodes: Accessed via SSH `id_rsa`.
    -   Host Access: The container accesses the host via SSH to `host.containers.internal` or detected IP.
4.  **Digital Twin as Source of Truth**:
    -   **Enrichment**: Calculated properties (e.g., enriched `ports` merging YAML config + dynamic PID sockets) MUST be computed in `DigitalTwinStore` during ingestion (`enrichNode`).
    -   **Consumption**: Consumers (like `NetworkService`) MUST consume these enriched properties directly. DO NOT perform heavy logic, PID mapping, or port scans in viewing layers.
    -   **Discovery vs Assumptions**: Visual elements (labels, edges) must reflect discovered reality (e.g., actual listening ports via `ss` or Nginx config), not hardcoded defaults or assumptions just to "look nice".

## Registry & Templates
-   **Structure**: Every template or stack in `templates/` or `stacks/` MUST have:
    -   `template.yml` (for templates) or structure definition.
    -   `README.md`: This is the user-facing description shown in the UI. It is NOT for developers.
        -   Format: `# Title`, `## Description`, `## Variables` (if any).

## Performance
-   **Batching**: Combine SSH commands into single executions where possible.
-   **Concurrency**: Use `Promise.all` for independent operations.

## Testing & Quality Assurance
-   **Methodology**: Use **Vitest** for all backend testing.
-   **Location**: `tests/backend/`.
-   **Mocking**: Heavily mock external dependencies (`fs`, `ssh2`, `child_process`). Do NOT execute real commands on the host during tests unless explicitly creating an integration test.
-   **Robustness**:
    -   Validate all inputs entering the "Digital Twin Store".
    -   Ensure the "Agent Stream" parser handles malformed JSON without crashing the server (Circuit Breaker pattern).
-   **Regression Testing**: When fixing a bug, add a test case that reproduces the bug before fixing it.
