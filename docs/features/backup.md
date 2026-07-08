# Backup that survives a reinstall

[← back to FEATURES](../FEATURES.md)

There are two backup systems in ServiceBay, and they answer different questions:

1. **System (control-plane) backup** — archives every managed node's config +
   Quadlet units, described in
   [ARCHITECTURE.md → System Backup Pipeline](../ARCHITECTURE.md#system-backup-pipeline).
   Hardened extraction, path-traversal + symlink guards.
2. **Per-service NAS backup** — the one this page is about: a per-service,
   manifest-driven config snapshot on the FritzBox NAS that a *reinstall* pulls
   back automatically.

## Per-service manifest on the NAS

**What it does.** Each service has a backup **manifest**
(`SERVICE_BACKUP_MANIFESTS` in
`packages/backend/src/lib/externalBackup/serviceManifest.ts`) that declares
exactly:

- `include[]` — the config paths worth keeping (HA's `automations.yaml`,
  `.storage/`, zwave-js keys, …).
- `exclude[]` — bulk data, logs, caches, recorder DBs — never backed up.
- `strip[]` — YAML keys to remove before archiving (re-enterable secrets).
- `data[]` — large on-RAID artifacts kept through a `wipe-config` reinstall.

**Why it exists.** A blind `tar` of a service's data dir would be huge, would drag
in caches and logs, and would ship secrets that get regenerated anyway. The
manifest keeps backups small, targeted, and safe.

## Reinstall pulls config back — no re-typing passwords

**What it does.** On a reinstall, each service's config is re-seeded from the NAS
*before* its pod starts, so the operator doesn't rebuild dashboards or re-enter
credentials.

**How it works.** `autoRestoreServiceOnReinstall`
(`packages/backend/src/lib/externalBackup/restore.ts`) runs per service during
install:

- On a fresh `install`: restore only if the data dir is empty (never clobber live
  config).
- On `wipe-config`: the config paths were just cleared, so **force-restore** from
  the NAS over the kept DATA.
- On `wipe-all`: clear, then force-restore.

It fetches `<service>.tar` from the NAS and extracts through `safeTarExtract`
(absolute-path / `..`-traversal / symlink-escape guards). Both outcomes —
restore-performed and restore-skipped-because — emit visible breadcrumbs to the
install log, so the operator can see *why* a restore did or didn't happen.

## Secrets stripped from archives

**What it does.** Re-enterable secrets are removed from the archive before it lands
on the NAS, so a leaked backup file doesn't leak live credentials.

**How it works.** `applyStripRules` + `stripYamlKeys` (in `serviceManifest.ts`)
drop the manifest's `strip` keys from each file during tar creation. Example: the
Hermes manifest strips `api_key` / `apiKey` / `llm_api_key` from `config.yaml`
("LLM API keys are re-entered after a restore").

Not everything is stripped — the manifest is a deliberate policy per service:

- **Kept verbatim** where regeneration is expensive or impossible and the NAS is a
  trusted class: LLDAP (family identity), NPM (certs + admin hash), Vaultwarden
  (its DB is encrypted at rest).
- **Stripped** where the value is re-enterable: third-party API keys.
- **Excluded** where it's bulk/rebuildable: recorder DBs, caches, attachments.

## Related

- [ARCHITECTURE.md → System Backup Pipeline](../ARCHITECTURE.md#system-backup-pipeline)
  — the control-plane backup and its hardened extraction.
- [It heals itself](self-heal.md) — the credential rekey that makes a
  reinstall-over-preserved-data survivable even when secrets *were* wiped.
