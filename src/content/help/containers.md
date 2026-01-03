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
