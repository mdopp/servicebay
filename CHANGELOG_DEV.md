# Developer Changelog

This file tracks architectural changes, refactors, and developer-facing improvements.

## [Unreleased]

## [2026.1.70] - 2026-01-12
- **CI**: Fixed incorrect `npm test` command in GitHub Actions workflow (removed redundant `run` argument).
- **Ops**: Added sanitized FCOS template (`fedora-coreos.bu`) and interactive installer `install-fedora-coreos.sh` that prompts for SSH keys, hashes console passwords, renders Butane→Ignition, and serves it via a temporary HTTP server with the install command.
- **Security**: Implemented transparent configuration encryption (AES-256-GCM). Passwords in `config.json` are now stored as `enc:v1:...` using a machine-local key (`data/secret.key`).
- **Refactor**: Extracted `DATA_DIR` and `SSH_DIR` constants to `src/lib/dirs.ts` to prevent circular dependencies in the new security module.
- **Server**: Enhanced Host Terminal robustness by defaulting shell to `process.env.SHELL` (or strict path) and validating `cwd` (Home directory) existence with a fallback to `/`. This prevents `execvp(3)` failure in restricted environments.
- **Agent V4**: Implemented `get_cpu_info` to parse `/proc/cpuinfo` for detailed CPU model and core count. Updated `SystemResources` dataclass and `get_system_resources` to include this data.
- **Frontend**: Updated `SystemInfoPlugin` to display CPU Model and Core count in the "Compute Resources" section.
- **Templates**: Added global template settings schema (`templates/settings.json`) with required `STACKS_DIR` and exposed a Template Settings section in the UI to persist variables (defaults shown, custom vars allowed; changes apply to new deployments).
- **Network Map**: Added support for "Virtual Nodes" for Nginx targets that do not match any managed container.
  - **Internal Services**: Targets pointing to localhost are shown as internal nodes with a warning status.
  - **External Services**: Targets pointing to external IPs are shown as device nodes.
  - **Action**: Added "Add Link" button to missing external nodes to easily save them as External Link services.
- **Network Map**: Improved Nginx target resolution to fallback to virtual nodes instead of ignoring unknown destinations.
### Known Issues
- **Network Graph**: Currently not rendering correctly. FritzBox node is missing, and edges are displaying incorrect relationships.
- **Unmanaged Services**: Search logic needs refactoring. Ideally, discovery should start from running services -> check for `.service` file -> confirm Podman container backing -> mark as Unmanaged.

- **Architecture**: Refactored Nginx Service Node creation (`src/lib/network/service.ts`) to strictly use the Digital Twin Store's `proxyService` object, eliminating hardcoded fallback ports (:80, :443) and ensuring strict Single Source of Truth adherence.
- **Agent V4**: Fixed missing runtime ports (e.g. Nginx :81) caused by `ss` command output variability in some environments. Added robust column detection logic to `get_host_ports_map`.
- **Agent V4**: Fixed missing or empty ports for Stopped Quadlet Services. Implemented robust line-based YAML parsing in `agent.py` to extract `containerPort` and `hostPort` from K8s manifests (referenced by `.kube` files) when runtime container data is unavailable.
- **Backend / Digital Twin**: Fixed a bug in `enrichService` (`src/lib/store/twin.ts`) where runtime discovered ports were ignored if a service was identified as a proxy. Removed the premature return to correctly merge runtime ports (e.g., :81) with configured ports.
- **Network Graph**: Refactored Nginx Proxy "Edge Label" (Connection from Router) to use discovered listening ports (from Agent Nginx config) instead of a hardcoded `:80, :443` string.
- **Network Graph**: Refactored Nginx Proxy Node port calculation to strictly use `ports` from Digital Twin Store, removing ad-hoc logic in `Service.ts`.
- **Docs**: Updated `backend.instructions.md` to explicitly forbid "nice-to-have" assumptions in favor of "Discovery-First" visualization.
- **Architecture**: Enforced Single Source of Truth for Network Calculations.
  - Refactored `DigitalTwinStore` to include an `enrichNode` step that calculates `ports` (merging Config + Runtime PIDs) and `effectiveHostNetwork`.
  - **API**: Removed redundant `effectivePorts` property; `ports` now serves as the Single Source of Truth.
  - Refactored `NetworkService` to remove complex calculation logic and strictly consume enriched properties from the Twin Store.
  - Updated `ServiceUnit` interface to support these enriched properties.
- **Frontend**: Fixed bug in `ContainersPlugin.tsx` where port data was being mapped using camelCase `hostPort` keys instead of the snake_case `host_port` keys sent by Agent V4.
- **Frontend**: Enforced strict "Raw Data Sovereignty" check in `ServicesPlugin`. Service Cards now only display ports/labels if an explicit `associatedContainerIds` link exists. Removed ALL name-based guessing/fuzzy logic for container linking.
- **Frontend**: Removed speculative port guessing for system services. Ports now strictly reflect runtime `podman inspect` data.
- **Frontend**: Removed hardcoded Nginx file-aliasing logic. Service Cards now strictly look for Quadlet files matching the Service Name (e.g. `nginx.service` -> `nginx.kube`).
- **Agent V4**: Updated `fetch_containers` to handle primitive port lists (e.g., `[80, 443]`) frequently encountered in Host Network scenarios. These are now normalized to `{host_port, container_port, protocol}` objects before being sent to the Digital Twin, ensuring consistent data shape across the stack.
- [NetworkService] Deleted `ports` property from NetworkNode interface and all internal node creation logic.
- Deleted main fallback logic in NetworkService. Strict Twin data only.
- IMPLEMENTED Strict Service-Container Mapping in DigitalTwinStore (Single Source of Truth).
- Refactored Network Graph node IDs to use cleaner "service-" prefix instead of "group-service-".
- **Agent V4**: Fixed critical data acquisition issues in `agent.py` for Podman v4.9.x environments.
  - Implemented side-channel `podman ps --format "{{.ID}}|{{.PodName}}"` to resolve missing Pod Names.
  - Implemented side-channel `podman inspect` bulk retrieval to correctly detect `hostNetwork` mode, bypassing broken `Networks: []` output in `podman ps` JSON.

### Added
- **API**: Updated `GET /api/services` to output a structured "Gateway" object for the Reverse Proxy service. This object adopts a flattened structure (inheriting `ServiceInfo`) extended with a `servers` list containing the operational Nginx routing table.
- **Docs**: Added comprehensive Data Lineage section to `ARCHITECTURE.md` including a Mermaid diagram visualizing the flow from Agent V4 objects to Digital Twin Store and React Frontend.
- **Frontend Tests**: Implemented comprehensive test suite using Vitest and React Testing Library. Covered Core Visualization (`ContainerList`, `ServiceMonitor`, `NetworkGraph`), Onboarding Wizard flow (`OnboardingWizard`), Configuration (`GatewayConfig`), and Responsive Layout (`Sidebar`, `MobileNav`, `MobileLayout`). Achieved passing status for all 20 tests.
- **Tests**: Extended test suite with `tests/backend/test_agent_host_ports.py` to verify Agent V4 port detection logic for Host Networking containers, ensuring discrepancies between `podman ps` and `ss` are resolved.
- **Tests**: Added `tests/backend/agent_data_flow.test.ts` to verify End-to-End data persistence in `DigitalTwinStore`, confirming that Agent-detected ports are correctly stored and linked to services.
- **Agent V4 Fix**: Updated Service Logic to support fuzzy matching for Quadlet-generated container names (e.g., `systemd-nginx-web` -> `nginx-web`), ensuring proper Service <-> Container linking and Port propagation for Nginx and other host-network services.
- **Tests**: Extended `test_agent_service_linking.py` to cover `systemd-` prefix scenarios, confirming the fix.
- **Tests**: Added `tests/frontend/ServicesPlugin_Twin.test.tsx` to simulate full E2E data flow. Verified that when `useDigitalTwin` receives the correctly linked data (which the fixed Agent now provides), the Frontend `ServicesPlugin` correctly renders the ports (e.g., `8080`).
- **Tests**: Updated `scripts/test-agent.sh` to execute the Python logic verification tests within the containerized environment.

### Fixed
- **Network Graph**: Fixed the "Raw Data" structure for the Reverse Proxy node to be strictly flat. Previously, it nested the `service` object, causing UI inconsistencies. Now, all service properties (status, description, etc.) are merged at the top level alongside the `servers` routing table, ensuring consistency with the standard `ServiceInfo` interface throughout the application.
- **Frontend Consistency**: Removed all fuzzy matching logic from `ServiceMonitor`. The UI now locates the corresponding graph node using strict equality on `rawData.name`, ensuring 100% alignment between the URL service name and the visualized data.
- **Data Consistency**: Enforced a "Single Source of Truth" for the Reverse Proxy identity. The Digital Twin Store now flags the authoritative Proxy Service upon update (prioritizing active/standard ones). The Network Graph Service strictly respects this flag, eliminating fuzzy matching inconsistencies.
- **Network Graph**: Improved Reverse Proxy selection logic to prioritize **Active** services and **Standard Names** (e.g., `nginx`, `nginx-web`) over inactive or fuzzy-matched services (e.g., `compose-nginx`), ensuring the correct service is attached to the Proxy Node.
- **Service Monitor**: Updated the "Network Details" panel to display comprehensive runtime information sourced from the enriched `rawData`. It now shows Systemd Active/Sub State, Unit File Path, Container Image, ID, and PID alongside standard network info.
- **Network Graph**: Enriched Service Node `rawData` with the associated active Container object from the Digital Twin. This ensures frontend "Raw Data" views show comprehensive runtime state (Image, ID, Labels) rather than just systemd status.
- **Network Graph**: Further enriched Nginx Proxy `rawData` with the complete Service Unit object (systemd status, load state, etc.) to provide comprehensive debugging information in the Service Monitor.
- **Network Graph**: Exposed the detected HTTP/HTTPS ports (80, 443) in the Nginx Proxy `rawData` / JSON Output for better visibility in the Service Monitor, ensuring they align with the visual graph metadata.
- **ServiceMonitor**: Fixed issue where container logs were not loading due to incorrect API endpoint usage (`/api/containers/[id]/logs` vs `stream`). Created a JSON-compatible logs endpoint. Also fixed the "Related Containers" list by normalizing Podman data to match `ContainerList` expectations (lowercase keys, node injection).
- **Agent V4**: Refined Reverse Proxy detection logic to exclude system services like `mpris-proxy` (Bluetooth) from being misidentified as proxies due to fuzzy matching.
- **Frontend**: Implemented intelligent service deduplication in `ServicesPlugin` to prevent duplicate "Reverse Proxy" cards when multiple service aliases (e.g., `nginx-web`, `nginx.service`) are reported by the Agent. Priority is given to Managed and Active services.
- **Frontend**: Added support for displaying Port Mappings on the Gateway Service card (e.g., FritzBox UPnP mappings).
- **NetworkService**: Cleaned up the Reverse Proxy / Nginx Raw Data structure. Added `verifiedDomains` to `rawData` to ensure completeness. Removed redundant legacy `servers` property from the top-level `rawData` when `proxyConfiguration` is present, maintaining a cleaner data shape while preserving all information.
- **NetworkService**: Enforced strict "Single Source of Truth" for Nginx Proxy Node creation. Removed hardcoded `ports: [80, 443]` and removed manual object construction. Now strictly initializes `rawData` from the `proxyService` object (if available), ensuring that `ports` and configuration exactly match the Digital Twin state without duplication or guessing.
- **Agent V4**: Implemented Recursive PID Scanning (`get_all_descendants`) to support Host Network containers. The agent now collects ports from the Main PID and all child processes (e.g. Nginx workers), ensuring no listening ports are missed.
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
- **Services Plugin**: Enriched Service cards to use the linked Container's "Raw Data" as the Single Source of Truth for runtime details. Ports and Labels are now directly populated from the active container object in the Digital Twin, ensuring the UI accurately reflects the current state of the backend.
- **Services Plugin**: Implemented "Service Level" definitions for Ports. If the runtime container is missing (e.g., service inactive), intrinsic ports for known System Services (Nginx Proxy 80/443, ServiceBay 3000) are still displayed, respecting the service definition rather than just the runtime state.
- **System Monitoring**: Implemented "Adaptive Resource Frequency".
    - Replaced static 10s throttle with a bi-modal strategy: 60s (Idle) vs 5s (Active Human Viewer).
    - Added `setResourceMode` command to Agent V4.
    - Backend now tracks "resource viewers" (sockets subscribed via `SystemInfoPlugin`) per node.
    - High-frequency mode (5s) is only enabled when a user is actively viewing the System Info page for that node.
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
- **Docs**: Added comprehensive Data Lineage section to `ARCHITECTURE.md` including a Mermaid diagram visualizing the flow from Agent V4 objects to Digital Twin Store and React Frontend.
- Created `changelog.instructions.md` to enforce changelog updates.
- **Logger**: Added `src/lib/logger.ts` for structured, colorized logging. Refactored key components (`ServiceManager`, `ServicesPlugin`, `ServiceMonitor`, etc.) to replace `console.*` calls with `logger.*`.

### Fixed
- **Frontend Consistency**: Removed all fuzzy matching logic from `ServiceMonitor`. The UI now locates the corresponding graph node using strict equality on `rawData.name`, ensuring 100% alignment between the URL service name and the visualized data.
- **Data Consistency**: Enforced a "Single Source of Truth" for the Reverse Proxy identity. The Digital Twin Store now flags the authoritative Proxy Service upon update (prioritizing active/standard ones). The Network Graph Service strictly respects this flag, eliminating fuzzy matching inconsistencies.
- **Network Graph**: Improved Reverse Proxy selection logic to prioritize **Active** services and **Standard Names** (e.g., `nginx`, `nginx-web`) over inactive or fuzzy-matched services (e.g., `compose-nginx`), ensuring the correct service is attached to the Proxy Node.
- **Service Monitor**: Updated the "Network Details" panel to display comprehensive runtime information sourced from the enriched `rawData`. It now shows Systemd Active/Sub State, Unit File Path, Container Image, ID, and PID alongside standard network info.
- **Network Graph**: Enriched Service Node `rawData` with the associated active Container object from the Digital Twin. This ensures frontend "Raw Data" views show comprehensive runtime state (Image, ID, Labels) rather than just systemd status.
- **Network Graph**: Further enriched Nginx Proxy `rawData` with the complete Service Unit object (systemd status, load state, etc.) to provide comprehensive debugging information in the Service Monitor.
- **Network Graph**: Exposed the detected HTTP/HTTPS ports (80, 443) in the Nginx Proxy `rawData` / JSON Output for better visibility in the Service Monitor, ensuring they align with the visual graph metadata.
- **ServiceMonitor**: Fixed issue where container logs were not loading due to incorrect API endpoint usage (`/api/containers/[id]/logs` vs `stream`). Created a JSON-compatible logs endpoint. Also fixed the "Related Containers" list by normalizing Podman data to match `ContainerList` expectations (lowercase keys, node injection).
- **Agent V4**: Refined Reverse Proxy detection logic to exclude system services like `mpris-proxy` (Bluetooth) from being misidentified as proxies due to fuzzy matching.
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
- **Frontend Consistency**: Removed all fuzzy matching logic from `ServiceMonitor`. The UI now locates the corresponding graph node using strict equality on `rawData.name`, ensuring 100% alignment between the URL service name and the visualized data.
- **Data Consistency**: Enforced a "Single Source of Truth" for the Reverse Proxy identity. The Digital Twin Store now flags the authoritative Proxy Service upon update (prioritizing active/standard ones). The Network Graph Service strictly respects this flag, eliminating fuzzy matching inconsistencies.
- **Network Graph**: Improved Reverse Proxy selection logic to prioritize **Active** services and **Standard Names** (e.g., `nginx`, `nginx-web`) over inactive or fuzzy-matched services (e.g., `compose-nginx`), ensuring the correct service is attached to the Proxy Node.
- **Service Monitor**: Updated the "Network Details" panel to display comprehensive runtime information sourced from the enriched `rawData`. It now shows Systemd Active/Sub State, Unit File Path, Container Image, ID, and PID alongside standard network info.
- **Network Graph**: Enriched Service Node `rawData` with the associated active Container object from the Digital Twin. This ensures frontend "Raw Data" views show comprehensive runtime state (Image, ID, Labels) rather than just systemd status.
- **Network Graph**: Further enriched Nginx Proxy `rawData` with the complete Service Unit object (systemd status, load state, etc.) to provide comprehensive debugging information in the Service Monitor.
- **Network Graph**: Exposed the detected HTTP/HTTPS ports (80, 443) in the Nginx Proxy `rawData` / JSON Output for better visibility in the Service Monitor, ensuring they align with the visual graph metadata.
- **ServiceMonitor**: Fixed issue where container logs were not loading due to incorrect API endpoint usage (`/api/containers/[id]/logs` vs `stream`). Created a JSON-compatible logs endpoint. Also fixed the "Related Containers" list by normalizing Podman data to match `ContainerList` expectations (lowercase keys, node injection).
- **Agent V4**: Refined Reverse Proxy detection logic to exclude system services like `mpris-proxy` (Bluetooth) from being misidentified as proxies due to fuzzy matching.
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
- [NetworkService] Deleted `ports` property from NetworkNode interface and all internal node creation logic.
- Deleted main fallback logic in NetworkService. Strict Twin data only.
- IMPLEMENTED Strict Service-Container Mapping in DigitalTwinStore (Single Source of Truth).
- Refactored Network Graph node IDs to use cleaner "service-" prefix instead of "group-service-".
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
