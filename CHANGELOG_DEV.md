# Developer Changelog

This file tracks architectural changes, refactors, and developer-facing improvements.

## [Unreleased]

### Added
- Created `changelog.instructions.md` to enforce changelog updates.
- Added `scripts/load-env.ts` to bootstrap environment variables for the custom server.
- Added `services.smoke.test.ts`, `robustness.test.ts`, and `api.integration.test.ts` for regression testing.
- Implemented `AgentExecutor.spawn` for streaming command execution.
- Added `src/lib/manager_status.test.ts` to verify service status parsing logic.

### Changed
- **Auth**: Implemented `LOGIN_REQUIRED` environment variable support for development bypass.
- **Config**: Modifed `server.ts` to explicitly load `.env.local` via `@next/env`.
- Refactored `src/lib/network/service.ts` to suppress "container state improper" error during Nginx config fetch.
- Updated `src/app/api/services/route.ts` to inject global services (Gateway, External Links) on the **Default Node** instead of just "Local".
- Extracted `Executor` interface to `src/lib/interfaces.ts` to fix circular dependencies.
- Improved error handling in `listServices` to report "Agent not connected" to the UI.
- Refactored `src/lib/manager.ts` bash script generation to reliably report service status without appending "inactive" on failure conditions.
- Updated `src/lib/agent/handler.ts` to inject `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for remote agents, fixing `systemctl --user` commands in non-interactive SSH sessions.
- Enhanced `src/lib/manager.ts` to parse `PublishPort` and `Label` from Quadlet `.container` files (fallback when YAML logic is skipped).
- Standardized Reverse Proxy identification in `src/lib/network/service.ts` to use `isReverseProxy` flag (Source-Centric Truth).

### Fixed
- Fixed backend crash when fetching Nginx config from stopped containers.
- Fixed issue where Internet Gateway and External Links were missing from the dashboard when using remote nodes.
- Updated ServicePlugin.tsx to support composite key lookup for Service Graph nodes, fixing "Inactive" status and missing ports for services with mismatching display names vs IDs (e.g. Reverse Proxy vs nginx). 
- Fixed duplication bug where managed Quadlet containers (e.g., .container files) were incorrectly listed as "Unmanaged Services". Updated `discovery.ts` to recognize `.container` and `.pod` files in the systemd directory as managed. 

## [2026.1.68] - 2026-01-07
### Architecture
- Fixed strict type checking in `src/lib/executor.ts` (unknown error type).
- Dockerfile updated to run as root to comply with Quadlet UserNS=keep-id.

## [2026.1.65] - 2026-01-07
### Configuration
- Refactored `src/lib/config.ts` to export `SSH_DIR` pointing to persistent volume.
- Removed hardcoded `~/.ssh` paths in favor of persistent `/app/data/ssh`.

## [Unreleased] - 2026-01-08
### Architecture
- **V4 Migration (Phase 2)**: Started refactoring monolithic `manager.ts`.
- Created `src/lib/services/ServiceManager.ts` which uses the new V4 Agent Architecture.
- Migrated `listServices` and `saveService` logic to `ServiceManager`.
- Updated API routes (`src/app/api/services/route.ts`, `src/app/api/system/nginx/status/route.ts`) to use the new `ServiceManager`.
- Fixed duplicated code blocks in `src/lib/agent/agent.py`.
- Ensured linting compliance for new files.
