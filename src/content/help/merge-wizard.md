# Merge Wizard

## Purpose
Convert unmanaged Podman workloads into managed Quadlet stacks with a guided review, validation, and backup workflow. The wizard appears when ServiceBay detects a bundle of related services or containers that are not yet governed by systemd.

## Flow Overview
```
┌──────────────┐   ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
│ Discovery    │──▶│ Bundle Review│──▶│ Stack Draft  │──▶│ Dry Run + Plan │──▶│ Enable Managed│
│ (Agent Feed) │   │ (Assets Tab) │   │ (Stack Tab)  │   │ (Backup Tab)   │   │ Quadlet       │
└──────────────┘   └─────────────┘   └──────────────┘   └───────────────┘   └──────────────┘
                                     │
                                     ▼
                              Rollback / Restore
```

### 1. Discovery
- The node agent streams raw systemd units, pods, containers, and filesystem paths.
- ServiceBay groups correlated assets into a **bundle** so you can migrate entire stacks (e.g., app + database + cache) together.

### 2. Bundle Review (Assets Tab)
- Inspect every unit, container, file, and validation hint prior to generating a managed stack.
- Resolve blocking validations (red) before continuing. Warnings (amber) highlight best practices (ports, volumes, etc.).

### 3. Stack Draft (Stack Tab)
- ServiceBay synthesizes a `.kube` unit and Pod YAML from the bundle metadata.
- Containers are labeled as **primary** or **sidecar** and their exposed ports are preserved.
- Config assets (.env, config directories) are listed so you can plan bind-mounts or secrets.

### 4. Dry Run + Plan (Backup Tab)
- `podman kube play --dry-run` validates the generated stack before anything is written to disk.
- The plan lists files that will be created, overwritten, or archived along with the backup directory and archive name template.
- The wizard now leverages the same streaming backup pipeline as **Settings → System Backups**, so every merge automatically produces a restorable archive that also appears in the global backups list.

### 5. Execution & Health Checks
- When you confirm the merge, ServiceBay:
  1. Tars every source file plus a manifest into the backup directory.
  2. Writes the managed `.kube` + YAML files and reloads `systemctl --user`.
  3. Starts the new service and waits for `systemctl` to report `active`.
  4. Records the migration (who, when, bundle composition, backup archive) in history.

### 6. Rollback Safety Net
- If the service fails to start or you cancel, the wizard replays the backup archive, restores original units/files, and logs a `rolled_back` event.
- You can also manually reinstall a bundle later by extracting the timestamped archive.

## Tips
- **Name carefully**: the target name becomes both the unit and Pod name. Stick to lowercase letters, numbers, and dashes.
- **Files vs. secrets**: assets detected under `/config`, `.env`, or `.secret` paths are flagged so you can convert them into `ConfigMap`/secret volumes in the generated YAML.
- **Iterate safely**: you can return to the Stack tab, adjust files on disk, and re-open the wizard—every dry run revalidates the plan.
- **Unified history**: all wizard-created archives and restore events are visible under System Backups so ops teams can audit who merged what and when.
- **Need context mid-merge?** Use the Merge Wizard help button in the UI to reopen this guide while reviewing assets, stack artifacts, or backup plans.
