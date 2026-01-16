# Merge Strategy Implementation TODOs

## Solution Concept (Proposed)
- Treat unmanaged services as bundles of linked quadlet assets (pods, containers, systemd units, raw YAML). Build a dependency graph and surface bundle-level metadata (files, containers, ports, node context) to the UI.
- Present each bundle as a rich card leading to a merge wizard. The wizard walks through Assets → Generated Stack → Backup Plan, with inline validation results (YAML lint, `podman kube play --dry-run`) and clear mapping between legacy files and their destination in the managed stack or backup.
- Execute merges transactionally: tar/gzip every source file with manifest, generate the managed `.kube` stack, enable it via systemd, run health checks, and log the full migration (who/when/what) in the digital twin history. Provide rollback that replays the backup bundle and records the reversal.
- Document the workflow in user-facing help (including flow diagram / ASCII sketch) and reference it from tooltips so operators understand the safeguards, validation steps, and recovery options.

## Discovery & Grouping
- [x] **IMPROVE: Deep Quadlet Relationship Parsing** — Extract `Requires=`, `After=`, `BindsTo=`, `Pod=`, and `PublishPort=` from `.container`, `.pod`, and generated `.service` files to build a complete dependency tree. This enables accurate bundle grouping and better kube stack generation. _(Status: **COMPLETE** — QuadletParser implemented with 360+ lines, Python mirror, integrated into agent, and bundleBuilder now walks dependency graphs)_
  - [x] Implement a `QuadletParser` class to extract systemd directives from Quadlet files
  - [x] Add `associatedServices` (Requires/After), `podReference` (Pod=), `publishedPorts` (PublishPort=) to `ServiceUnit` interface
  - [x] Update Python agent to parse files during `fetch_files()` and augment `ServiceUnit` metadata
  - [x] Update backend `bundleBuilder` to use these relationships for accurate grouping
  - [x] Write comprehensive tests (7/7 passing)
  - [x] Document usage and examples
- [x] Extend unmanaged-service discovery to emit "service bundles" composed of linked `.pod`, `.kube`, `.service`, `.container`, and YAML assets. _(Status: Completed — bundles now power wizard plans, validations, and file mappings)_
- [x] Define graph-walk heuristics (unit Wants/BindsTo, shared pod names, common directories) to associate every file and container with its bundle. _(Status: Completed — implemented via `bundleBuilder` heuristics)_
- [x] Surface bundle metadata (primary unit, involved files, containers, ports, node) in the digital twin response for UI consumption. _(Status: Completed — `unmanagedBundles` now emitted with node context)_

## UX / UI Flow
- [x] Replace the unmanaged list item with a "bundle card" that previews assets, severity, and quick actions. _(Status: Completed — new ServicesPlugin cards live behind twin bundles)_
- [x] Implement a bundle detail drawer showing dependency tree, file manifest, and inferred roles. _(Status: Completed — drawer wired to card selections)_
- [x] Build a multi-step "Merge Wizard" with tabs for Assets, Generated Stack, and Backup Plan, including inline warnings and confirmations. _(Status: Completed — wizard now surfaces backend validations, file mappings, and archive hints)_

## Generation & Validation
- [x] Author a stack generator that converts bundle metadata into a single managed `.kube` stack (pods + sidecars + configs). _(Status: Completed — generator now emits sanitized Quadlet units, pod specs, and config references for the wizard)_
- [x] Run automated validations (YAML lint, `podman kube play --dry-run`) and present results inside the wizard before allowing execution. _(Status: Completed — backend dry-run + severity piping wired into wizard)_
- [x] Ensure the wizard highlights how each legacy file maps into the new stack or backup. _(Status: Completed — plan file mappings + backup archive pattern rendered in Backup step)_

## Execution & Safety
- [x] Implement transactional merge: backup originals (tar/gzip with manifest), create new managed stack, enable via systemd, and run post-merge health checks. _(Status: Completed — merges now create manifest archives for all legacy assets, start the managed unit, wait for `systemctl show` to report `active`, and gate success on that health check)_
- [x] Record migration metadata (who, when, bundle composition) in the digital twin history for auditability. _(Status: Completed — each merge/rollback appends an audit entry with actor, bundle makeup, and backup archive reference)_
- [x] Provide a Rollback path that restores backups, disables the managed service, and logs the reversal. _(Status: Completed — failures trigger archive restoration, re-enable the legacy units, and emit a `rolled_back` history event)_

## Documentation & Communication
- [x] Add a user-facing guide describing the merge workflow (in `/docs` or the help center), including a flow diagram or ASCII sketch that illustrates discovery → review → validation → execution → rollback. _(Status: Completed — `merge-wizard` help article now ships with an ASCII flow and detailed step notes)_
- [x] Update in-app tooltips and help links in the wizard to reference the new documentation and clarify safeguards. _(Status: Completed — wizard now shows the safeguards callout, contextual tooltips, and opens the Merge Workflow guide inline)_
