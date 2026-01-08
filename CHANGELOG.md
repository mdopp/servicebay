# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added `LOGIN_REQUIRED` configuration option to allow passwordless access in development or trusted environments (Default: true).

### Changed
- Improved error messages when a node agent is disconnected (now shows a helpful toast).
- Internet Gateway and External Links are now visible on your Default/Home server (previously only on Local).
- Unmanaged services list now displays the node/server name where they were discovered.
- Systemd service listing now performs a health check and reports an error if the user session is inaccessible (e.g., DBUS errors).

### Fixed
- Fixed internal error when one of the system containers is stopped. 
- Fixed Reverse Proxy service ports not showing up for some configurations. 

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
