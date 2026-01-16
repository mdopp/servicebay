# Containers

## Goal
Manage the lifecycle of Podman containers.

## Key Functions
- **List View**: See all running and stopped containers.
- **Control**: Start, stop, restart, and remove containers.
- **Logs**: View real-time logs for debugging.
- **Inspection**: View detailed JSON configuration of containers.
- **Network Mode**: Automatically detects if a container is running in `host` network mode.

## Network Modes
- **Bridge**: The default mode. Containers have their own IP and port mappings.
- **Host**: The container shares the host's network stack. No port mapping is required. ServiceBay tags these containers with "Host Network".

## Tips
- Use the node selector in the header to pivot between Local and remote nodes. The list always reflects the in-memory Digital Twin, so changes pushed by the agent show up instantly.
- Click the "Inspect" action to compare the raw Podman JSON with the rendered Quadlet definition when troubleshooting merges.
- Before removing a container permanently, trigger a **System Backup** from Settings so its Quadlet definition is safely archived.
