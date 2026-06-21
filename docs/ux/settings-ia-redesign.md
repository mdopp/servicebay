# ServiceBay — UI / Information-Architecture Redesign

> **One idea:** a *service* is one object, so it lives on **one page**. The box has **one** status screen. Settings are **short and goal-shaped**. Everything the system can manage itself **disappears from the UI** until it actually needs you.

Status: concept / spec. Supersedes the flat settings tree. Builds on the (closed-but-unbuilt) design in #1950, plus `feedback_services_are_the_grouping_unit`, `feedback_ux_philosophy`, and `project_diagnose_health_rework`.

---

## 1. The problem

Today the same mental object — *"Jellyfin"* — is split across four surfaces by *implementation layer the user doesn't think in*, and box upkeep is split across two more:

```
/services ................. the tile
/settings/services ........ its knobs
/settings/system .......... the same thing, as a "stack"
/health?tab=containers .... the same thing, as a "container"
/network → select a node .. the same thing, as a map sidebar (out of sync)
/settings/maintenance ..... update / reinstall / reset
/backup ................... backup / restore
```

"Tile vs setting vs stack vs container vs map-node" is *architecture*, not a user's model. Every time someone must remember *which of four pages* holds the Jellyfin thing they want, that's tax. On top of that, the global Settings has grown into a long, flat, intimidating monolith.

**Goals:** consolidate the duplicated surfaces, shrink and de-scare Settings, make everything findable — **without removing any capability** ("don't mutilate" — every knob stays reachable).

---

## 2. Principles

1. **A service is the unit.** One service = one page (its status, health, settings, containers, actions). The list of services is the home.
2. **Group by goal, not by component.** "Reachable from the internet?" is one intent, not 8 knobs (domain + proxy + cert + DNS + …). Bundle and derive.
3. **Three disclosure tiers.** *Essential* shown · *Advanced* one click away · *Auto-managed* not shown at all.
4. **Self-heal first.** Anything the box can decide is **not a setting** — it's silent behavior, surfaced only as a diagnose *fix-it action* when a decision is genuinely unavoidable.
5. **Search is the safety net.** Aggressive hiding is safe *because* nothing is more than one keystroke away.

---

## 3. The new architecture — four nouns

```
Services → [tile] → Operate page   (status + health + settings + containers + actions)
Status   → box-wide health + diagnose
Settings → Network · Access · Notifications · System   (essential-first + search)
Backup   → its own app
```

They map to how people actually think: **my apps · is it OK · configure the box · my data.**

### Before → after

```
BEFORE  ("Jellyfin" scattered across 4 surfaces)        AFTER  (one object → one page)
  /services .............. tile                           Services ─► tile ─► Operate page
  /settings/services ..... its knobs                                         ├─ status + actions
  /settings/system ....... same thing, as a "stack"                          ├─ health
  /health?tab=containers . same thing, as a "container"                      ├─ settings (3-tier)
  /settings/maintenance .. update/reinstall/reset                            └─ containers
  /backup ................ backup/restore               Status   ─► box-wide health
                                                          Settings ─► cross-cutting only
                                                          Backup   ─► its own app
```

---

## 4. Screen by screen

### 4.1 Top nav + Services (home)

```
┌────────────────────────────────────────────────────────────────┐
│  ServiceBay     Services   Status   Settings   Backup    🔍 ▾   │
├────────────────────────────────────────────────────────────────┤
│  Your apps                                                       │
│                                                                  │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐ ┌──────────┐ │
│  │ ● Jellyfin  │ │ ● Immich    │ │ ● Vaultwarden│ │ ● Files  │ │
│  │   media     │ │   photos    │ │   passwords  │ │   share  │ │
│  │   ✓ healthy │ │   ✓ healthy │ │   ✓ healthy  │ │ ✓ healthy│ │
│  └─────────────┘ └─────────────┘ └──────────────┘ └──────────┘ │
│  ┌─────────────┐ ┌─────────────┐                                │
│  │ ● Home Asst │ │ ◐ Solaris   │     + Add a service            │
│  │   home      │ │   updating… │                                │
│  └─────────────┘ └─────────────┘                                │
└────────────────────────────────────────────────────────────────┘
```

A tile is a service is a shared purpose (`feedback_services_are_the_grouping_unit`). One dot = one honest health state. No "stacks", no "containers" at this level.

### 4.2 Operate page — the keystone

Absorbs `/settings/services`, the per-service half of `/settings/system`, and the per-service rows of `/health?tab=containers`.

```
┌────────────────────────────────────────────────────────────────┐
│  ‹ Services                                       Jellyfin       │
│                                                                  │
│  ● Running · media.dopp.cloud · v10.11.11 · up 3d               │
│  [ Open ]   [ Restart ]   [ Reinstall ]   [ Logs ]             │
│                                                                  │
│  ── Health ───────────────────────────────────────────────────  │
│   ✓ Container healthy        ✓ LLDAP login works               │
│   ✓ Reachable (cert valid)   ✓ Libraries indexed (4)           │
│                                                                  │
│  ── Settings ───────────────────────────────── Essential ─────  │
│   Address        media.dopp.cloud                               │
│   Sign-in        LLDAP — family + admins                        │
│   Exposure       Public (internet)                              │
│   ▸ Advanced     libraries · transcoding · port · body-limit    │
│                                                                  │
│  ── Containers ───────────────────────────────────────────────  │
│   media-jellyfin     ● up 3d     637 MB     [logs] [shell]      │
└────────────────────────────────────────────────────────────────┘
```

> **One per-service detail, reused everywhere.** The Operate page is *the* per-service surface — and its summary (status · health · quick actions · "Open Operate page") is a **single shared component**, not re-implemented per place. Anywhere a service/container is selected — the Services tiles, the **Network map's node sidebar**, Status drill-downs — opens that same component. The map's sidebar that's currently "not in sync with the rest" simply *becomes* this component, so there's exactly one source of truth for "what is this service and what can I do with it."

```
┌─ Network map ──────────────────────────┐ ┌─ (shared detail, same as Operate) ──┐
│        (the map — keep as-is)          │ │  Jellyfin            ● Healthy       │
│   ◯ nginx ── ◯ jellyfin ── ◯ lldap     │ │  media.dopp.cloud · up 3d           │
│            └─ ◯ immich  ◯ ...           │ │  [ Open ] [ Restart ] [ Logs ]     │
│                  ▲ selected             │ │  ✓ login  ✓ reachable  ✓ libraries │
│                                         │ │  → Open full Operate page           │
└─────────────────────────────────────────┘ └─────────────────────────────────────┘
   selecting a node opens the SAME shared per-service detail (no bespoke sidebar)
```

### 4.3 Status — box-wide (replaces the per-container tab)

```
┌────────────────────────────────────────────────────────────────┐
│  Status                                        ✓ 19 / 19 green   │
├────────────────────────────────────────────────────────────────┤
│   ✓ All services healthy            ✓ SSO end-to-end            │
│   ✓ Domains reachable               ✓ Backups current (2h ago)  │
│   ✓ Disk 41% · RAM 31%                                          │
│                                                                  │
│   Everything's fine — nothing needs you.                        │
│   ▸ Details (per-check) · Run diagnostics                        │
└────────────────────────────────────────────────────────────────┘
```

When something *is* wrong, the green line becomes the problem + a **fix-it action** (the diagnose `actions[]` pattern), not a wall of raw checks.

### 4.4 Settings — cross-cutting only, 3-tier + goal-based + search

```
┌────────────────────────────────────────────────────────────────┐
│  Settings                                  🔍 Find a setting…    │
├────────────────────────────────────────────────────────────────┤
│  NETWORK & DOMAIN                                                │
│   🌐 Reachable from the internet            ● On   ✓ all good   │
│      dopp.cloud · cert valid · DNS → box   (derived, not 8 knobs)│
│      ▸ Advanced  proxy hosts · DNS records · ports · CAA         │
│                                                                  │
│  ACCESS & PEOPLE                                                 │
│   👤 Who can sign in           family, admins      [ Manage ]   │
│                                                                  │
│  NOTIFICATIONS                 ● On — Telegram      [ Edit ]    │
│                                                                  │
│  SYSTEM                                                          │
│   Updates                      Auto                              │
│   ▸ Maintenance   reinstall · reset · prune                     │
│                                                                  │
│ ─────────────────────────────────────────────────────────────  │
│  Auto-managed by ServiceBay (not settings):                     │
│   credentials · SELinux relabel · cert renewal · DB locks · …   │
│   → only surface as a fix-it action when something needs you     │
└────────────────────────────────────────────────────────────────┘
```

### 4.5 Backup — its own app

Backup/restore is a *task and a workspace*, not configuration, and it's high-stakes + routine (it's step ① of the install journey) — so it earns its own app + launch tile rather than a settings page.

```
┌────────────────────────────────────────────────────────────────┐
│  Backup & Restore                                               │
│                                                                  │
│   Last backup   2h ago → NAS      ✓ verified                    │
│   Schedule      nightly 03:00      [ Edit ]                     │
│   [ Back up now ]                                               │
│                                                                  │
│  ── Restore ──────────────────────────────────────────────────  │
│   From NAS · 2026-06-21 03:00 (full)         [ Restore… ]       │
│   ▸ Older snapshots                                             │
└────────────────────────────────────────────────────────────────┘
```

---

## 5. The disclosure model

Every settings surface (global *and* per-service) classifies each knob into one of three tiers:

| Tier | Shown? | What goes here | Examples |
|---|---|---|---|
| **Essential** | Always visible | The handful people actually change | domain, who can sign in, notifications on/off, a service's address + login |
| **Advanced** | Collapsed (`▸`), defaults intact | Expert knobs — reachable, not in your face | proxy/DNS records, ports, transcoding, body limits, per-service tuning |
| **Auto-managed** | **Not shown** | The system decides / self-heals | credentials, SELinux relabel, cert renewal, DB-lock recovery, label confinement |

The page gets shorter by **deleting** choices (Auto-managed) — not just hiding them. Hidden ≠ gone: Advanced is one click, anything is one search.

---

## 6. Group-by-goal — worked examples

Instead of N atomic knobs, present one **intent** and derive/bundle the rest:

| Intent (what the user wants) | Replaces these scattered knobs |
|---|---|
| 🌐 **Reachable from the internet?** | public domain · NPM proxy host · LE cert · forward-auth · DNS A-record · CAA |
| 👤 **Who can sign in?** | LLDAP users/groups · Authelia access rules · per-service group gates |
| 🔔 **How do I get told when something's wrong?** | notification channel · token · which events |
| 💾 **Is my data safe?** (Backup app) | schedule · destination · what's included · restore |

---

## 7. What leaves Settings to become an "app"

Heavy, workspace-style features are tasks, not configuration. They get their own app + launch tile (gated on the control-plane/worker split, #1949):

- **Disk import** — sort a drive into the canonical folders.
- **Backup & Restore** — as above.

---

## 8. What this *removes*

- `/settings/services` → folded into each Operate page.
- `/settings/system` (stacks/services) → per-service bits → Operate pages; box-level bits (update, reset-all) → Settings ▸ System.
- `/health?tab=containers` → per-service containers → Operate pages; box-wide → Status.
- `/network` node sidebar → the bespoke, out-of-sync sidebar is replaced by the **shared per-service detail component** (§4.2); the map itself stays as-is.
- `/settings/maintenance` → Settings ▸ System + contextual diagnose actions (no standalone nav item).
- The long flat global-settings monolith → short Essential lists per area.
- A whole class of "settings" → simply stop existing (Auto-managed).

No old flat-settings code remains — **rip-and-replace**, no compat shims (the box isn't live, so no migration tax).

---

## 9. Delivery — dependency-ordered slices

Sliced only so a wrong IA call is *cheap to correct* and each piece is box-verifiable — not phasing for caution.

1. **Slice 1 — Operate page + shared per-service detail (do this first).** Per-service page = health + settings + actions + containers, with its summary extracted as a **shared detail component**. `/services` becomes just the list that links to it, and the **Network-map node sidebar renders that same component** (kills the out-of-sync bespoke sidebar). Removes the most duplication for the least risk. *Verify:* every per-service knob from the old surfaces is on the Operate page; selecting a map node shows the shared detail.
2. **Slice 2 — global Settings rebuild.** 4-noun nav, 3-tier disclosure, goal-based groups, global search; rip out the old flat sections; Status absorbs the box-wide health view. *Verify:* default view is lean; every old knob reachable via Advanced or search.
3. **Slice 3 — features as apps.** Disk-import + Backup leave Settings → own app + launch tile (gated #1949). *Verify per feature on the box.*

> Refinement vs #1950: make the **Operate page the explicit first slice** — it's the highest-duplication, lowest-risk win and validates the "service = one page" thesis before the bigger Settings rebuild.

---

## 10. Acceptance criteria

- [ ] Each service has a single **Operate page** (status + health + settings + actions + containers).
- [ ] Default Settings view shows only **Essential**; **Advanced** is one click; **nothing removed** — every old knob reachable via Advanced or search.
- [ ] Any setting is findable by name via **search**.
- [ ] Box-wide health lives on **Status**; no per-container tab.
- [ ] Selecting a node in the **Network map** opens the *same* shared per-service detail (no bespoke, out-of-sync sidebar).
- [ ] `/settings/maintenance` gone as a standalone; maintenance under Settings ▸ System + diagnose actions.
- [ ] Disk-import and Backup are **apps**, not settings pages.
- [ ] No old flat-settings code remains.
- [ ] The IA decision is recorded in `docs/UX_DECISIONS.md`.

---

## 11. Open questions / where judgment is still needed

- **Per-knob classification.** The real labor of slice 2 is sorting *every existing setting* into Essential / Advanced / Auto-managed — a spreadsheet exercise, not covered by this concept.
- **Goal-bundle design.** Each "intent" group (§6) needs its derived-vs-editable fields worked out.
- **Status vs Operate health overlap.** Decide what's box-wide (Status) vs per-service (Operate) so a check isn't shown twice.
- **App vs page boundary.** Confirm which features cross the bar into "app" beyond disk-import/backup.

---

*Concept authored with the operator 2026-06. ASCII mockups are illustrative, not pixel-final.*
