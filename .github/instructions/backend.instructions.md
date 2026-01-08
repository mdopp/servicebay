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

## Registry & Templates
-   **Structure**: Every template or stack in `templates/` or `stacks/` MUST have:
    -   `template.yml` (for templates) or structure definition.
    -   `README.md`: This is the user-facing description shown in the UI. It is NOT for developers.
        -   Format: `# Title`, `## Description`, `## Variables` (if any).

## Performance
-   **Batching**: Combine SSH commands into single executions where possible.
-   **Concurrency**: Use `Promise.all` for independent operations.

## Testing & Quality Assurance
-   **Regression Testing**: When fixing a bug, you MUST update an existing test or add a new test case that reproduces the bug (and passes with the fix). This ensures the bug does not recur.
-   **Coverage**: Critical logic in `src/lib/` must have unit tests.
