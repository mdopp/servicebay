---
title: "ADR 0002 — Backup is tiered: critical config + irreplaceable user state → NAS; bulk media → large secondary drive"
whenToUse: "You are deciding where a service's data is backed up, or why a backup is missing something: which state goes to the NAS, why terabytes of media must never land there, and why Home Assistant and Vaultwarden are backed up in full while a movie library is not."
kind: adr
tags: [adr, decision, backup, nas, storage]
---
# ADR 0002 — Backup is tiered: critical config + irreplaceable user state → NAS; bulk media → large secondary drive

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](adr-0001-authentication-via-authelia-sso-or-lldap.md), [CREDENTIAL_SELF_HEAL.md](../docs/CREDENTIAL_SELF_HEAL.md), Backup Sync (Settings → Backups), [ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## Context

The box holds two fundamentally different kinds of data:

1. **Small, critical, hard-to-recreate state** — service configs, the
   **Home Assistant full backup** (all sensors, automations, helpers, HACS
   plugins), the **Vaultwarden** password vault, the LLDAP/Authelia identity,
   nginx/AdGuard settings. Losing any of this is a disaster; recreating it by
   hand is hours-to-impossible. It is *small*.

2. **Large bulk media** — the Immich photo/video library, movies, music, the
   file-share `shared/` files. Tens to hundreds of GB to TBs. Often
   replaceable (already exists on a phone, a source disk, or by re-import) and
   too big to belong on the NAS.

Pushing **everything** to the NAS is wrong: it bloats a NAS that isn't sized
for TBs, makes every backup slow, and buries the critical small state in
noise. Conversely, leaving the critical small state *off* the NAS means a
reinstall or disk failure loses identity, secrets, and Home Assistant's brain.

A blunt "config → NAS, data → drive" rule is **also** wrong, because some of
the most critical state *is* "data": HA's full backup and the Vaultwarden
vault must be on the NAS even though they aren't "config".

## Decision

Back up in **two tiers, classified by criticality + size — not by the
"config vs data" label:**

### Tier A → NAS (nightly external backup)
Small, critical, must-survive-a-reinstall. Goes to the NAS external-backup
target (`config.externalBackup`):
- Every service's **config** (the existing per-service config backup).
- **Home Assistant's full backup** — sensors, automations, helpers, HACS
  plugins, `.storage` — not just its config.
- **Vaultwarden** — the password vault.
- Identity/secrets state: LLDAP, Authelia, nginx, AdGuard.

### Tier B → large secondary drive (Backup Sync, NOT the NAS)
Bulk, big, replaceable-ish. Goes to a large external/secondary drive via
**Backup Sync** (rsync of `/mnt/data` sources), and is **excluded** from the
NAS backup:
- The **Immich** photo/video library.
- **Movies**, **music**, **TV** (Jellyfin libraries).
- The **file-share `shared/` / bulk files**.

### Rules
1. A new service's **config** defaults to **Tier A (NAS)**.
2. A service's **bulk data directories** must be **explicitly** marked Tier B
   and **excluded from the NAS backup**, so TBs of media can never silently
   bloat the NAS.
3. Irreplaceable user *state* that happens to be "data" (HA full backup,
   Vaultwarden vault) is **Tier A** by exception and named as such.

## Consequences

- HA: the NAS holds its **full** backup, so a reinstall restores the whole
  smart-home brain, not just settings.
- Vaultwarden: the vault is on the NAS (small + critical).
- Immich photos, movies, music, `shared/` → Backup Sync to a big drive; never
  pushed to the NAS.
- The split already exists mechanically (NAS external-backup = config; Backup
  Sync = bulk → drive); this ADR sets the **policy** for *what lands where* and
  the two Tier-A-by-exception cases.
- A diagnose/health check SHOULD flag: (a) a bulk directory misconfigured into
  the NAS backup, and (b) critical Tier-A state (HA full, Vaultwarden) **not**
  present in the NAS backup.

## History

### 2026-09-07 — the classification moved onto the templates; the two limits did not (#2858)

**What changed.** Until now, *which* paths of a service were Tier A lived in
one table inside ServiceBay (`SERVICE_BACKUP_MANIFESTS`, `packages/backup-manifest`).
That was workable while every template shipped in this repo, but a template
from another registry cannot add a row to a table it does not ship — so it
could not be backed up at all (#2849), and that does not scale as registries
multiply. The classification now lives on the **template**, as its
`servicebay.backup` annotation: `include` is its Tier A, `data` is its Tier B,
and a template with nothing worth preserving says `backup: none` with a reason.
The table is an empty deprecated shim. A template that owns a store installed
under another name (a sibling dir, one app of a multi-app template) declares it
under `stores:`; the declaring template is that store's gate.

**What did NOT change: the two limits stay ServiceBay's.** A template is data,
and a template from a foreign registry is less trusted than our own code, so
neither Rule 2 nor the boundary is delegated to it:

1. **The Tier-B clamp is enforced producer-side.** An `include` that resolves
   inside a volume ServiceBay lists as bulk (`EXCLUDED_BULK_VOLUMES` — the
   media library, the photo blobs, a Postgres cluster dir) is dropped from the
   include set, pushed onto `exclude`, and logged — whatever the template
   declared. A store left with no include path produces **no manifest at all**,
   because an empty backup reports "0 files, ok" and is indistinguishable from
   a healthy one. Rule 2 above is now mechanical, not a convention.
2. **The path boundary is enforced twice.** Every declared path must resolve
   inside the service's own data dir; the parser refuses a declaration that
   breaks it, and the producer re-checks each path, so a declaration that
   reached the runtime by another route (a hand-edited local template, a
   registry clone updated underneath) still cannot walk out.

**Where the check lives.** `scripts/check-backup-coverage.ts` now asks two
questions: every template ServiceBay ships declares a backup or an explicit
`backup: none`; and every persistent volume is covered by a declaration or
listed in `EXCLUDED_BULK_VOLUMES` with a reason. It runs the same pure bridge
the box runs (`lib/externalBackup/backupDeclaration.ts`), so the gate cannot be
right about a question the runtime answers differently. A registry outside this
repo runs the identical check over its own tree:
`npx tsx scripts/check-backup-coverage.ts --templates <dir>`.

**Consequence for the operator:** none visible. The migration is byte-identical
per service — `tests/backend/backup_template_declarations.test.ts` freezes the
old table and asserts the resolved declarations equal it — so the same files
land in the same tarballs.

## Notes

Second ADR; follows the `assists/adr-NNNN-title.md` convention from
[ADR 0001](adr-0001-authentication-via-authelia-sso-or-lldap.md).

