---
name: autoloop-issues
description: Work the open-issue backlog autonomously, up to 8 PRs per invocation, with mandatory real-box `/verify` on install/config/auth/portal paths. Resumable across /loop firings via .claude/state/autoloop-state.json. `security`-labelled issues open as draft and wait for human review. Use when the user asks to "burn down the backlog", "work the issues autonomously", or invokes /loop with this skill.
---

# Autoloop: backlog burndown

You are working a queue of open GitHub issues on this repo, with explicit exit conditions and a resumable state file. The project is pre-production, so the loop is allowed to merge changes across most of the codebase — but only after CI green, and (on install/config/auth/portal paths) only after real-box `/verify` green. Issues with the `security` label open as draft PRs and wait for human review.

The user's recurring rules (in `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md`) override anything in this skill if they conflict. Read it before the first iteration of a fresh /loop run.

## Per-invocation budget

- **At most 8 PRs per invocation.** Then exit cleanly. `/loop` re-fires you.
- This still counts security-gate drafts toward the budget — a draft PR is still one PR's worth of work.
- **A cluster (grouped issues, Step 1 grooming) counts as one PR** toward the budget, even though it closes several issues — that's the whole point: fewer pipeline runs for the same backlog drain.
- If you've spent >40 minutes on a single issue without a green PR, stop, post a comment on the issue explaining what's blocking, and move on.

## Wakeup cadence (dynamic /loop mode)

Every `ScheduleWakeup` call from this skill uses **`delaySeconds: 480` (8 minutes) or less** — including the "release PR open" / "CI running" / "nothing to do" fallback heartbeats. This **overrides the /loop skill's general 1200–1800s suggestion** for cache-aware waits.

**Why:** the user wants the backlog drained quickly; long fallbacks stall progress when an external gate (release PR merge, CI completion) clears mid-window. Burning the prompt cache every 8 minutes is the accepted cost. See memory `feedback_autoloop_wakeup_cap`.

## State file

Track progress at `.claude/state/autoloop-state.json`. Shape:

```json
{
  "started": "2026-05-27T14:00:00Z",
  "last_invocation": "2026-05-27T15:12:00Z",
  "completed": [
    {"issue": 1094, "pr": "https://github.com/mdopp/servicebay/pull/1110", "gate": "normal", "merged_at": "..."}
  ],
  "in_progress": null,
  "skipped": [
    {"issue": 1078, "reason": "security gate; draft PR #1115 awaiting human review"}
  ],
  "blocked": [
    {"issue": 1086, "reason": "scope too large for single PR; needs split"}
  ],
  "awaiting_user": [
    {"issue": 1311, "comment_url": "https://github.com/mdopp/servicebay/issues/1311#issuecomment-…", "author": "wenghuiming1987", "since": "2026-05-30T07:23:19Z"}
  ],
  "clusters": [
    {"id": "fe-layout", "theme": "frontend layout", "issues": [1420, 1424, 1427, 1428], "region": "packages/frontend/src/dashboards", "gate": "normal", "status": "open"}
  ],
  "box_verify": {"sha": "abc1234", "status": "green", "verified_at": "2026-06-01T04:00:00Z"}
}
```

`clusters[]` is the groomed output (Step 1 grooming): each entry bundles related issues worked as one branch/PR. `gate` is inherited (strongest member: `security` ⇒ draft, any path-mandated member ⇒ `/verify`). `status` is `open | in_progress | done`. A cluster's member issues do **not** also appear as standalone queue units — the cluster is the unit.

`box_verify` (#1433) tracks the batched `:dev` box-verify owed by path-mandated merges. `status`: `"owed"` (merged, not yet verified — release blocked), `"red"` (verify failed — release blocked until reverted+re-verified), `"green"` (clear to release). Preflight Step 0.3 reads it before merging the release PR.

Update it at every state transition. If the file doesn't exist, create it with empty arrays.

## Comment hygiene (every comment the loop posts)

Every GitHub comment this loop posts — the ambiguous-question ask (Step 2), the >40-min blocker, the CI-red notices (Step 0.3, merge-gate), the epic dependency DAG (track b), the lint refactor-ticket link — must end with the AI marker (memory `feedback_ai_comment_marker`):

```
<!-- sb-ai-comment -->
🤖 _AI-generated, acting for @mdopp._
```

It posts as `mdopp`, so without the marker no one can tell the comment is AI-written. The marker is also what the exclusion filter and `/comment-responder` read to decide a thread is or isn't already AI-answered. The loop **never** posts replies to external human commenters (see the exclusion filter) — those go through `/comment-responder` with the user confirming. Keep comments short and sharp (memory `feedback_concise_answers`).

## Step 0 — Preflight (every invocation)

Before touching any issue:

1. **Working tree clean?** `git status --porcelain`. If not, exit — another session is working here. Do not stash, do not switch branches.
2. **On `main` and up to date?** `git fetch origin && git checkout main && git pull --ff-only`. If the FF fails, exit and report.
3. **Release-please PR open? Merge it before doing anything else.** Run `gh pr list --head release-please--branches--main--components--servicebay --state open --json number,title`. If non-empty:
   - **Box-verify gate (#1433):** if `state.box_verify.status` is `"red"` or `"owed"`, a path-mandated change is on `main` but unverified on `:dev` — do **not** merge the release PR yet (it would ship unverified install-path code to `:latest`). Run the Step 4.5 batched `:dev` verify first; only proceed once `state.box_verify.status` is `"green"` (or no path-mandated changes are pending). If the verify is red and the culprit isn't reverted yet, post on the release PR and **stop**.
   - Wait for CI: `gh pr checks <PR#> --watch`.
   - If CI is green: `gh pr merge <PR#> --merge --delete-branch`, then `git pull --ff-only`. Continue to step 4.
   - If CI is red: post a comment on the release PR with the failing job link and **stop**. The user needs to look — the release PR rolling up commits the loop made is the loop's responsibility to keep mergeable, but a red CI here usually means a real regression that piling more commits on top will hide.
   - **Do not edit the release PR's contents.** It's machine-generated; release-please owns version bumps, CHANGELOG, and `.release-please-manifest.json` (memory: *"NEVER manually bump versions"*). Merging it is fine; modifying it is not.
   - Why this is safe to auto-merge: the PR's diff is mechanical (version + CHANGELOG + manifest) and rolls up commits already on `main`. There is no new code to review — the review happens at the feature-PR level. Leaving it open blocks the loop indefinitely (which is exactly the situation that motivated this rule).
4. **Lock check.** Read `.claude/scheduled_tasks.lock` if present. If another /loop invocation is currently running (mtime within last 10 minutes), exit.
5. **Read state file.** Resume from `in_progress` if set; otherwise pick the next issue per the selection rules below.

## Step 1 — Issue selection

Run:
```bash
gh issue list --state open --limit 100 --json number,title,labels,body
```

### Exclusion filter (drop any issue matching any of these)

- Labels include any of: `postponed`, `wontfix`, `duplicate`, `autoloop-open`. (`oscar`-labelled issues are **in scope** — they go through normal classification below.)
- Issue number appears in `state.completed[]`, `state.skipped[]`, `state.blocked[]`, or `state.awaiting_user[]` of the state file.
- **Unaddressed external comment** — an external human had the last word and we haven't replied. Fetch comments (`gh api repos/mdopp/servicebay/issues/<N>/comments`); the issue is parked if the **chronologically-last comment** is authored by a non-owner (`login != mdopp`), non-`Bot` account whose body lacks the `<!-- sb-ai-comment -->` marker. Do **not** work it — move it to `state.awaiting_user[]` (`{issue, comment_url, author, since}`) and skip. The loop never replies to external commenters itself (no human to confirm the draft); replying is the `/comment-responder` skill's job. Re-checked every run, so the ticket auto-clears from `awaiting_user[]` once an owner reply lands and becomes eligible again.
- Issue title or body is clearly multi-PR scope: words like "audit", "strategy", "epic", or describes work that obviously spans multiple changes. Mark these as `blocked` in state with reason `"needs scoping"` and move on — *or*, in a refine pass (track b) or when the user asks, **decompose** it into bite-sized child issues (see track b's "Decomposing an epic") and keep this one open as the tracking umbrella.

### Classification (everything that survives the filter)

Two buckets — both produce a code PR; the difference is what happens at merge time:

- **Security gate** — labels include `security`. Code PR is opened as **draft**, and the loop never merges it. Step 4 labels the issue `autoloop-open` and adds it to `state.skipped[]` with reason `"security gate; draft PR #X awaiting human review"`. Covers things like #1078/#1079/#1080/#1101.
- **Normal flow** — everything else (including `oscar`-labelled issues). Code PR, merged after CI green + (if applicable) real-box `/verify` green.

**`oscar`-labelled issues:** OSCAR feature work now lives in its own repo (`mdopp/oscar`, which has its own autoloop skill). So an `oscar`-labelled issue *in this repo* should first be triaged: if it's actually OSCAR-side work (Hermes skills, `oscar-household` template, voice-gatekeeper), migrate it to `mdopp/oscar` and close it here; only keep it if it's genuinely ServiceBay-side glue (install path, asset-transport, MCP wiring that SB owns). For anything kept, normal flow applies — and since it'll touch install paths, the path-mandated `/verify` rules in Step 3 apply.

### Grooming & clustering (run once per invocation, before selection)

Before picking the head, run a fast grooming pass over the survivors so the builder consumes a **groomed, ordered, clustered** queue. The payoff is **collapsing N full pipeline runs into 1 per cluster** — today 8 issues = 8 PRs = 8× (CI + box `/verify` flip + merge); a coherent cluster worked as **one branch → one PR** runs the whole pipeline **once** and rolls into the already-batched release (issue #1434).

Grooming runs every invocation that has **≥2 survivors** (skip it for a single survivor — nothing to cluster). It's cheap: issue metadata + a few `git grep`s. Steps:

1. **Dedup / close-at-HEAD.** For each survivor, sanity-check it isn't already fixed at `HEAD` — the symptom file/line no longer matches, or a merged PR already resolved it. If the code plainly shows it resolved, close the issue with a one-line comment linking the fixing commit/PR (+ AI marker) and drop it from the queue. Don't guess; only close on clear evidence.

2. **Cluster by code region / theme.** Group survivors that touch the **same files or subsystem** (e.g. a frontend-layout cluster like #1420/#1424/#1427/#1428, an install/credential cluster, a diagnose-probe cluster). A cluster is worked in **one context and one branch/PR** when the changes are genuinely related — shared understanding, one CI run, one verify flip, one merge. Cap a cluster at what stays reviewable (rule of thumb: ≤4 issues / ≤~400 LOC net / one coherent theme); beyond that, split into two clusters.

   - **Attribution must survive.** Only cluster issues whose changes are *in-scope of each other*, so a red CI on the cluster points at its one theme — not a random bisect. Do **not** cluster unrelated issues just to share a pipeline run by default.
   - **Unrelated-batch escape hatch (dev-box only).** You *may* stage several unrelated green-CI changes on one branch purely to share a CI run / verify flip, but only with "red → bisect" explicitly accepted. The default is region-coherent clusters.
   - **Gate inheritance.** A cluster's gate is the *strongest* of its members: if any member touches a Step 3 path-mandated path, the whole cluster's PR needs `/verify` (one flip covers it — this is the #1433 batch-verify win); if any member carries the `security` label, the **whole cluster** opens as a draft and never auto-merges (so don't cluster a security issue with normal ones unless you want the normal ones to wait on human review — usually keep security issues solo).

3. **Split oversized.** An issue that's multi-PR scope is decomposed into dependency-ordered bite-size children (the existing track-b "Decomposing an epic" move) and the children are **re-interleaved** into the queue. File children so ascending issue number == dependency order.

4. **Emit the groomed queue.** Record clusters in `state.clusters[]` (see shape below) so the work is resumable across firings. The selection order treats each cluster as a **single unit**.

### Selection order within survivors

A unit below is either a **single issue** or a **cluster** (from grooming). A cluster sorts into the highest-priority bucket any of its members would land in, and within a bucket sorts by its lowest member issue number. `state.priority[]` may list either an issue or a cluster id.

0. **Priority overrides — jump the whole queue.** Two ways to pin work ahead of the normal buckets (use either or both; the operator sets these to front-load force-multiplier/infra work that speeds everything after):
   - **Explicit, ordered:** any open issue whose number is listed in `state.priority[]`, worked **in the order listed there**. The loop does not mutate this list — completed issues simply stop matching (they're no longer open). This is the way to pin a specific sequence, e.g. `"priority": [1433, 1434, 1435]`.
   - **By label:** any issue carrying the `priority` label, ascending issue number.
   `state.priority[]` entries come first (in list order), then `priority`-labelled issues, then the buckets below. A priority issue still goes through the normal gates (CI, and `/verify` if it touches an install/config/auth/portal path) and the normal security-draft rule.
1. `good first issue` label first.
2. Then `bug` label.
3. Then `testing` label.
4. Then `docs` / `documentation` labels.
5. Then everything else, ascending issue number.

Pick the head. Update state: `in_progress = {issue, branch, gate: "security"|"normal", started_at}`.

### No eligible issues — choose a track

If Step 1 returns no survivors, **do not auto-default to lint and do not exit.** Decide which of three tracks to run this invocation:

- **a) Lint problems** — fall through to **Step 1b (lint sweep)** below: drive the ESLint warning count down with small, single-file extractions.
- **b) Refine & unblock issues** — walk `state.blocked[]` and the open issues. For each blocked entry, re-check whether a recent merge or a smaller scoping makes it actionable now; if so, remove it from `blocked[]` and either work it (back to Step 2) or carve off a bite-sized first PR. Also tighten thin/ambiguous issue bodies (symptom + repro + starting-point files per memory `feedback_issue_scope`), and run the full **grooming & clustering pass** (Step 1): dedup/close issues already fixed at HEAD, cluster by code region, decompose oversized issues. Deliverable: a refreshed, actionable, **clustered** queue — then pick the head and work it.

  **Decomposing an epic** is a first-class track-b move (and the better alternative to parking a multi-PR issue as `needs scoping`): break it into bite-sized child issues filed in the repo so the loop can actually ship it incrementally. Rules:
    - Each child is an independently-shippable PR-unit; land **foundational modules first** (pure data/helpers, clients), then their consumers. No dead-code-only stubs — every child must be a genuine, testable unit.
    - **File them in dependency order so ascending issue number == dependency order.** The loop selects ascending within a bucket and works issues sequentially, so this makes it ship them in the right sequence; a child whose `Depends on #N` sibling is still open is skipped until #N merges.
    - Each child body gives the deliverable + starting-point files + a `Depends on #N` line for any sibling that must merge first. Label them like any normal issue so classification routes them.
    - Comment the dependency DAG on the parent and keep the parent **open as the tracking epic** (don't auto-close it).
- **c) Evaluate the codebase** — run the standing evaluation prompt (below) against HEAD, then file the **Category 2 (Pragmatic)** findings as new issues so the queue refills. Keep issue bodies symptom-style (memory `feedback_issue_scope`): symptom + exact file/line + real-world consequence; do **not** paste the patch outline into the issue (that belongs in the PR). Record **Category 1 (Academic)** findings in `state.notes[]` only — don't file or work them. This is the one sanctioned exception to "does not file new issues."

**How to choose:**
- **Interactive invocation** (a human is at the terminal): ask via `AskUserQuestion` and let the operator pick a/b/c.
- **Autonomous invocation** (`/loop` firing, no human): default in this order — **(b)** if `state.blocked[]` is non-empty (keep it from ossifying); else **(c)** if no codebase eval is recorded in the last ~5 invocations (`state.last_codebase_eval`), to refill the queue; else **(a)** lint as steady filler. Record the chosen track (and, for c, the eval date) in `state.notes[]` / `state.last_codebase_eval`.

The loop still only stops via the Hard exit conditions in §"Hard exit conditions" — and with track (c) available, the "nothing mechanical left" condition (#6) should almost never be hit; prefer (c) over exiting.

#### Codebase-evaluation prompt (track c)

Run this prompt verbatim against the current HEAD:

```
Evaluate the ServiceBay codebase across our core areas (subprojects, frontend, backend, UX, and documentation).

Assume the baseline that this is already a solid, highly functional, and production-ready homelab OS. Do not give me generic style-guide complaints (like file length or minor type casts) unless they have a direct, measurable impact on bugs or developer velocity.

CRITICAL REQUIREMENT: Your findings MUST focus exclusively on active, unresolved bugs, logical flaws, security exploits, or UX friction points present in the current state (HEAD commit) of the codebase. Do NOT reference historical issues, resolved bugs, or refactors that have already been fixed and merged in past pull requests, git commits, changelogs, or documented audits. Inspect actual active source files to verify the issues are currently live.

Please group your findings into exactly two distinct categories:

1. 🏛️ Academic / Theoretical (Nice-to-Have)
These are changes that look great on a UML diagram or satisfy academic clean-code metrics (e.g., splitting working React components just to satisfy line counts, over-abstracting simple modules, or theoretical refactors). We *could* do these, but the real-world ROI is near zero at our current scale.

2. 🛠️ Pragmatic / Real-World (Should-Do)
These are active, load-bearing vulnerabilities or flaws in the current live code that directly compromise system security, threaten data integrity, risk runtime/deployment crashes, or represent active UX dead-ends that currently block or frustrate users.

For each item in Category 2, you must:
a) Point to the exact active file(s) and line number range where the flaw resides.
b) Briefly explain the actual real-world consequence if we choose to ignore it.
c) Provide a brief outline of how to patch the live code to resolve it.
```

After the eval: file each Category 2 finding as its own issue (symptom-style, no patch plan in the body), label appropriately (`bug`/`security`/etc. so classification routes it), and let the next Step 1 pass pick them up. Then continue this invocation by selecting the head of the now-refilled queue (Step 2), budget permitting.

## Step 1b — Lint-warning sweep (fallback / filler)

The goal of this step is **drive the ESLint warning count to zero**. Every warning class is fair game, including the structural rules (`max-lines-per-function`, `complexity`, `max-lines`, `any`, `eslint-disable`). The constraint is *PR shape*, not *warning class*: each lint-sweep PR stays small and focused, even if the warning it clears is structural.

This step runs in two cases:
- **Fallback**: Step 1 returned no eligible issue survivors.
- **Opportunistic**: you finished an issue-PR with PR budget remaining and the issue queue is dry.

Run:
```bash
npm run lint 2>&1 | tee /tmp/lint.out
grep -oE "[a-zA-Z@/][a-zA-Z0-9@/-]*$" /tmp/lint.out | sort | uniq -c | sort -rn
```

### Per-PR size guard (the only real "out of scope" rule)

A lint-sweep PR must:

- Touch **≤2 source files** (plus their `*.test.*` siblings).
- Net diff **≤120 LOC** added/changed (subtractive PRs that mostly delete code can be larger).
- Stay scoped to a single warning class **OR** a single file. Bundling unrelated rules across many files is what `/code-review` is for, not the loop.

If clearing a warning would require violating these limits — e.g. fully decomposing a 2000-LOC dashboard — instead **scope a single bite-sized extraction**: pull out one obvious sub-component / hook / helper that drops the warning count by at least one. Leave the rest for the next iteration. The point is steady forward motion, not heroic refactors.

If even a bite-sized extraction can't fit within the size guard, mark the file in `state.blocked[]` with reason `"lint-sweep size guard exceeded; needs decomposition ticket"` and move on.

### File-collision avoidance (do not conflict with parallel human work)

Before picking a file, check whether a human is already working it:

```bash
gh pr list --state open --search "<file basename>" --json number,title,headRefName,author
```

Skip the file (don't block — just pick the next-most-warned) when:

- An open non-`autoloop-open`, non-`chore/lint-*` PR touches the same file.
- The file appears in `git diff main...<any-non-fix/issue-*-branch>` from the last 24 h.
- The file is named in any open issue's "Relevant Files" section that is NOT already in `state.blocked[]`.

The first two are mechanical checks; the third matches the user's explicit "I'm reworking blocked issues" pattern — those issues' Relevant Files are the ones being actively reshaped.

### Selection within remaining warnings

1. Group remaining warnings by file (run the bash grep above).
2. Drop files that fail the file-collision check.
3. Pick the file with the most warnings (ties: ascending file path).
4. Within that file, pick the warning *class* you can fix in one focused PR — usually the rule that appears most often in that file, sometimes a single tricky one (e.g. one `complexity:25` that gets fixed by extracting one helper).
5. If no eligible file remains → fall through to Hard exit condition §7 ("Both queue and lint set are empty").

### PR shape

- Branch: `chore/lint-<short-file-tag>` (e.g. `chore/lint-stackInstall-useCallback`).
- Commit subject pattern follows the work, not the rule:
  - `chore(lint): drop unused <imports|vars> in <file>` — `no-unused-vars`
  - `refactor(<scope>): extract <helper> from <file>` — `max-lines-per-function`, `complexity`, `max-lines`
  - `fix(<scope>): tighten <Type> in <file>` — `any` removal that uncovers a real type bug
  - `chore(<scope>): replace eslint-disable with <X>` — disable-directive scrub
- No `Closes #` line — the sweep is not closing a ticket. (If you happen to fully clear a file that an open `[Refactor]` ticket names, comment on that ticket linking the PR; do not auto-close it — let the user judge.)
- Same gates as Step 3 + Step 4. `/verify` only if the touched file is in the path-mandated list.
- This still counts as 1 of the 8 PRs in the per-invocation budget.

Update state file: append `{file, rule, pr, merged_at}` to `lint_sweep[]` (initialise it empty if absent). Tracking `rule` per entry helps the next iteration avoid re-touching the same class on the same file (one bite at a time).

## Step 2 — Implementation

### Branch
```bash
git checkout -b fix/issue-<N>-<kebab-summary>          # single issue
git checkout -b fix/cluster-<theme>-<N1>-<N2>...       # cluster (grooming output)
```
(State `in_progress` was set in Step 1; nothing to update here.)

**Working a cluster:** read *every* member issue and its `Relevant Files` first, then implement all members on the one branch as a coherent change. Keep the diff organized by theme, not by issue, since the members share a code region. The cluster still obeys scope discipline as a whole — its theme is the boundary; don't drift into unrelated files just because you're already in there.

### Read the issue and the referenced files
- Open the issue body. Note the `Relevant Files` section.
- Read each referenced file fully.
- Read the surrounding ~50 lines of any line-number reference.
- If the issue body looks ambiguous, post a comment on the issue asking the specific question and move on. **Do not guess.**

### Scope discipline
- Implement the smallest change that closes the ticket.
- **Default rule:** do not refactor neighbouring code, do not introduce abstractions, do not "improve while you're in there."
- **Refactor-ticket exception:** if the ticket title starts with `[Refactor]` and its body describes the refactor, stay within the file/module the ticket names. If you genuinely need to touch a neighbouring file, open a *separate* PR for it — don't bundle it as a drive-by.
- The user's CLAUDE.md says: *"Three similar lines is better than a premature abstraction."* Honour it for non-refactor tickets.
- If the issue text says "audit", "strategy", or "epic", you should not have reached this step — Step 1 marks those `blocked`. If you did reach here, back out and update state.

### Invariant ratchet
Per `docs/ARCHITECTURE_INVARIANTS.md`: when you resolve an exemption, tighten the ratchet in `scripts/check-invariants.ts` or `.dependency-cruiser.cjs`. Do **not** loosen them.

## Step 3 — Local verification

Run in this order. Each must pass before the next:

```bash
npm run lint                # 0 errors. Warnings allowed only if count did not increase.
npm run check:arch          # invariants + depcruise. Must pass.
npm test                    # all unit tests. Must pass.
```

**Mandatory real-box `/verify` for these paths.** If the PR diff touches *any* file under:

- `packages/backend/src/lib/install/`
- `packages/backend/src/lib/config.ts`
- `packages/backend/src/lib/agent/`
- `packages/backend/src/lib/systemBackup.ts`
- `packages/backend/src/lib/mcp/`
- `packages/frontend/src/app/portal/`
- `packages/frontend/src/app/(dashboard)/`
- `packages/frontend/src/dashboards/`
- `packages/frontend/src/components/OnboardingWizard.tsx` (or its decomposition)

then it needs a real-box `/verify` — CI green is necessary but not sufficient; the dev-container can't catch install-path regressions.

**The box can now run the just-merged code, so verification is no longer deferred (#1433).** The box runs a frozen released image on the `:latest` channel, so it can't exercise *un*merged code — which is why install-path verifies used to be deferred to a later reinstall (the `project_463_deferred_verifies` pattern). Since 4.67/4.68 the box has a runtime channel switch (`sb-tui channel dev` / `sb-tui channel latest`, equivalently `GET·POST /api/system/channel`; see `tools/sb-tui/internal/rest/channel.go`, `tools/sb-tui/internal/ui/channel.go`, `packages/backend/src/lib/servicebayChannel.ts` for the exact invocation/payload), and `release.yml` auto-publishes every non-release `main` commit as `ghcr.io/mdopp/servicebay:dev`. So the flow becomes **merge → flip box to `:dev` → `/verify` the merged code → flip back to `:latest`**, all *before* the change ships to `:latest` via the release. No more deferral for these paths.

The verify gate therefore splits in two:
- **Code gate (per PR/cluster, Step 4 merge gate):** CI green ⇒ merge to `main`. Safe even for install-path changes — only the `:dev` test channel gets the code; `:latest` users are unaffected until the release PR merges.
- **Box gate (batched, Step 4.5):** one `:dev` flip-verify-flipback per invocation covering every path-mandated change merged this run. The release PR (preflight Step 0.3) must not merge while a path-mandated change is unverified or its `:dev` verify is red — that's the gate that keeps unverified code off `:latest`.

#### Step 4.5 — Batched `:dev` box verify (end of invocation, before scheduling the next firing)

If any path-mandated change merged this invocation:

1. **Flip:** `sb-tui channel dev` (or `POST /api/system/channel`). Because `:dev` always tracks latest `main`, **one flip covers every path-mandated change merged this run** — and a #1434 cluster is already one merged PR, so a cluster is one verify by construction (the #1433 × #1434 win: N per-issue flips collapse to one).
2. **Wait (bounded):** wait for the `:dev` image built from the newest merged SHA to publish and the box to pull + restart onto it — poll the box's running image/version, **timeout ≤15 min** (release.yml build + pull). If it never lands, treat as a verify failure (step 5, reason "dev image didn't land").
3. **Verify:** run `/verify` against `<SERVICEBAY_BOX>` (memory `reference_mcp_servicebay_access`), exercising the merged path-mandated changes.
4. **Always flip back:** `sb-tui channel latest` — on success, failure, *and* timeout. The box must never be left on `:dev` (bounded + reverts even on failure, per #1433 acceptance). The flip-back is mandatory cleanup; if it itself fails, that's a **hard exit** — alert the user, don't leave the box stranded.
5. **On verify red:** the change is already on `main`. Identify the culprit (a cluster keeps it attributable to one theme; an unrelated dev-box batch needs a bisect), open a **revert PR**, merge it on CI-green, and re-run this batched verify. **Block the release:** set `state.box_verify = {sha, status: "red", detail, since}` so preflight Step 0.3 holds the release PR until it's green.
6. **On verify green:** set `state.box_verify = {sha, status: "green", verified_at}`. The release PR is clear to merge next preflight.

If a path-mandated change can't be `:dev`-verified this invocation (box unreachable, etc.), do **not** silently fall back to deferral: set `state.box_verify.status: "owed"` so the release stays blocked, and flag it.

_(Optional, dev-box only) integration-image staging:_ instead of merge-then-verify, stage several green-CI branches into one integration `:dev` build, one verify pass, then merge only the passers (accepting "red → bisect"). Use only when explicitly chosen; the default above keeps `:latest` clean via the release gate.

If lint warnings increased, fix or rebase. If a test fails, diagnose root cause — **do not** mock around it or skip it. Memory `feedback_vitest_fetch_response_reuse` and `feedback_test_local_node_match_ci` apply.

## Step 4 — Open the PR

### Commit
- Conventional Commits format. Scope mirrors the path (`fix(portal):`, `refactor(dashboards):`, `feat(backend):`, `docs(install):`, `test(shellQuote):`).
- **No parens in the subject line beyond the conventional `(scope)`**. Memory `feedback_release_please_commit_parens`: parens-heavy subjects break release-please.
- Body: brief summary, then `Closes #<N>` on its own line. **For a cluster, one `Closes #<N>` line per member issue** (each on its own line) so merging the single PR closes them all.

### Push
```bash
git push -u origin fix/issue-<N>-<slug>
```

### PR body (no `--fill` — write a real body)
```markdown
## What
<1-2 sentences>

## Why
Closes #<N>.

## Risk
<low | medium | high — one sentence on what could go wrong>

## Rollback
<git revert is enough | requires X | not trivially reversible>

## Verification
- [ ] npm run lint
- [ ] npm run check:arch
- [ ] npm test
- [ ] /verify on FCoS box (if path-mandated — see Step 3)
```

### PR creation — branches by gate

**Security-gate issues (`security` label):**
```bash
gh pr create --draft --title "<conventional commit subject>" --body "$(cat <<'EOF'
...body above...
EOF
)"
gh issue edit <N> --add-label autoloop-open
```
Update state: add issue to `skipped[]` with reason `"security gate; draft PR #<PR#> awaiting human review"`. Move to next issue. **Do not merge.**

**Normal-flow issues (everything else):**
```bash
gh pr create --title "<conventional commit subject>" --body "$(cat <<'EOF'
...body above...
EOF
)"
```
Proceed to merge gate below.

### Merge gate (normal-flow only)
`main` is **not** branch-protected on this repo (verified via `gh api repos/mdopp/servicebay/branches/main/protection` → 404), so `--auto` silently no-ops. Use the manual gate:

1. Wait for CI: `gh pr checks <PR#> --watch`.
2. If CI green: `gh pr merge <PR#> --merge --delete-branch`. **Path-mandated changes merge here too** — the box `/verify` is now post-merge on `:dev` (Step 4.5), not a pre-merge blocker (#1433). If the diff touched a Step 3 path, record that the invocation owes a box verify: `state.box_verify = {status: "owed", sha: "<merge SHA>"}`.
3. If CI red twice on the same SHA: stop, post a comment with the failing job link, leave the PR open, move to the next issue. **Do not retry indefinitely.**

Update state file: move the issue — or, for a cluster, every member issue — from `in_progress` to `completed`, and mark the cluster `done` in `clusters[]`.

### Post-merge
```bash
git checkout main && git pull --ff-only
```

Check release-please ran:
```bash
gh pr list --head release-please--branches--main--components--servicebay --state open
```
If a release PR appeared, leave it for the **next invocation's preflight** to merge (Step 0.3) — don't merge it mid-iteration; let CI on it run while you continue with the next issue. If no release PR appeared after ~2 minutes and the commit was a `feat/fix`, log it in state file under `release_warnings[]` for the user to investigate (memory: parens in commit body can silently break the workflow).

## Step 5 — End of invocation

After 8 PRs (any mix of merged + security-gate drafts) — stop.

**Before stopping, run Step 4.5** (batched `:dev` box verify) if any path-mandated change merged this invocation and `state.box_verify.status` isn't already `"green"` for the current `main` SHA — flip once, verify, flip back. Then write a summary to stdout for the user:
```
Autoloop iteration complete.
  Merged: #1094 (PR #1110), #1096 (PR #1111)
  Security-gate drafts: #1097 (PR #1112)
  Skipped this round: —
  Blocked: —
Next eligible issue: #1093.
```

## Hard exit conditions (stop the loop entirely)

Tell the user and **do not schedule another /loop firing** if any of these hit:

1. CI has been red on the same PR twice without code changes in between.
2. Release-please PR's own CI is red and the loop's auto-merge in Step 0.3 has failed twice in a row (a real regression is hiding under the version bump — get human eyes on it).
3. `.claude/state/autoloop-state.json` shows >3 security-gate draft PRs accumulated without human review (review backlog, not a code problem).
4. Working tree was dirty at preflight on two consecutive invocations (another session is active here).
5. `/verify` has failed against the FCoS box twice on the same PR without code changes in between.
6. **Both** the issue queue (after Step 1 exclusion) **and** the in-scope lint warning set (after Step 1b filtering) are empty. The loop has nothing mechanical left to do.

## Things this skill explicitly does NOT do

- Does not run `gh pr merge --auto` (won't work without branch protection).
- Does not write `--fill`-only PR bodies.
- Does not refactor beyond the ticket scope (refactor-ticket exception in Step 2 applies only within the named file/module).
- Does not bump versions or write to `package.json`/`CHANGELOG.md`/`.release-please-manifest.json` — release-please owns those (memory: *"NEVER manually bump versions"*).
- Does not edit the release-please PR's contents (it's machine-generated). It *does* merge that PR in preflight Step 0.3 once CI is green — leaving it open blocks the loop and stalls releases.
- Does not auto-merge any issue carrying the `security` label (opens as draft) or filter-in any `postponed` issue (still excluded). `oscar`-labelled issues are no longer excluded — they run through normal flow (triage-to-`mdopp/oscar` first per Step 1's classification note), subject to the same scope/`/verify`/blocked gates.
- Does not ship a path-mandated change to `:latest` without a `:dev` box `/verify` — verification is post-merge on the `:dev` channel and gates the release PR, never deferred (#1433). Always flips the box back to `:latest`, even on verify failure.
- Does not file new issues to track follow-ups; comments on the existing issue instead.
- Does not cluster unrelated issues onto one branch by default — clusters are region-coherent so a red CI stays attributable; the unrelated-batch escape hatch is dev-box + explicit "red -> bisect" only.
- Does not post a comment without the AI marker (memory `feedback_ai_comment_marker`), and does not reply to external human commenters — it parks those tickets on `state.awaiting_user[]` for `/comment-responder` + human confirm.
- Does not exceed the lint-sweep size guard (≤2 source files, ≤120 LOC net diff). Structural warnings are fair game when a *bite-sized* extraction clears them; the loop never attempts a 2000-LOC dashboard decomposition in one PR — that's still the user's job.
- Does not touch a file that an open non-loop PR or a non-blocked open issue is already working — collision avoidance check runs before every lint-sweep file selection.

## Reference

- Memory index: `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md`
- UX contract: `docs/UX_PHILOSOPHY.md` and `docs/UX_DECISIONS.md`
- Architecture invariants: `docs/ARCHITECTURE_INVARIANTS.md`
- Real-box access: memory `reference_mcp_servicebay_access`. `<SERVICEBAY_BOX>` (used above) is the box's SSH/HTTP/MCP address; it lives in that local memory entry, not in this public repo.
- Release flow: release-please PR on branch `release-please--branches--main--components--servicebay`
- Channel switch (`:dev`/`:latest`) for the batched box verify: `tools/sb-tui/internal/rest/channel.go`, `tools/sb-tui/internal/ui/channel.go`, `packages/backend/src/lib/servicebayChannel.ts`; `release.yml` publishes `ghcr.io/mdopp/servicebay:dev` per non-release `main` commit.
