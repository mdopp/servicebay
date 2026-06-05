# ADR 0008 — The TUI is a desired-state stack editor and a numbered setup-journey map

- **Status:** Accepted (shipped v4.66.0)
- **Date:** 2026-06-05
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0004](0004-installs-are-non-destructive.md), UX_PHILOSOPHY.md

## Context

The sb-tui needs to present both *what to do next* during setup and *how to
change what's installed* — without surprising the operator (an earlier version
silently redeployed an already-installed stack).

## Decision

**1. The stack panel is a desired-state editor, not a fresh-install checklist**
(`InstallModel.plan()`, pure/unit-tested). It pre-checks what's installed and
acts on the **diff**:
- newly checked → **install**
- installed + `r` → **reinstall** (redeploy)
- installed, untouched → **no-op** (never silently redeploy)
- installed, unchecked → **uninstall** — destructive, so it routes through a
  y/n confirm and a `WIPE-<name>` token (`tokenScope:'destroy'`).

**Core / atomic-wipe stacks (`basic` = NPM + LLDAP/Authelia + AdGuard) cannot be
unchecked** — the backend hard-refuses (Factory-Reset-only, [ADR 0004](0004-installs-are-non-destructive.md)),
and the panel blocks the keystroke. Stacks expand to their templates before
assembling.

**2. The launcher menu is a numbered setup-journey map**, not a flat action
list. The arc is **① stage backups → ② build install USB → ③ boot + watch
install → ④ manage**. Future steps render as greyed signposts, done steps get a
✓, the cursor defaults to the phase's one `Recommended` row.
- **Pre-install phases lead with "Stage existing backups on the NAS" (①), not
  Build/Express** — you stage data *before* you wipe so the fresh install
  restores it. Non-migrators just arrow past it.
- **`UploadToNAS` is ungated from box login** — it talks only to the FritzBox
  over FTP, never the ServiceBay box, so it works with no box at all. Don't
  re-add a token gate.

## Consequences

- Don't "fix" the no-op-on-reinstall or reorder the journey to lead with Build.
- Config is baked into the USB at build time, so step ④ "tweak config" is
  explicitly optional.
