# UX & architecture decisions

A running ledger of choices the project made that are **not derivable
from the code alone** — typically because they were made in response
to an incident, a user constraint, or a tradeoff that has more than
one defensible answer. Read this before "fixing" something that looks
weird; the weirdness is probably the load-bearing part.

For the *philosophy* behind these decisions, see
[UX_PHILOSOPHY.md](UX_PHILOSOPHY.md). This file is the philosophy
*applied* to specific surfaces.

Each entry: **What** the decision is, **Why** it was made (often with
the incident that motivated it), and **Where enforced** (file/line,
rubric, or invariant).

---

## Self-heal first, diagnose-with-actions second

**What.** Every error path walks this hierarchy: (1) heal silently
via retry / readiness probes, (2) surface unavoidable input via a
diagnose probe with a typed `actions[]` array offering structured
one-click remediations, (3) only after both fail does the operator
see a raw error. Expert-only knobs are hidden from the default UI.

**Why.** ServiceBay's audience is family-homelab admins, not IT
experts. Raw error messages anchor on technical jargon they can't
act on. Structured actions ("Restart auth", "Show recent logs",
"Reset wizard") give them a path forward without SSH.

**Where enforced.**
- Rubric: `docs/UX_PHILOSOPHY.md` "The hierarchy" section.
- Code shape: `packages/backend/src/lib/diagnose/probes/*.ts` —
  every probe returns `status / detail / hint? / actions[]`,
  registered via `registerProbeAction(...)`.
- Examples: `oidcProviderReachable.ts`, `npmDataStale.ts`,
  `routerDnsNotPointing.ts`.

---

## "Clean install" / "Reset" toggles are system-wide nukes, not per-template

**What.** The InstallerModal's `Clean install` toggle calls
`/api/system/stacks/reset` which wipes **every** service on the
node and `rm -rf`s `/mnt/data/stacks/*`. It is not scoped to the
template currently being installed, despite the modal title naming
a single template.

**Why.** On 2026-05-15, a single-template re-deploy of `file-share`
with `Clean install` ticked destroyed the user's entire stack —
nginx, auth, adguard, home-assistant, file-share, NPM, LLDAP — with
no backups. Recovery was impossible.

**Where enforced.**
- Destructive scope is visually obvious in the InstallerModal — the
  toggle label includes "wipes ALL services on this node" wording.
- The upgrade-banner's single-template re-deploy path **hides** the
  Clean install toggle (PR #520).
- Future "wipe just this template" features must be a separate
  endpoint, not a parameterized widening of the system-wide reset.

---

## Diagnose probes ship with safety-cascading actions, not raw destructive steps

**What.** When a probe surfaces a problem whose recovery has any
risk of data loss (storage encryption-key drift, LLDAP user-db
wipe), the action is **always** "open the Reset wizard from
Settings → Install" — never a one-click `rm -rf`. The Reset
wizard's confirm-screen guards remain the single chokepoint for
destructive recovery.

**Why.** A one-click destructive action on a diagnose card means a
misread of the probe text is enough to lose data. The Reset wizard's
multi-step confirmation forces the operator to acknowledge what
they're nuking.

**Where enforced.**
- `oidcProviderReachable.ts:289-308` — registers `show_recent_logs`
  + `restart_authelia` only. The `storage` category's `hint` text
  points at the Reset wizard explicitly.
- Convention for new probes: read-only / restart-only actions are
  fine; wiping data goes through the wizard.

---

## Agent disconnect → reset fails → install aborts (safety cascade)

**What.** If the SSH agent disconnects mid-install, the install
runner does **not** continue with partial state — it surfaces the
disconnect, halts the deploy, and refuses to advance the install
state machine. Re-running the install picks up fresh, never with
stale post-deploy state.

**Why.** Continuing past an agent disconnect means writing config
half-updates: a Quadlet file lands, but the post-deploy that
registers an OIDC client never runs, and the next install sees a
"successfully installed" template that's actually broken. This
caused a class of wedged installs in #571's investigation. Failing
fast preserves the invariant that "installed templates are
end-to-end consistent."

**Where enforced.**
- `packages/backend/src/lib/install/runner.ts` — install loop
  aborts on agent error; no partial-success path.
- `packages/backend/src/lib/install/installerSafety.ts` (or similar
  guard) — explicit checks before each phase.
- Don't "improve" this by letting installs proceed with stale state.
  The aborting behaviour is load-bearing.

---

## DNS topology: FritzBox → AdGuard → public-fallback (Pattern B)

**What.** The user's LAN runs Pattern B: FritzBox is the DHCP-DNS,
AdGuard is FritzBox's upstream, and public DNS is the fallback when
AdGuard is unreachable. The `router_dns_not_pointing` probe
explicitly recognises Pattern B as healthy via the FritzBox-upstream
TR-064 signal (#546).

**Why.** When ServiceBay/AdGuard is down, FritzBox transparently
falls through to public DNS — clients keep resolving names. Pattern
A (AdGuard as direct DHCP-DNS) would take the LAN's name
resolution down with AdGuard. Resilience > per-client visibility
for a single-server homelab.

**Where enforced.**
- `routerDnsNotPointing.ts` — Pattern B detected via TR-064 → ok.
- The probe does **not** offer a `configure_fritzbox` action to
  "fix" Pattern B into Pattern A. The user rejected that path.
- If the probe warns post-install, the root cause is usually
  AUTH_SECRET drift garbling TR-064 creds (#565), not a topology
  change desire.

---

## Issues capture symptoms; PRs design fixes

**What.** GitHub issue bodies stay narrowly scoped to symptom +
reproduction + relevant-files. No multi-section fix plans,
acceptance bullets, "what to fix" trees, or speculative root-cause
analysis. Implementation decisions live in the PR that closes the
issue.

**Why.** Pre-designing the fix in the issue body anchors the future
implementer on possibly-wrong analysis, inflates the issue, and
burns time during the observation phase. The operator wants to
capture reality and move on. Solving later, at PR time, is when
the full picture (related files, edge cases, test surface) is
actually available.

**Where enforced.**
- Convention enforced at issue-creation time.
- Sister rule of self-heal philosophy: capture reality, don't
  speculate.

---

## Versions are bumped by release-please, never by hand

**What.** `version` in `package.json`, `package-lock.json`,
`.release-please-manifest.json`, and `CHANGELOG.md` are all owned
by release-please. Merging the release-please PR is the **only**
way to cut a new ServiceBay version.

**Why.** Manual bumps drift across the four files (most often
`.release-please-manifest.json` stays behind), break the
conventional-commits → release-notes pipeline, and produce GitHub
releases with mismatched tags. The release-please PR has been
hand-merged dozens of times; hand-bumping has caused a release
mis-cut every time it's been tried.

**Where enforced.**
- The release-please PR appears on
  `release-please--branches--main--components--servicebay`.
- `MEMORY.md` "Releases" section records the rule for future
  sessions.
- No CI invariant catches a hand-bump today; the rule is process-only.

---

## OnboardingWizard: reset is a hard reset, retry is a soft retry

**What.** The wizard distinguishes two recovery paths:
- **Retry** (soft): re-runs the current phase from scratch with the
  same inputs. Doesn't touch config.json, doesn't wipe storage.
  Default for transient errors (image-pull flake, network blip).
- **Reset** (hard): wipes `config.installedTemplates`, archives
  `/mnt/data/stacks/<name>/`, and returns the wizard to step 1.
  Used when the operator wants a clean re-run.

**Why.** Combining the two into a single "try again" button caused
operators to either (a) lose work on transient errors they'd have
recovered from with a plain retry, or (b) end up wedged when the
real fix was a storage wipe. Splitting them gives the operator
visibility into what their click actually does.

**Where enforced.**
- `packages/frontend/src/components/OnboardingWizard.tsx` — Retry
  vs Reset buttons rendered on distinct conditions.
- Reset always routes through the Reset-wizard confirm screen.

---

## FE ↔ BE workspace boundary: `@servicebay/api-client` is the only seam

**What.** The frontend (`packages/frontend`) talks to the backend
(`packages/backend`) **exclusively** through the typed contract in
`@servicebay/api-client` — Zod schemas and a thin fetch client.
Frontend code cannot import backend lib code; backend code cannot
import frontend components.

**Why.** Before Phase 3 of #753, the frontend pulled in YAML
parsing, Mustache rendering, dependency-annotation parsing, and
secret generation — primitives that should live server-side.
That made it impossible to onboard a frontend-only contributor or
reason about the API surface independently. The contract package
fixes the seam at the type level so drift fails the build, not
production.

**Where enforced.**
- `packages/api-client/src/*.ts` — Zod schemas (the source of truth).
- `packages/frontend/tsconfig.json` paths — only `@servicebay/api-client`
  is import-visible from frontend.
- ESLint rule `sb/no-backend-from-frontend` — blocks
  `@/lib/...` imports from `packages/frontend/src/components/**` / `packages/frontend/src/hooks/**`.
- depcruise rule in `.dependency-cruiser.cjs` — fails the build
  on backend → frontend or frontend → backend-internal imports.
- `docs/ARCHITECTURE_INVARIANTS.md` "FE/BE workspace boundary" row.

---

## tsconfig path strategy: `@/` for in-package, `@servicebay/*` for cross-package

**What.** Inside `packages/backend/`, `@/lib/foo` resolves to
`packages/backend/src/lib/foo`. Inside `packages/frontend/`,
`@/components/foo` resolves to `packages/frontend/src/components/foo`.
Cross-package imports use the explicit `@servicebay/api-client`
package name. There is no `@/` alias that reaches across packages.

**Why.** A single project-wide `@/` alias would defeat the
workspace boundary — `@/lib/anything` from frontend code would
work even when it shouldn't. Per-package `@/` keeps the alias
ergonomic *within* a package while forcing cross-package imports
to look the part (a package import, not a path import).

**Where enforced.**
- `packages/backend/tsconfig.json` paths.
- `packages/frontend/tsconfig.json` paths.
- Root `tsconfig.json` still defines both `@/lib/*` and the per-package
  `@/...` aliases so the Next.js dev server can resolve cross-package
  imports without each workspace having to duplicate them. The
  pre-Phase-3.3 root-level `src/app/**` shim is gone — the routes
  now live entirely inside `packages/frontend/src/app/`.

---

## Primary sidebar is a user-task list, not an infrastructure list

**What.** The desktop sidebar and mobile bottom-nav render from a
single schema in `packages/frontend/src/config/navigation.ts`
(`NAVIGATION_ENTRIES`). Each entry is a user-facing destination —
Services, Network Map, Health, Diagnostics, SSH Terminal, Settings —
not a raw infrastructure object list. Raw container engine, podman
socket, system-vitals, system-logs etc. live as **tabs inside
Diagnostics**, never as peer sidebar entries. New top-level entries
require an explicit user-task justification ("operators need a
one-click path to X"), not "the data exists, let's show it."

**Why.** ServiceBay's audience is family-homelab admins; surfacing
"Container Engine" or "Quadlet files" at the top level trains them
to think of ServiceBay as a podman frontend instead of a homelab
manager. The 2026-05 round of user testing landed on the rule from
[UX_PHILOSOPHY.md](UX_PHILOSOPHY.md) §3: information surface is also
a "knob," and most operators won't have an opinion on it. The schema
indirection (#845) makes the rule enforceable — adding an entry
requires editing the schema, which is reviewable in one place.

**Where enforced.**
- `packages/frontend/src/config/navigation.ts` — the schema.
- `Sidebar.tsx` / `MobileNav.tsx` map over the schema; no inline
  entries.
- [UX_PHILOSOPHY.md](UX_PHILOSOPHY.md) §3 explicitly lists raw infra
  views as expert-only.

---

## Progress and capacity displays answer the household question

**What.** Long-running install / backup / capacity readouts default
to the *household-decision* framing — "about 2 minutes to go", "~3
years of photos left at current upload rate" — not the raw
bytes/seconds/percent that a dashboard designer would emit. Raw
numbers are reachable on hover or behind a "Details" expand for
operators who explicitly want them.

**Why.** A 16.7% disk gauge tells someone with networking experience
"plenty of room"; a family operator either ignores it or worries
unnecessarily. "~3 years of photos left" lets them decide whether to
keep uploading. Same logic for install progress: "Setting up
Vaultwarden (4 of 6 services ready)" beats "image pull 7/12 · 2
healthy" because the operator's actual question is *"is something
hung or is this normal?"* — a service-name + ratio + ETA answers it,
raw image counts don't.

**Where enforced.**
- [UX_PHILOSOPHY.md](UX_PHILOSOPHY.md) §5 with concrete bad/good
  pairs for progress, capacity, and backup readouts.
- The install overlay (#805 work) is the first surface to adopt the
  pattern end-to-end; existing diagnostic panels keep raw numbers
  while diagnose probes drive household-framed action labels.

---

## Portal access: user-cap + LAN-only gate are config toggles, not code gates

**What.** Two optional access controls, both off by default, live under
**Settings → Portal Access**:
- **Max users** — portal access-request approvals stop when approved +
  pending reaches `config.portal.maxUsers` (default 20). Prevents
  runaway user provisioning without an explicit quota.
- **LAN-only portal** — when enabled, `/portal` submissions are rejected
  from non-RFC-1918 source IPs. Prevents public internet exposure of the
  family-portal registration page without firewall changes.

**Why.** Both controls are appropriate for a family homelab but wrong as
hardcoded defaults — a user installing ServiceBay on a VPS or behind a
CGNAT should be able to set a different cap or disable the LAN gate. The
guard lives server-side (`packages/backend/src/lib/portal/lanGate.ts`,
`userCap.ts`) so it survives a frontend replacement.

**Where enforced.**
- `packages/backend/src/lib/portal/lanGate.ts` + `userCap.ts` — the
  server-side gate. Both functions are injected (testable without real
  config).
- `packages/frontend/src/app/(dashboard)/settings/_lib/sections/PortalAccessSection.tsx`
  — the Settings UI.
- Config flags: `config.portal.maxUsers` (number, default 20),
  `config.portal.lanOnly` (boolean, default false).

Landed in #1464 (2026-06-01).

---

## MCP bootstrap token: re-activatable from Settings

**What.** The bootstrap MCP token (created during onboarding) expires after
~30 minutes. It is now re-activatable from **Settings → API Tokens** with
a single click — same token identity and scope, fresh 30-minute expiry,
LAN-only. There is no "extend indefinitely" option; long-lived access uses
named API tokens (Settings → MCP).

**Why.** Bootstrap token is meant for the onboarding agent, not for ongoing
use — so the 30-minute hard expiry is intentional. The re-activate flow is
the operator asking "I'm still onboarding" — not a workaround for the expiry
policy. The "no permanent bootstrap" rule is upheld; extending returns a
bounded fresh window, not a long-lived token.

**Where enforced.**
- `packages/backend/src/lib/mcp/bootstrapToken.ts:reactivateBootstrapToken`
  — re-keys the expiry; never promotes the token to a different scope.
- `packages/frontend/src/app/(dashboard)/settings/_lib/sections/ApiTokensSection.tsx`
  — renders the Re-activate button only for the bootstrap token.
- `packages/frontend/src/app/api/system/mcp-bootstrap/route.ts` — enforces
  LAN-only origin on the reactivate endpoint.

Landed in #1457 (2026-06-01).

---

## Diagnose probes live in the Health Checks tab, not a separate Self-Diagnose tab

**What.** The "Self-Diagnose" tab that previously appeared alongside "Checks" in
the Health dashboard has been removed. Diagnose probes are now surfaced as
*synthetic rows* inside the Health Checks tab — they appear alongside scheduled
checks, use the same four-way `ok / warn / fail / unknown` counters, and open a
**Self-Repair popup** (wrench icon) instead of Edit/Delete buttons. The popup
reuses `DiagnoseProbeList`'s action machinery so the recovery UI is identical
to Settings and the wizard.

**Why.** The separate tab created two fragmented views of the same runtime
state — operators had to visit "Checks" to see monitoring results and "Self-Diagnose"
to see recovery actions. Merging them into one surface with a single status filter
means every unhealthy signal (scheduled check or probe) shows up in the same
filtered list. The "warn" counter is new (previously warn was folded into fail),
surfacing probes that need attention without implying a hard failure.

**Where enforced.**
- `packages/frontend/src/dashboards/HealthDashboard.tsx` — `HealthTab` union no
  longer includes `'diagnose'`; `SelfDiagnoseSection` is gone.
- `packages/frontend/src/components/HealthChecks.tsx` — `isDiagnoseRow()` detects
  synthetic rows (check carries a `.diagnose` field); wrench button replaces
  Edit/Delete; `rowStatus()` projects the four-way probe status.
- `packages/frontend/src/components/HealthChecks.tsx` — grid changed from 3 to
  4 counter columns; `StatusFilter` now includes `'warn'`.
- `packages/backend/src/lib/health/init.ts` — health probe rows are injected
  into the standard checks list at boot.

Landed in #1470 (2026-06-01). Closes #1423 (self-repair popup) and #1454/#1455.

---

## SSO verify runs automatically post-install, result surfaced as a diagnose probe

**What.** After any install that includes an auth template, the install runner
triggers `verifySso` in the background. The result is stored in a persistent
`ssoVerifyStore` and exposed as the `sso_verify` diagnose probe (in the Health
Checks tab, per the decision above). The probe is a *reader* in steady state;
an on-demand "Run SSO check" action re-runs the full create → login → domain →
admin-reject → delete cycle.

**Status mapping:**
- No report yet → `info` ("has not run yet")
- Auth template not installed → `info` ("nothing to verify — skipped")
- `report.ok === true` → `ok`
- `report.ok === false` → `fail`

**Why.** SSO is the most common post-install failure vector and previously had
no automated coverage — the operator had to discover broken SSO by trying to log
in. Auto-running the verify immediately after install catches the common failure
cases (wrong LLDAP group, Authelia unreachable, domain not proxied) while the
install context is still fresh, without requiring the operator to manually trigger
a check.

**Where enforced.**
- `packages/backend/src/lib/install/runner.ts` — post-install SSO verify trigger.
- `packages/backend/src/lib/diagnose/ssoVerify.ts` — end-to-end SSO check spine.
- `packages/backend/src/lib/diagnose/ssoVerifyStore.ts` — persistent store for the
  latest report.
- `packages/backend/src/lib/diagnose/probes/ssoVerify.ts` — probe reader +
  `run_now` action.

Landed in #1470 (2026-06-01). Closes #1453 (verifySso), #1454 (auto-run post-install),
#1455 (sso_verify probe).

---

## Disk-import "Import data" card: review gate + non-blocking actions[]

**Decision.** The disk-import flow (Settings → Sharing → "Import data") is
**device → scan → review → CONFIRM → apply**. The scan mounts the USB
**read-only**, sorts everything deterministically, and writes **nothing** — it
returns a plan + a `sessionId`. The apply route refuses unless it is handed back
that `sessionId` (a plan scanned in this process) **and** an explicit
`confirmed: true`. There is no path to apply an unreviewed plan.

**Unavoidable input surfaces as `actions[]`, and never blocks.** Folders the
classifier can't place (music vs audiobook, an unknown extension) and target
conflicts (two different files → same path) are surfaced as Diagnose-style
`actions[]` in the review. Each carries a **safe default** (ambiguous → filed
under `documents/`; conflict → newer file wins, older parked in `_superseded/`,
nothing deleted), so the import runs fine if the user resolves none of them. The
card says so explicitly ("These don't block the import"). This is the UX
philosophy (`feedback_ux_philosophy`): self-heal/auto-sort silently, ask only for
the two genuinely unavoidable inputs — *which device* and *the confirm* — and
treat ambiguity as advisory follow-ups, not a wall.

**Why.** This is the product feature for families migrating off the cloud, run by
non-experts. A blocking question per ambiguous folder would stall a 50k-file
import; a silent auto-apply would risk an unreviewed move. The read-only mount +
explicit confirm gives the same safety as the CLI's review gate (#1696) without a
wall of prompts.

**Where enforced.**
- `packages/backend/src/lib/diskImport/service.ts` — the in-process review-gate
  store (`scanDevice` → `sessionId`; `applyImportPlan` requires it) + `actions[]`
  derivation.
- `packages/frontend/src/app/api/system/disk-import/{list-devices,scan,apply}/route.ts`
  — thin wiring over the service; apply requires `sessionId` + `confirmed: true`.
- `packages/frontend/src/app/(dashboard)/settings/_lib/sections/DiskImportSection.tsx`
  — the card; ambiguous items render as a non-blocking advisory list.

Landed in #1697 (disk-import epic #1698; engine #1693, host-apply #1694).

---

## Maintaining this doc

Add an entry when:
- A decision was made because of an incident (link the date / PR).
- A surface looks weird and the weirdness is intentional.
- A user setup choice differs from the "default" and shouldn't be
  auto-fixed.
- A multi-PR refactor finishes and the resulting shape needs
  context that's not obvious from the diff.

Don't add an entry for:
- Anything `git log` / `git blame` already tells you.
- Code conventions (those live in `CLAUDE.md` files).
- Per-feature behaviour (that's the feature's README).
