# ADR 0004 — Installing/redeploying a service never wipes other services; system-wide reset is factory-reset-only

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0002](0002-tiered-backup-nas-config-vs-bulk-drive.md), CREDENTIAL_SELF_HEAL.md

## Context

The installer's **"Clean install"** toggle called `/api/system/stacks/reset`,
which wiped **every** service on the node and `rm -rf`'d `/mnt/data/stacks/*` —
despite the modal title naming a single template ("Install Template:
file-share"). On **2026-05-15** a single-template redeploy of file-share with
"Clean install" ticked destroyed the operator's entire stack (nginx, auth,
adguard, home-assistant, file-share, NPM, LLDAP) with **no backups**. Recovery
was impossible.

`cleanInstall` was retired (#1520, hard-set `false` server-side). But that flag
**conflated two features**: the wipe-then-deploy nuke *and* NAS
auto-restore-on-reinstall (#1218), which was gated on the same
`if (!opts.cleanInstall)`. Killing the wipe (correctly) also silently disabled
auto-restore for every install since (#1584).

## Decision

1. **A single-service install/redeploy MUST NOT touch other services' data.**
   System-wide reset exists **only** as an explicit **Factory Reset**, never as
   a side effect of installing or redeploying a template.
2. **Destructive scope must be visually obvious and token-gated** — never trust
   description text. A "wipe just this template" capability is a **separate
   endpoint** with a per-item confirm token, not a widened system-wide reset
   with a scope parameter callers might get wrong.
3. **Auto-restore is decoupled from any wipe flag.** NAS auto-restore-on-
   reinstall is gated on its own safe conditions (a backup exists **and** the
   data dir is empty / `isFreshDataDir`), and logs a visible restore/skip
   breadcrumb. The NAS resolves from `config.gateway` (FritzBox), not from the
   optional `config.externalBackup`.

## Consequences

- Core/atomic-wipe stacks (`basic` = NPM + LLDAP/Authelia + AdGuard) can only be
  wiped via Factory Reset; the TUI/UI blocks unchecking them ([ADR 0008](0008-tui-desired-state-and-journey.md)).
- A *newer* NAS backup over *non-empty* surviving disk data is still skipped by
  `isFreshDataDir` — a known follow-up needs a "newer backup exists — restore?"
  surface rather than silently keeping stale data.
