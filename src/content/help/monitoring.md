# Monitoring

## Goal
Track the health and uptime of your services.

## Key Functions
- **Dashboard**: Overview of all monitored services.
- **Auto-Discovery**: Automatically finds services from Nginx and Podman.
- **Custom Checks**: Add HTTP or TCP checks for specific endpoints.
- **History**: View uptime history and response times.

## Best Practices
- Assign each check to a specific node so alerts can differentiate between Local and remote outages.
- Pair synthetic checks with the **System Backups** schedule to ensure you always have a recent archive before performing maintenance on a failing service.
- Use tags to group checks by stack (e.g., `immich`, `home-lab`) and filter dashboards quickly.
