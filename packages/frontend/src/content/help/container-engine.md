# Container Engine

## Overview
ServiceBay's Container Engine workspace unifies container and volume management for every node connected to the digital twin. Use the tabs at the top of the page to pivot between **Containers** and **Volumes** without leaving the workflow.

## Container Operations
- **Live Inventory**: View running and stopped Podman containers per node, sourced from the streaming agent.
- **Lifecycle Controls**: Start, stop, restart, or delete individual containers. Actions operate through systemd-aware helpers so managed units stay in sync.
- **Logs & Inspect**: Open tailing logs or inspect the raw Podman JSON to debug configuration drift before migrating to Quadlet.
- **Network Awareness**: Badges call out host-network workloads versus bridge mode so you know when ports are exposed directly on the host.

### Tips for Containers
- Use the node selector in the header to swap between Local and remote hosts. Lists update immediately as the agent pushes new state.
- Before permanently removing a container, trigger a **System Backup** so its Quadlet or template files remain archived.
- Compare the Inspect payload with the generated Quadlet spec when validating merge or migration plans.

## Volume Operations
- **Unified Volume List**: See all Podman/Docker named volumes across nodes, including which host owns each mount.
- **Creation Wizard**: Provision named volumes or bind mounts. Supply driver options or host paths directly from the UI.
- **Cleanup & Prune**: Remove unused volumes to reclaim disk space before running backups or migrations.
- **Data Path Awareness**: The panel surfaces `DATA_DIR` hints from templates so you understand what is covered by scheduled backups.

### Tips for Volumes
- Use descriptive names per project/node to avoid collisions when syncing between hosts.
- Favor bind mounts (`Host Path`) for configuration files you want under source control; use named volumes for databases that need Podman-managed storage.
- Pair volume pruning with your **System Backups** cadence: delete stale volumes, then archive configs so restores never point to missing mounts.

## Workflow Notes
1. **Review Containers**: Confirm runtime state, logs, and network exposure.
2. **Check Volumes**: Validate that required mounts exist (and unused mounts are removed) before redeploying stacks.
3. **Execute Changes**: Apply lifecycle actions, create volumes, or clean up assets.
4. **Backup**: Once satisfied, run a System Backup to capture both Quadlet definitions and referenced data paths.

## Safety
- All actions run through ServiceBay's node agents, so UI state always reflects the last pushed event stream.
- Volume deletes prompt for confirmation; container deletes recommend backups to avoid data loss.
- Host paths and named volumes are surfaced together so you can cross-check what will persist after a reboot or migration.
