# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added `LOGIN_REQUIRED` configuration option to allow passwordless access in development or trusted environments (Default: true).
- **Logging**: Improved server logging format for better readability and debugging.

### Changed
- **Performance**: Optimized the Node Agent to use passive file watching (Inotify) instead of polling, improving system efficiency.
- **Config**: Moved **Internet Gateway** configuration from the Registry Browser to the main **Settings** page.
- **Gateway**: Internet Gateway configuration is now managed via the central settings file instead of environment variables.
- **Reverse Proxy**: Explicitly identifies "Nginx" as "Reverse Proxy (Nginx)" with status information in the services list.
- Improved error messages when a node agent is disconnected (now shows a helpful toast).
- Internet Gateway and External Links are now visible on your Default/Home server (previously only on Local).
- Unmanaged services list now displays the node/server name where they were discovered.
- Systemd service listing now performs a health check and reports an error if the user session is inaccessible (e.g., DBUS errors).
- **System Info**: The System Information panel now updates in real-time and loads instantly without manual refresh.
- **Services**: The service list now strictly shows only services managed by ServiceBay (Quadlet `.container`, `.kube`, and `.pod` files), hiding unrelated system services.

### Fixed
- **Agent**: Reduced log noise by quieting debug messages related to Nginx route parsing.
- **Stability**: Fixed a bug where the agent would excessively update the server when configuration files were touched but unchanged.
- **Network Graph**: Fixed Nginx Reverse Proxy node appearing detached or missing connections due to container naming mismatches in Podman Kube environments.
- Fixed an issue where the Nginx Reverse Proxy service would incorrectly show as "DOWN" in the Service Monitor despite being active.
- Added detailed "Active State" and "Sub State" fields to the Raw Data view in Service Monitor.
- Fixed internal error when one of the system containers is stopped. 
- Fixed Reverse Proxy service ports not showing up for some configurations. 
- **Fixed**: Fixed an issue where the "Verified Domain" badge was missing for services running on non-standard ports.
- **Fixed**: ServiceBay now correctly identifies the Nginx container even if named `nginx` instead of `nginx-web`.

## [2026.1.68] - 2026-01-07
### Fixed
- Type error in `executor.ts` causing build failure.
- Container running as root (UserNS=keep-id) to fix volume permission issues.
- Missing `npm run build` verification before release in instructions.

## [2026.1.66] - 2026-01-07
### Added
- Installer prompts for Host IP address.
- SSH troubleshooting hints in UI logs.
### Changed
- `install.sh` sets specific permissions on generated SSH keys.

## [2026.1.65] - 2026-01-07
### Added
- Persistent SSH key storage in `/app/data/ssh`.
- Auto-configuration of "Host" node in `install.sh`.
