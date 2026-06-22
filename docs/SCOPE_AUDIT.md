# API scope ↔ capability audit

The authoritative "what does each token scope let you do" table, derived from the
real route guards and tool maps in the codebase — not from intent. Regenerate by
re-walking the sources listed under [Sources](#sources) whenever a guard changes.

Related: [ADR 0009 — Tokens & trust](adr/0009-service-tokens-and-trust.md) §3 (the
*why*), [`MCP.md`](MCP.md) (the MCP tool catalogue). This doc is the *what* —
the per-capability mapping #2050 asked to make authoritative.

## The ladder

`ApiScope` (`packages/backend/src/lib/auth/apiScope.ts`), least → most destructive:

```
read  <  lifecycle  <  mutate  <  reboot  <  destroy  <  exec
```

Scopes are **not** automatically nested — holding `mutate` does **not** imply
`read`. A token carries an explicit set, and `scopeSatisfiedBy(held, required)`
checks membership with exactly two implication rules (the back-compat carve-outs
from when `reboot`/`exec` were folded into `destroy`):

- `destroy` implies `reboot` (#1765 — `reboot` was split out of `destroy`)
- `destroy` implies `exec` (pre-#591 exec-via-destroy back-compat)

So a `destroy` token may call a `reboot`- or `exec`-gated capability; nothing else
crosses tiers. The same function gates MCP tool calls (`tokenHasScope`) and the
delegated child-mint subset check (`scopesAreSubset`, #2048) — one source of truth.

| Scope | Intent |
|---|---|
| `read` | lookups + diagnose + log/file readers — no state change |
| `lifecycle` | start/stop/restart, run-check-now, refresh, run-backup, channel-set — transient operational verbs |
| `mutate` | create/update/add + config writes — **additive** changes |
| `reboot` | `reboot_node` — transient, recoverable host restart (#1765); split out so a token can operate+reboot **without** irreversible delete/wipe |
| `destroy` | delete/restore/purge/factory_reset — **irreversible** state edits |
| `exec` | `exec_command` / `container_exec` — arbitrary shell |

## Two enforcement surfaces

ServiceBay gates a token at two independent layers, and **both** consult the same
ladder:

1. **MCP tools** — every tool name maps to a required scope in `TOOL_SCOPES`
   (`packages/backend/src/lib/mcp/server.ts`). The dispatcher checks
   `tokenHasScope(auth.scopes, TOOL_SCOPES[tool] ?? 'read')` before any tool runs.
   This map is centralized and complete by construction — every tool has a row.

2. **REST routes** — there is **no** central map. Each route opts into Bearer-token
   acceptance per-handler via `withApiHandler({ tokenScope })`
   (`packages/backend/src/lib/api/handler.ts` → `requireSession.ts`). A route that
   omits `tokenScope` rejects Bearer tokens entirely and stays cookie/internal-only
   (#1264). A **cookie session carries all scopes** (legacy back-compat), so the
   `tokenScope` guard only constrains `sb_…` named-token callers, never the browser.

The table below is the per-route audit of surface (2) — the one with no central map,
hence the one #2050 had to walk by hand.

## MCP tool → scope (surface 1)

Source of truth is `TOOL_SCOPES`. Summary by tier (see `server.ts` for the full list):

| Scope | Tools |
|---|---|
| `read` | `list_*`, `get_*`, `diagnose`, `read_file`, `list_dir`, `disk_usage`, `verify_node_connection`, `verify_usb_boot`, … |
| `lifecycle` | `start_service`, `stop_service`, `restart_service`, `run_check_now`, `refresh_agent`, `run_backup`, `set_channel` |
| `mutate` | `deploy_service`, `update_service_yaml`, `rename_service`, `add_proxy_route`, `create_health_check`, `restore_trashed_service`, `file_access_request`, `update_config` |
| `reboot` | `reboot_node` |
| `destroy` | `delete_service`, `delete_health_check`, `remove_proxy_route`, `restore_backup`, `purge_trashed_service`, `set_boot_next_usb`, `factory_reset` |
| `exec` | `exec_command`, `container_exec` |

## REST route → scope (surface 2)

Every REST route that accepts a named API token, with the scope it gates on. Routes
not listed here reject Bearer tokens (cookie/internal-token only).

| Route | Method | Scope | Capability |
|---|---|---|---|
| `/api/system/stacks` | GET | `read` | enumerate stacks |
| `/api/system/channel` | GET | `read` | read release channel |
| `/api/system/boot/usb-next` | GET | `read` | poll USB-boot readiness |
| `/api/install/current` | GET | `read` | poll install progress |
| `/api/install/plan` | POST | `read` | compute install plan (inspect-only) |
| `/api/settings` | GET | `read` | read settings |
| `/api/settings/backups` | GET | `read` | list config backups |
| `/api/system/external-backup/list` | GET | `read` | list NAS backups |
| `/api/system/external-backup/target` | GET | `read` | read NAS target config |
| `/api/install/assemble` | POST | `lifecycle` | assemble install artifacts |
| `/api/install/skip-credentials` | POST | `lifecycle` | resolve a credential step |
| `/api/install/start` | POST | `lifecycle` | start a stack install |
| `/api/install/abort` | POST | `lifecycle` | abort a stuck install |
| `/api/settings/backups` | POST | `lifecycle` | trigger a backup |
| `/api/system/external-backup/export-lldap` | POST | `lifecycle` | stage LLDAP export onto NAS |
| `/api/system/external-backup/import-ha` | POST | `lifecycle` | stage an HA-OS backup onto NAS |
| `/api/system/external-backup/upload` | POST | `lifecycle` | upload a backup to NAS |
| `/api/system/external-backup/orphans` | GET | `lifecycle` | list NAS backups for uninstalled services (read-only; gated stricter than its `read` sibling — harmless, do not loosen) |
| `/api/settings` | POST | `mutate` | write settings/config |
| `/api/system/channel` | POST | `mutate` | set release channel |
| `/api/system/boot/usb-next` | POST/DELETE | `mutate` | set/clear firmware BootNext |
| `/api/system/disk-import/*` | GET/POST | `mutate` | scan/plan/apply a drive import (file moves into canonical folders = additive) |
| `/api/system/external-backup/register` | POST | `mutate` | register a NAS backup source (config write) |
| `/api/system/external-backup/target` | POST | `mutate` | write NAS target config |
| `/api/system/external-backup/delete` | POST | `mutate` | delete one NAS archive file |
| `/api/system/external-backup/backup-now` | POST | `mutate` | trigger an off-box backup |
| `/api/system/templates/prune-orphans` | GET | `mutate` | list orphan template dirs |
| `/api/system/templates/prune-orphans` | DELETE | `destroy` | delete orphan template dirs |
| `/api/settings/backups/restore` | POST | `destroy` | restore the box config over current state |
| `/api/system/external-backup/restore` | POST | `destroy` | restore a service's data dir from NAS — clobbers a live service's data when `force` (corrected from `lifecycle`, #2050) |
| `/api/system/stacks/[name]/wipe` | DELETE | `destroy` | wipe a stack's data |

The delegated-mint route `/api/system/api-tokens/delegate` is **not** in this table:
it is `skipAuth` and authenticates by verifying the **parent Bearer token** itself
(any scope), then enforces `child ⊆ parent` (#2048). It carries no fixed `tokenScope`.

## Audit findings (#2050)

One under-scoped destructive endpoint was found and corrected; the rest of the
guards already matched intent.

- **`/api/system/external-backup/restore` (POST): `lifecycle` → `destroy`.** This
  route restores a service's config/data backup *into its live data dir*, clobbering
  current data when `force:true` — an irreversible state overwrite, the `destroy`
  tier. It was gated only at `lifecycle`, so a `lifecycle`-only token could overwrite
  a live service's data. It now matches its siblings: the config-restore route
  (`/api/settings/backups/restore`, `destroy`) and the MCP `restore_backup` tool
  (`destroy`). **No caller breaks:** the only HTTP caller is the cookie-authenticated
  Backup page (cookies carry all scopes); the reinstall auto-restore path calls
  `restoreServiceBackup()` in-process and never crosses the HTTP guard.

- **`/api/system/external-backup/orphans` (GET) is gated `lifecycle`** though it is
  read-only. This is *stricter* than its `read` sibling (`external-backup/list`).
  Loosening it to `read` would widen access, which a security audit must not do, so
  it is **left as-is** and documented here as an intentional (harmless) asymmetry.

No guard was loosened. No route was found that allows a *lower* scope than its
capability warrants other than the `restore` case above.

## Sources

Regenerate this audit from:

- `packages/backend/src/lib/auth/apiScope.ts` — ladder + `scopeSatisfiedBy`/`scopesAreSubset`
- `packages/backend/src/lib/mcp/server.ts` — `TOOL_SCOPES`, `tokenHasScope`
- `packages/backend/src/lib/api/requireSession.ts` + `handler.ts` — the `tokenScope` opt-in mechanism
- the REST routes: `grep -rln "tokenScope:" packages/frontend/src/app --include=route.ts`
