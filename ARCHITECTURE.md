# Architecture (Target V4.1 - Reactive Digital Twin)

## Overview

ServiceBay is a Next.js application designed to manage containerized services using Podman. It provides a web interface for creating, monitoring, and managing services defined as Kubernetes Pod YAMLs (Quadlet style).

**Version 4.1 Architecture** moves to a **Reactive Digital Twin** model. This design eliminates polling and user-waiting times by maintaining an always-in-sync "Digital Twin" of the node state in the backend.

### Core Principles

*   **Push-Based**: The Agent pushes state changes (Files, Services, Containers) to the Backend immediately upon detection.
*   **Digital Twin**: The Backend maintains a real-time copy of the node's state. The UI reads only from this local cache (Store).
*   **Rootless Compatible**: All monitoring uses standard user-space tools available to the non-root user (`systemctl --user`, `podman`, `inotify`).
*   **Abstracted Modularity**: Gateways and Proxies are "Peripheral Twins" that feed into a generic data model.

## Architecture Diagram

```mermaid
graph TD
    subgraph "Frontend Layer (Browser)"
        UI[React Dashboard]
        API[API / Socket.IO]
        
        UI <-->|1. Immediate Read| API
    end

    subgraph "ServiceBay Backend (Container)"
        API <-->|Read| StateStore["Digital Twin (In-Memory Store)"]
        
        SSH_Server[SSH Server / Listener] -->|Update Node State| StateStore
        GatewayPoller[Gateway Manager] -->|Update Gateway State| StateStore
    end

    subgraph "Target Node (Rootless User Space)"
        subgraph "Python Agent (One Process)"
            
            subgraph "Input Optimizations"
                Mon_DBus["DBus Monitor"] -- Signals --> Logic
                Mon_Pod["Podman Events"] -- JSON Stream --> Logic
                Mon_File["Inotify Watcher"] -- File Events --> Logic
            end
            
            subgraph "Core Logic"
                Logic[State Aggregator]
                
                Logic -->|Query| Local_Podman[Podman CLI]
                Logic -->|Query| Native_Prox["Proxy Inspector (Shell)"]
            end
            
            Logic -->|Push: SYNC_STATE| SSH_Out[Start SSH Tunnel]
        end
        
        Mon_DBus -.->|Listen| SystemdUser["systemd --user"]
        Mon_Pod -.->|Listen| PodmanSocket["Podman"]
        Native_Prox -.->|Exec| ProxyCont[Nginx Container]
    end

    SSH_Out -->|JSON Stream| SSH_Server
```

## The Digital Twin Data Model

The Backend Store serves as the Single Source of Truth. It aggregates data from multiple sources into a generic model.

```typescript
interface DigitalTwinStore {
  // Core Node State (Pushed by Python Agent)
  nodes: Record<string, {
    connected: boolean;
    lastSync: number;
    resources: SystemResources; // CPU, RAM
    containers: EnrichedContainer[]; // Ports, Status, etc.
    services: ServiceUnit[]; // Systemd Units
  }>;

  // Abstract Peripheral: Internet Gateway (Polled by Backend)
  gateway: {
    provider: 'fritzbox' | 'unifi' | 'mock';
    publicIp: string;
    upstreamStatus: 'up' | 'down';
    lastUpdated: number;
  };

  // Abstract Peripheral: Reverse Proxy (Pushed by Agent via Inspector)
  proxy: {
    provider: 'nginx' | 'traefik' | 'caddy';
    routes: Array<{
      host: string;
      targetService: string; // e.g., "immich"
      targetPort: number;
      ssl: boolean;
    }>;
  };
}
```

## Component Details

### A. The Agent (State Aggregator)
A single lightweight Python script (`src/lib/agent/v4/agent.py`) running on the target host. It acts as the "Digital Twin" source of truth, optimizing data collection to minimize system load while ensuring real-time responsiveness.

#### 1. Agent Components

| Component | Trigger | Role & Data Provided |
| :--- | :--- | :--- |
| **Podman Monitor** | `podman events` (Stream) | **Role**: Tracks runtime state of containers.<br>**Trigger**: Real-time event stream with **1s Debounce**. Ignores noisy events (`exec`, `cleanup`).<br>**Data**: `containers[]` (State, Networks, Mounts, Labels). Correlates host ports via `ss` to mapped internal ports. |
| **Systemd Monitor** | Event-Driven | **Role**: Tracks Managed Kube Services (Podman Kube Stacks).<br>**Trigger**: Triggered by File changes or Container lifecycle events.<br>**Data**: `services[]` (ActiveState, SubState, Flags: `isReverseProxy`). |
| **File Watcher** | Hybrid | **Role**: Monitors config files for hot-reloads.<br>**Trigger**: Current: Efficient Polling (2s). Target: `inotify` events.<br>**Inputs**: `~/.config/containers/systemd/` + Dynamic Nginx mount paths.<br>**Data**: `files{}` (Content, timestamp). Sends raw content of `*.conf`, `*.yaml` for the editor. |
| **Nginx Inspector** | On-Change | **Role**: Extracts *actual* routing table from the active proxy.<br>**Mechanism**: Execs a shell script inside the `nginx` container to dump internal config.<br>**Data**: `proxy[]` (`host`, `targetService`, `targetPort`, `ssl`). |
| **Resource Monitor** | Polling (5s) | **Role**: Tracks system health and hardware stats.<br>**Trigger**: Polls system files (`/proc/*`) every 5s. Pushes updates **only** if metrics change beyond threshold.<br>**Data**: `resources` (CPU Load, RAM Usage/Total, Disk Usage, OS Release info). |

#### 2. Agent Data Flow

```mermaid
graph TD
    subgraph Host[Host: Agent.py]
        PE[Podman Events] -->|Stream| PM[PodmanMonitor]
        PM -->|Debounce 1s| FC[fetch_containers]
        FC -->|Trigger| NM[Nginx Inspector]
        
        FW[FileWatcher Loop] -->|Poll 2s| FF[fetch_files]
        FF -->|Change Detected| FS[fetch_services]
        
        SS[ss -tulpnH] --> FC
        SYS[systemctl list-units] --> FS
        
        subgraph NginxContainer
            NM -->|podman exec| INC[Inspector Script]
        end
        
        FC -->|Push| ST["STDOUT (JSON)"]
        FS -->|Push| ST
        FF -->|Push| ST
        NM -->|Push| ST
    end
```

#### 3. Traffic Optimization (Deduplication)
To minimize SSH bandwidth and Backend processing, the Agent applies strict filtering before sending data:
*   **Event Debouncing**: Burst events (e.g., stack startup) are grouped into a single scan using a 1-second settling timer.
*   **Noise Filtering**: High-frequency, irrelevant events (like `exec_create` from healthchecks) are dropped immediately.
*   **Payload Deduplication**: The Agent caches the last pushed state for every component (Services, Files, etc.). A `SYNC_PARTIAL` message is **only** generated if the new JSON payload differs from the previous one.

### B. The Backend (Gateway Poller)
*   **Goal**: Monitor Internet connectivity.
*   **Mechanism**: A scheduled task (e.g., every 60s) runs in the Backend.
*   **Abstraction**: A `GatewayProvider` interface allows different implementations (FritzBox, Ubiquiti, etc.) to feed the same `gateway` state in the Store.

## Backend API Reference

The Backend exposes a set of standard REST APIs for the Frontend. These APIs primarily interact with the **Digital Twin Store** for reading data, and the **Agent Executor** for writing/actions.

```mermaid
sequenceDiagram
    participant UI as Frontend
    participant API as API Route
    participant Store as DigitalTwinStore
    participant Agent as AgentExecutor
    participant Host as Python Agent

    %% Read Flow
    UI->>API: GET /api/containers
    API->>Store: Get Snapshot
    Store-->>API: Return Cached Data (Instant)
    API-->>UI: 200 OK (JSON)

    %% Write Flow
    UI->>API: POST /api/containers/abc/action (restart)
    API->>Agent: exec("podman restart abc")
    Agent->>Host: SSH Command
    Host-->>Agent: Result (Stdout/Stderr)
    Agent-->>API: Success
    API-->>UI: 200 OK
    
    %% Async Update (Push)
    Host->>Agent: Stream Event (Container Started)
    Agent->>Store: Update Node State
    Store->>UI: WebSocket/SWR Revalidate
```

### Core Endpoints

#### 1. Containers
*   `GET /api/containers`: Returns a list of all containers on a node.
    *   **Source**: Digital Twin Store (Memory).
    *   **Response**: `EnrichedContainer[]`.
*   `GET /api/containers/[id]`: Returns detailed inspection data.
*   `POST /api/containers/[id]/action`: Performs lifecycle actions.
    *   **Actions**: `start`, `stop`, `restart`, `delete`, `kill`.
    *   **Mechanism**: Direct RPC via Agent (`podman <action> <id>`).

#### 2. Services (Systemd)
*   `GET /api/services`: Returns managed services.
    *   **Source**: Backend Aggregator (Store + Config).
    *   **Logic**: Merges systemd units (from Agent) with Configured Links and Gateway status.
    *   **Special Types**: `gateway` (Internet Router), `link` (External Dashboard), `service` (Quadlet).

#### 3. Monitoring
*   `GET /api/monitoring`: Returns health check results.
    *   **Source**: Monitoring Store (In-Memory Ring Buffer).

### 4. Terminal (SSH Passthrough)
*   **Goal**: Provide a fully functional shell interface to the target node directly in the browser.
*   **Architecture**:
    *   **Frontend**: `xterm.js` + `xterm-addon-fit`. Handles VT100 emulation and keystrokes.
    *   **Transport**: Socket.IO bi-directional stream (`term-input` -> `term-output`).
    *   **Backend**: `AgentExecutor` spawns a persistent SSH shell session using `ssh2` Client.
    *   **Security**: Restricted to authenticated users. SSH session runs as the configured rootless user.

### 5. Network Graph Aggregation
*   **Goal**: Visualize the relationships between Nodes, Services, and the Internet.
*   **Mechanism**: `NetworkService.getGraph()` aggregates data from three layers on-demand:
    1.  **Infrastructure Layer**: Gateway (Router) status and Internet connectivity.
    2.  **Config Layer**: Application Settings (External Links, Manual Edges).
    3.  **Digital Twin Layer**: Real-time container state from the Agent.
*   **Logic**:
    *   Nodes are auto-discovered from `twin.services` and `twin.containers`.
    *   Edges are inferred from Nginx Proxy routes (`proxy_pass`) and DNS settings.
    *   The graph is "reactive" — as soon as the Agent pushes a container update, the graph acts as a derived view.

## Technology Decision: Python Agent

We have explicitly chosen **Python 3** (Standard Library only) over Bash/Shell scripts for the Agent implementation.

### Rationale
1.  **JSON Handling**: The entire V4 architecture relies on structured JSON streams. Python handles this natively.
2.  **Concurrency**: Managing multiple monitoring threads (DBus, Podman, File Watcher) in a single process is robust in Python.
3.  **Abstraction**: Python is the "Driver" that orchestrates the "Native Shell Scripts" (like the Nginx inspector), acting as the bridge between raw OS commands and the structured Backend API.

## Plugin Architecture

The dashboard (`/`) is built using a modular plugin architecture. This allows for easy extension of the dashboard with new features without cluttering the main page logic.

### Core Concepts

- **Plugin Interface**: Defined in `src/plugins/types.ts`.
- **Plugin Registry**: `src/plugins/index.tsx` exports an array of available plugins.

### Current Plugins

1.  **Services**: Manages the core "containered services" (systemd units).
2.  **Containers**: Lists all active Podman containers.
3.  **Monitoring**: Real-time health checks, history, and notifications.
4.  **Network Map**: Visualizes service relationships.
5.  **System Info**: Displays CPU, Memory, OS, Network, Disk Usage.
6.  **SSH Terminal**: A fully functional web-based terminal using `xterm.js`.
7.  **Settings**: Application settings and ServiceBay updates.

## Registry & Installation

- **Local Registry**: Templates are read from `templates/` and `stacks/` directories.
- **Templates**: Are primarily **Kubernetes Pod YAMLs**.
- **Installation Flow**:
  1. Frontend sends configuration (Template + Variables).
  2. `UnitGenerator` creates:
     - `service.yml` (The K8s Pod definition).
     - `service.kube` (The Systemd Quadlet unit referencing the YAML).
  3. `FileManager` writes these files via SSH to `~/.config/containers/systemd/`.
  4. `ServiceManager` reloads the daemon.

## Testing Strategy

The project employs a robust testing strategy ensuring reliability across the Agent-Backend boundary.

### 1. Robustness & Resilience (Circuit Breaker)
*   **Agent Stream Protocol**: The backend implements a "Circuit Breaker" pattern for the JSON stream received from the Python Agent.
    *   **Logic**: If the stream contains consecutive malformed packets (binary garbage, syntax errors) exceeding a threshold, the connection is forcibly terminated to protect backend resources.
    *   **Recovery**: The Agent logic includes auto-reconnection backoff.
*   **Store Validation**: The Digital Twin Store acts as a guarded boundary. All updates entering the store are runtime-validated for correct top-level types (e.g., ensuring `containers` is an Array) to prevent frontend crashes due to corrupted state.

### 2. Backend Unit & Integration Tests
*   **Vitest** is used for all backend testing.
*   **Mocking**: External system dependencies (`fs`, `ssh2`, `child_process`) are heavily mocked to test logic in isolation.
*   **Key Test Suites**:
    *   `tests/backend/agent_robustness.test.ts`: Verifies connection stability under "fuzzing" conditions.
    *   `tests/backend/store_robustness.test.ts`: Verifies the Digital Twin's immunity to invalid payloads.
    *   `tests/backend/graph.test.ts`: Validates the aggregation logic for the Network Map.
    *   `tests/backend/api.test.ts`: Integration tests for key REST endpoints.

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS.
- **Backend**: Node.js custom server.
- **Tunneling**: SSH (Client: `ssh2` or `openssh` binary).
- **Target**: Generic Linux with Podman & Systemd.
