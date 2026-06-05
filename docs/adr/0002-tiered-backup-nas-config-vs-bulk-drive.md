# ADR 0002 — Backup is tiered: critical config + irreplaceable user state → NAS; bulk media → large secondary drive

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](0001-authentication-via-authelia-sso-or-lldap.md), [CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md), Backup Sync (Settings → Backups), [ARCHITECTURE.md](../ARCHITECTURE.md)

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

## Notes

Second ADR; follows the `docs/adr/NNNN-title.md` convention from
[ADR 0001](0001-authentication-via-authelia-sso-or-lldap.md).
