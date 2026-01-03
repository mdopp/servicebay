# Services

## Goal
Manage systemd services and background tasks.

## Key Functions
- **Service Control**: Start, stop, and restart system services.
- **Status**: View current status and logs of services.
- **Auto-Start**: Configure services to start on boot.
- **Migration**: Automatically detect unmanaged Podman containers and migrate them to Systemd services.
- **Merge Services**: Combine multiple unmanaged containers into a single managed Pod (Quadlet).

## Migration & Merging
ServiceBay automatically detects containers that are not managed by Systemd. You can:
1. **Migrate Single**: Click "Migrate" on an unmanaged service to generate a Systemd unit for it.
2. **Merge Multiple**: Select multiple unmanaged services and click "Merge Selected" to combine them into a single Pod. This is useful for stacks like `immich` or `nextcloud` that consist of multiple containers (app, db, redis) that should be managed together.
