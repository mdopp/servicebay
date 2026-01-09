# Developer Changelog

This file tracks architectural changes, refactors, and developer-facing improvements.

## [Unreleased]

### Added
- **Frontend Tests**: Implemented comprehensive test suite using Vitest and React Testing Library. Covered Core Visualization (`ContainerList`, `ServiceMonitor`, `NetworkGraph`), Onboarding Wizard flow (`OnboardingWizard`), Configuration (`GatewayConfig`), and Responsive Layout (`Sidebar`, `MobileNav`, `MobileLayout`). Achieved passing status for all 20 tests.

### Fixed
- **Frontend**: Implemented intelligent service deduplication in `ServicesPlugin` to prevent duplicate "Reverse Proxy" cards when multiple service aliases (e.g., `nginx-web`, `nginx.service`) are reported by the Agent. Priority is given to Managed and Active services.
- **Frontend**: Added support for displaying Port Mappings on the Gateway Service card (e.g., FritzBox UPnP mappings).
- **Backend**: Updated `GatewayState` interfaces and `FritzBoxProvider` to propagate port mappings from the router to the Digital Twin.
- **Frontend**: Updated `ServicesPlugin` to correctly resolve "Managed" status for Remote Nginx services by handling the aliasing between service name (`nginx-web`) and Unit file (`nginx.kube`). Also improved YAML file linking to use the target YAML file referenced in the Unit file.
- **Frontend**: Updated `ServicesPlugin` to correctly identify Nginx and ServiceBay services from Agent V4 (which sends extension-less unit names) and recognize `isReverseProxy`/`isServiceBay` flags.
- **Agent V4:** Silenced "Parsed Nginx Routes" stderr logging which was spamming the console when file changes triggered frequent re-scans.
- **Agent V4**: Fixed a bug where file timestamp updates would trigger redundant state pushes even if the service/proxy configuration logic remained identical.
- **Agent Logging**: Suppressed verbose debug output (`STDERR: Process started`, `STDERR: Received command`) from the Python Agent in `AgentHandler` to reduce console noise.
- **NetworkService**: Enhanced Nginx container detection logic to validly identify containers matching Podman Kube naming conventions (`k8s_...`) and standard naming. This resolves issues where Nginx configuration parsing was skipped in the graph generation.
- **ServiceMonitor**: Fixed crash (`undefined.replace`) and enhanced handling of empty states with troubleshooting UI.
- **Frontend**: Standardized Service ID matching between URL and Graph Nodes to fix "Service Not Found" errors for services with variable extensions.
- **TypeScript**: Fixed widespread build errors in `NetworkService`, `NetworkPlugin`, and `SystemInfoPlugin` regarding legacy `any` types and property mismatches (e.g., `label` vs `name`, `source` vs `from`).
- **Tests**: Updated integration tests to match current Gateway implementation (`type: gateway`).
- **NetworkService**: Fixed `ExternalLink` edge definitions to comply with `NetworkEdge` interface.
- **Agent V4**: Updated `agent.py` to calculate and return `active` (boolean), `isReverseProxy`, and `isServiceBay` fields. This aligns the Agent output with the `ServiceInfo` interface and fixes the "Status DOWN" and missing Proxy identification in the Network Graph for the Local node.
- **Agent V4**: Updated `agent.py` to strip `.service` extension from service names to match `ServiceManager` behavior and ensure consistent IDs.
- **ServiceManager**: Improved systemd status parsing by explicitly fetching `ActiveState` and `SubState` via `systemctl show`. This sets the `active` flag correctly even if `systemctl is-active` behaves unexpectedly, resolving false "DOWN" states for Nginx services.
- **NetworkService**: Fixed crash when processing Digital Twin services (`TypeError: Cannot read properties of undefined (reading 'map')`) by adding safe access to `service.ports`.
- **NetworkService**: Fixed unnecessary fallback to legacy SSH execution by implementing a Global Singleton for `DigitalTwinStore`, ensuring state persists across Next.js server-side re-renders.
- **Agent Protocol Fix**: Resolved "Missing command" error by updating `AgentHandler.sendCommand` to wrap parameters in a `payload` object, aligning with the Python Agent V4 JSON protocol.
- **Agent Concurrency**: Implemented thread-safe I/O locking in `agent.py` to prevent JSON corruption ("Invalid JSON") when `SYNC_FULL` and `exec` responses occur simultaneously.
- **Frontend**: Enhanced `ContainersPlugin` to differentiate between "connected but syncing" and "empty state" using `isNodeSynced` from `useDigitalTwin`.

### Refactored
- **Agent V4**: Switched from polling file watcher to Linux `inotify` (via ctypes) for instant and efficient file change detection.
- **Logging**: Completed the migration from `console.log` to `src/lib/logger.ts` for all backend services (`Server`, `AgentHandler`, `FritzBox`, `GatewayPoller`, `Executor`, `SSH`, `Monitoring`). This ensures consistent, timestamped structured logging across the application.
- **Gateway Configuration**: Removed dependency on `FRITZBOX_USER`/`PASSWORD` legacy environment variables. Migrated `GatewayPoller` and `FritzBoxClient` to use the unified `config.json` via `getConfig()`.
- **UI**: Moved `GatewayConfig` from `RegistryBrowser` to `SettingsPage`. Refactored `GatewayConfig.tsx` to match the settings page "Card" design system.
- **Service Identification**: Updated `ServicesPlugin` to enforce "Reverse Proxy (Nginx)" naming and status text for the detected Nginx proxy provider.

### Optimized
- **System Monitoring**: Implemented "On-Demand Monitoring" for Agent V4.
    - Added `startMonitoring` and `stopMonitoring` commands to Agent.
    - Agent now only sends system resources (CPU/Mem/Disk) if monitoring is enabled by the backend.
    - Updates are throttled to max once per 10 seconds and only sent if values have changed.
    - Backend automatically toggles monitoring based on active client connections (`io.engine.clientsCount`).
- **NetworkService**: Refactored `getGraph` to consume data directly from the Digital Twin (memory) when available, reducing graph generation time from ~500ms to <10ms and eliminating SSH `exec` spam.
- **Agent V4**: Enhanced container fetching to include `pid` and host port mappings directly in the payload, removing the need for separate `ss` execution calls by the backend.

### Changed
- **Agent V4**: Updated `fetch_services` to only return services that correspond to managed Quadlet files (`.kube`, `.container`, `.pod`) in `~/.config/containers/systemd/`. This filters out unrelated user services from the dashboard.
- **Agent V4**: Extended `SystemResources` protocol to include `os` (hostname, platform, uptime) and `disks` (mount details).
- **Agent V4**: Updated `src/lib/agent/v4/agent.py` to collect detailed OS and Disk information using native Python libs and `df` command.
- **Frontend**: Refactored `SystemInfoPlugin.tsx` to read static system info directly from the Digital Twin, removing dependency on `getSystemInfo` and `getDiskUsage` API actions.

### Architecture
- **V4.1 Migration**: Started migration to "Reactive Digital Twin" architecture.
- **Store**: Implemented `DigitalTwinStore` singleton in `src/lib/store/twin.ts`.
- **Types**: Defined `AgentMessage` and node state types in `src/lib/agent/types.ts`.
- **Server**: Updated `server.ts` to integrate `DigitalTwinStore` and listen for `agent:message` events.

### Added
- Created `changelog.instructions.md` to enforce changelog updates.
- **Logger**: Added `src/lib/logger.ts` for structured, colorized logging. Refactored key components (`ServiceManager`, `ServicesPlugin`, `ServiceMonitor`, etc.) to replace `console.*` calls with `logger.*`.

### Fixed
- **ServicesPlugin**: Updated domain verification logic to strip ports from target URLs, fixing unmatched verified domains.
- **ServiceManager**: Updated service identification logic to include implicit services (marked `isReverseProxy`) even if they lack a `.kube` file.
- **Agent V4**: Updated `agent.py` to identify `nginx` container as a valid proxy container if `nginx-web` is missing.
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

### Frontend Refactor
- Refactored `ServicesPlugin.tsx` to use Reactive Digital Twin (`useDigitalTwin`).
  - Removed dependency on `useServicesList` and `useNetworkGraph`.
  - Implemented client-side filtering and enrichment of services.
  - Replaced API-based `discoverUnmanaged` with local Twin state filtering.
- Updated `useDigitalTwin` hook to expose `isConnected` and `lastUpdate` state.
- Fixed hook usage in `ContainersPlugin.tsx` and `ContainerList.tsx`.
