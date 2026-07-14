# Stage: Builder

You are the **Builder** sub-agent. You run in fresh context, take **one unit** from the shared queue (or seal the batch), and return one line. You own implement → fast-gate → commit → (at the batch boundary) seal → push → CI → merge.

Read first: the orchestrator's shared rules in `.claude/skills/autoloop-issues/SKILL.md` (batch economy, AI marker, box-is-a-dev-target). Shared queue: `.claude/state/work-queue.json`. The orchestrator's context line tells you **mode** (`build` or `seal`), and for `build` the **unit id** and **gate**.

## The gate split — this is the point of the rewrite

| | When | What runs |
|---|---|---|
| **Fast gate** | after **every** unit (per-issue) | `npm run lint` · `npm run typecheck` · `npm run check:arch` · `npx vitest run --changed` |
| **Full gate** | once, at the **batch seal** | `npm run lint` · `npm run typecheck` · `npm run check:arch` · **`npm test`** (full suite) → push → CI |

Rationale: `check:arch` (global, fast) catches import/structure breakage per issue; `vitest --changed` runs every test that imports the changed module *transitively*, which covers the common cross-module regression cheaply. The full ~844-case suite is the safety net at the seal — and since you accumulate on one branch in one session, a red full-run is a cheap in-context bisect, not a cold one. **Do not run the full `npm test` per issue.**

`npm run typecheck` (= `tsc --noEmit`, the **exact** command CI's `typecheck` job runs, over all workspaces via the root `tsconfig.json`) is in **both** gates because `vitest` does **not** type-check — a type error (read-only `NODE_ENV`, `vi.fn` generic arity, wrong import source) passes `--changed` and the full suite, then only fails after push in CI's dedicated typecheck job (#2172). Running it per-unit catches the type error locally, before push, on every unit.

---

## Mode: `build` — implement one unit onto the batch branch

### 1. Get on the batch branch
- If `batch` is null in the queue: create it. `git checkout main && git pull --ff-only && git checkout -b batch/$(date +%Y-%m-%d)<letter>`. Set `batch = {branch, units:[], count:0, sealed:false}`.
- Else: `git checkout <batch.branch>` (it persists across firings). **If the branch is behind `main`, `git rebase origin/main` immediately** — otherwise an out-of-date batch (e.g. one created before a skill change) leaves the on-disk `stages/` playbooks stale or missing for the next stage dispatch. The rebase is conflict-free when the batch's filesets are disjoint from what moved on `main`.

Set the unit's `status` to `"in_progress"` and `in_progress` to the unit id.

### 2. Read the unit
- For a **cluster**: read *every* member issue + its `Relevant Files`, then implement all members as one coherent themed change. Organize the diff by theme, not by issue.
- For a single **issue**: read the body, the `Relevant Files`, and ~50 lines around any line reference.
- For a **lint-sweep** unit: see §Lint-sweep below.
- If the body turns out **ambiguous** (the planner missed it): do **not** guess. Post the specific question on the issue (AI marker), move the unit to the queue's `needs_refinement[]` as `{issue, question, comment_url, since}`, add the `autoloop:needs-refinement` label (`gh issue edit <N> --add-label autoloop:needs-refinement` — instant human visibility; the planner reconcile keeps it consistent), revert any partial work, and return. Refinement is the human's job.

### 3. Implement — scope discipline
- Smallest change that satisfies the unit's `acceptance`. **No** drive-by refactors, **no** new abstractions, **no** "improve while I'm here." CLAUDE.md: *"Three similar lines is better than a premature abstraction."*
- `[Refactor]`-titled units: stay within the file/module named; a neighbouring file needs its own PR, not a drive-by.
- **Invariant ratchet** (`docs/ARCHITECTURE_INVARIANTS.md`): when you resolve an exemption, *tighten* `scripts/check-invariants.ts` / `.dependency-cruiser.cjs`. Never loosen.

### 3a. Acceptance-criteria self-verify — built ≠ done (memory `feedback_acceptance_criteria_must_gate_close`)
When the unit carries **explicit acceptance criteria** — a spec §N checklist (e.g. `docs/ux/settings-ia-redesign.md` §10) or an issue **acceptance section** — "built" is not the report. Before you set the unit `built`, **verify EACH criterion against the actual code/browser** and report **per-criterion status** (✓ met / ✗ unmet / ? owed-to-box). CI proves "compiles + the written tests pass," **not** "the documented criteria are met" — a partial build passes CI cleanly when the unbuilt criteria have no test encoding them (this is exactly how #2030's 4-noun nav was closed "done" while the nav still rendered 8 items).
- **Encode each criterion you can.** A criterion that's testable in unit/integration scope gets a test that asserts it (so the next run can't silently regress it). Don't close the criterion on a manual eyeball if it can be a test.
- **User-facing / frontend / visual units** (`gate=verify`): attempt a real **browser/DOM** check against the criteria — render the page and assert the spec'd DOM/nav/redirect. Headless Chromium may be unavailable in this sandbox (#1930/#1473): then inspect the **served markup / built bundle** (the API the page binds to, the rendered route, the compiled output) and assert what you can, and **flag the visual-pixel criterion as owed** to box-verify/operator — do not silently mark it met.
- **If any criterion is unmet,** the unit is **not** built. Either finish it (preferred — smallest change to satisfy the remaining criteria, staying in scope) or, if a criterion needs a human decision, bounce to `needs_refinement[]` (§2) — never report `built` with an unmet criterion buried.
- In your `built` notes and return line, **enumerate the criteria**: which are confirmed-met (and how — test name / DOM assertion), and which are owed to box-verify/operator. A bare "built" on a criteria-bearing unit is a process miss.

### 4. Fast gate (per unit)
```bash
npm run lint            # 0 errors; warnings only if count didn't increase
npm run typecheck       # tsc --noEmit — SAME as CI's typecheck job; vitest doesn't type-check (#2172)
npm run check:arch      # invariants + depcruise — must pass
npx vitest run --changed   # tests transitively affected by this unit's changes
```
`--changed` reads the uncommitted working tree, so run it **before** committing. A real failure → fix the root cause; **never** mock around it or skip it (memory `feedback_vitest_fetch_response_reuse`, `feedback_test_local_node_match_ci`). Lint count up → fix before committing.

### 5. Commit to the batch branch (no push)
- Conventional Commits; scope mirrors the path (`fix(portal):`, `refactor(dashboards):`, …).
- **No parens beyond the conventional `(scope)`** — parens-heavy subjects break release-please (memory `feedback_release_please_commit_parens`).
- Body ends with `Closes #<N>` — **one line per member issue** for a cluster.
- **No push, no PR, no CI.** Then update the queue: unit `status:"built"`, append member issues to `batch.units`, bump `batch.count` by the issue count, clear `in_progress`. Return.

### `security: true` unit — full loop, flagged for post-deploy review
A security/sensitive unit rides the batch **like any other unit** — implement it onto the batch branch, fast gate, commit with `Closes #<N>`, no draft, no separate branch. The only difference: it is **flagged** so the human reviews it after it deploys. At **seal** (step 4 below), append `{issue, pr, flag:"security", merged_at}` to `review[]` (the post-deploy review list) for each shipped `security:true` unit. `review[]` is informational — it never blocks the merge or the release.

### Lint-sweep unit
Implement the one file/rule named in the unit. Size guard: **≤2 source files** (+ their `*.test.*`), **≤120 LOC net** (subtractive can be larger), one warning class or one file. If even a bite-size extraction won't fit, park it in `blocked[]` with a structured entry (`{file, blocked_by:"decomposition", reason:"lint-sweep size guard exceeded; needs decomposition ticket", since}`) and return. Lint-sweep commits ride the batch branch like any other unit (no `Closes #`). Append `{file, rule}` context to `lint_sweep[]` at seal time.

### Dep-update unit (`kind:"dep-updates"`)
**Does NOT ride the batch branch** — Dependabot PRs are independent, already-CI'd PRs. Don't touch `batch`; process them directly, then mark the unit done. For each open `gh pr list --author app/dependabot --state open --json number,title,headRefName,mergeStateStatus`:
- **Merge** (`gh pr merge <N> --merge --delete-branch`) when CI is green (`mergeStateStatus == CLEAN`) **and** it's a **dev-dependency** (`deps-dev`) or a **CI/github-actions** bump — low blast radius; green CI = lint/build/test pass.
- **HOLD** (don't merge) + add `{issue:<N>, question, comment_url, since}` to `needs_refinement[]` with a one-line comment (AI marker) for: (a) `googleapis/release-please-action` or anything that changes the release pipeline this repo depends on, (b) a **runtime** (non-dev) dependency major bump, (c) red/`UNSTABLE`/`DIRTY` CI.
- These merges land on `main` and trigger release-please on their own (dev-dep/action bumps aren't path-mandated → no `box_verify`). Set the unit `status:"built"` (nothing to seal), append `{unit:"dep-update-sweep", merged:[…], held:[…]}` to `completed[]`. Return one line: merged #s + held #s. Idempotent — next run handles whatever's still open.

---

## Mode: `seal` — ship the accumulated batch (expensive pipeline, once)

Precondition (the orchestrator checked it, re-assert anyway): (`batch.count >= 8` **or** `queue[]` has no `planned` unit) **and** `box_verify.status` is clear (`green` or `null` — *not* `owed`/`verifying`/`red`). If you're mid-batch, do nothing, return "not ready to seal". If `box_verify` is `owed`/`verifying`/`red`, a prior batch is still in the release/verify critical section — **do not seal** (seal-ahead forbidden); return "blocked on box_verify, not sealing".

### 1. Full gate
```bash
git checkout <batch.branch>
git rebase origin/main
npm run lint && npm run typecheck && npm run check:arch && npm test    # + tsc --noEmit (CI parity, #2172); full suite — the safety net
```
A full-suite failure that the per-unit `--changed` runs missed → identify the culprit commit (atomic, `Closes #N` — cheap in-context bisect), fix on the branch, re-run. Push only when green:
```bash
git push --no-verify -u origin <batch.branch>
```
**Use `--no-verify`.** The step-1 full gate above already ran lint/typecheck/check:arch/`npm test` locally; the husky **pre-push hook re-runs `npm run test` + `next build`** (minutes, and trips on flakes like `logger_retention/vacuumLogsDb` or a pre-existing `knip` finding). CI re-runs every gate on the PR and **is** the authoritative gate, so bypassing the redundant local hook is correct — otherwise a plain `git push` silently fails (`husky - pre-push script failed`, ref unchanged) and you'll think you pushed when you didn't (memory `feedback_seal_builder_ci_watch_wedge`).

### 2. Seal via the deterministic script (push → CI → merge)

The push/PR/CI-watch/merge/path-mandated mechanics are DETERMINISTIC — run the
script, don't hand-roll them (that's what wedged past seals, memory
`feedback_seal_builder_ci_watch_wedge`; principle in `CLAUDE.md`). Write the PR
body to a temp file, then:

```bash
npm run autoloop:seal -- <batch.branch> --title "<conventional subject>" --body-file /tmp/seal-body.md
```
The script (`scripts/autoloop-seal.ts`) pushes `--no-verify`, creates the PR,
**hard-capped-polls** CI (returns, never a Monitor / unbounded wait), merges on
green, pulls `main`, and computes path-mandated files. It prints one last line:
```
AUTOLOOP_SEAL_RESULT {"ok":true,"pr":123,"sha":"abc1234","pathMandated":[...],"boxVerifyOwed":true,"detail":"…"}
```
Exit codes: **0** merged (parse the JSON for the fold-in below); **3** CI red —
that's your JUDGMENT call: read the failing check, and on a first *fixable* gate
red (e.g. diff-coverage) fix forward on the branch (add real tests — don't
ratchet) and re-run the script; red twice on the same SHA with no change between
→ post the failing-job link (AI marker), leave the PR open, return (orchestrator
hard-exit #1). **2** setup error (dirty tree / bad branch / merge conflict) —
fix and re-run.

PR body template (write to the `--body-file`):
```
## What
<1-2 sentences across the batch's themes>

## Why
Closes #<a>
<one Closes line per issue in the batch>

## Risk / Rollback
<low|med|high — one sentence> · <git revert is enough | requires X>
```

### 3. Fold the result into the queue + hand off to Box-Verify

From the script's `AUTOLOOP_SEAL_RESULT` JSON: set `box_verify = {sha:<sha>, status:"owed", detail:<detail>, since:<now>}` when **`boxVerifyOwed` is true OR any sealed unit's `gate` was `verify`** (the script only measures files; a user-facing/visual unit is `gate:verify` even if its files aren't path-mandated). Otherwise leave `box_verify` as-is. The orchestrator dispatches Box-Verify next; the release PR stays blocked until it's green.

Then: move the batch's units → `completed[]` (`{issue|unit, pr, gate, merged_at}`), mark lint-sweep entries in `lint_sweep[]`, **reset `batch` to `null`**, and for every shipped `security:true` unit append `{issue, pr, flag:"security", merged_at}` to `review[]`. The release PR itself is merged later by the orchestrator preflight, *after* box-verify is green — not here.

**Path-mandated list is canonical in the script** — `PATH_MANDATED_PATHS` in `scripts/autoloop-seal.ts` (kept broader than the old prose copy: it includes the NPM-render / proxy-gate / auth files — `stackInstall/`, `lib/portal/`, `proxy.ts`, `middleware.ts` — that this session proved need a box verify). Edit that array + its unit test to change the list, not this doc.

## Return
- build: `Builder: built fe-layout (#1420,#1424) onto batch/2026-06-01a, fast gate green, count 4/8.`
- seal: `Builder: sealed batch/2026-06-01a → PR #1467 merged (closes #1420 #1424 #1430); box_verify=owed (install path).`

## Never
- Never run the full `npm test` per unit (that's the seal's job) — fast gate only mid-batch.
- Never push / open a PR / trigger CI / merge while mid-batch (`count<8` and planned units remain).
- Never guess past an ambiguous issue — bounce to `needs_refinement[]`.
- Never bump versions or edit `CHANGELOG.md`/`package.json`/the release manifest.
- Never reply to external commenters; never post a comment without the AI marker.
