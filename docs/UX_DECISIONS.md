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
  `@/lib/...` imports from `src/components/**` / `src/hooks/**`.
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
- Root `tsconfig.json` re-exports both for the legacy `src/app/**`
  Next.js shim until that's collapsed into `packages/frontend/`
  fully (Phase 4 follow-up).

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
