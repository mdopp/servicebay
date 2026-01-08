# Release Tasks V4: Architecture Migration

This roadmap outlines the steps to migrate ServiceBay to the V4 "Agentless SSH" architecture.

## Phase 1: Infrastructure & Core Libs

- [x] **Task 1.1: Create `SSHConnectionPool`**
    - Implement a class in `src/lib/ssh/pool.ts` that manages persistent SSH clients (`ssh2` or `child_process` spawn).
    - Implement automatic reconnection logic.
    - Add a `getConnection(nodeId)` method.

- [x] **Task 1.2: Develop the Ephemeral Agent Script**
    - Create `src/lib/agent/agent.sh` (or .py).
    - Features:
        - Read input loop (stdin) for commands.
        - Watch loop (background) for file changes in `~/.config/containers/systemd`.
        - Simple poller for `systemctl --user is-active`.
    - Ensure it outputs structured JSON Lines.

- [x] **Task 1.3: Implement `AgentHandler`**
    - Create `src/lib/agent/handler.ts`.
    - Logic to spawn the SSH session and pipe the script.
    - Parse JSON output lines and emit internal Node.js events.

## Phase 2: Refactoring "Manager"

- [x] **Task 2.1: Split `manager.ts`**
    - Create `src/lib/services/ServiceManager.ts`:
        - Move `listServices`, `startService`, `stopService` here.
        - Update them to use `AgentHandler` instead of direct `Executor`.
    - Create `src/lib/services/FileManager.ts`:
        - Move `readFile`, `writeFile` logic.
        - Implement naive caching (TTL 5s) for file reads to multiple consumers.

- [x] **Task 2.2: Refactor `UnitGenerator` (Kube/Quadlet)**
    - Isolate pure generation logic from `manager.ts` into `src/lib/services/UnitGenerator.ts`.
    - Support primary use case: **Kube Quadlets** (.kube -> .yml).
        - Generate the Pod YAML (Mustache replacement).
        - Generate the .kube file pointing to it.
    - Support secondary use case: **Standard Quadlets** (.container).
    - Ensure it returns content strings (does not write to disk).

## Phase 3: Integration

- [x] **Task 3.1: Update `server.ts` Event Bus**
    - Connect `AgentHandler` events to Socket.IO.
    - Define event types: `service:update`, `file:change`, `node:status`.
    - Update the frontend `SocketProvider` to listen for these.

- [x] **Task 3.2: Migrate `LocalExecutor` Users**
    - Identify all callers of `LocalExecutor` (except for `data/nodes.json`).
    - Migrate them to use the "Local Node" via SSH Loopback.
    - **Critical**: Ensure the onboarding/install script sets up the local SSH keys properly.

## Phase 4: Frontend & Cleanup

- [x] **Task 4.1: Optimistic UI Updates**
    - Update `useServicesList` to react to Socket events immediately.
    - Remove manual polling intervals (or increase them to fallback-only levels).

- [ ] **Task 4.2: Deprecate Legacy Code**
    - [x] Remove old `monitoring/scheduler.ts` (polling logic) in favor of the Agent stream.
    - [x] Delete unused `Executor` implementations.
    - [ ] Mark old `manager.ts` functions as deprecated or remove them if unused.
