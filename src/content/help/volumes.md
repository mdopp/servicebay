# Volumes Plugin Help

The **Volumes Plugin** allows you to manage local and remote storage for your containers.

## Features
- **View Volumes:** List all Docker/Podman volumes across all your connected nodes.
- **Node Context:** See exactly which server/node a volume belongs to.
- **Create Volumes:** Easily create new named volumes or bind mounts.
- **Delete Volumes:** Remove unused volumes to free up space.
- **Data Path Awareness:** Quickly jump to the configured `DATA_DIR` for each template so you know what will be covered by external backups.

## Tips
- Use unique names for volumes to avoid confusion across nodes.
- Bind mounts (Host Path) are useful for persisting configuration files.
- Named volumes are better for database storage.
- Pair volume maintenance with the **System Backups** schedule: prune unused volumes first, then archive configs so restores never reference dead mounts.