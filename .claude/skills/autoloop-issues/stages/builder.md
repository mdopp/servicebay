# Stage: Builder

You are the **Builder** sub-agent. You run in fresh context, **claim** one unit (or seal the batch), and return one line. You own implement → fast-gate → commit → (at the batch boundary) seal → push → CI → merge.

Read first: the orchestrator's shared rules in `.claude/skills/autoloop-issues/SKILL.md` (batch economy, AI marker, box-is-a-dev-target, **§ Broker verbs**). The orchestrator's context line tells you **mode** (`build` or `seal`), and for `build` the **unit id** and **gate**.

**You touch state ONLY through the broker:** `npm run autoloop:queue -- <verb>` (= `tsx scripts/autoloop-queue.ts`). Never create, read, or write `.claude/state/work-queue.json` — it is retired (#2639) — and never hand-edit the cache JSON.

## The gate split — this is the point of the rewrite

| | When | What runs |
|---|---|---|
| **Fast gate** | after **every** unit (per-issue) | `npm run lint` · `npm run typecheck` · `npm run check:arch` · `npx vitest run --changed` |
| **Full gate** | once, at the **batch seal** | `npm run lint` · `npm run typecheck` · `npm run check:arch` · **`npm test`** (full suite) → push → CI |

Rationale: `check:arch` (global, fast) catches import/structure breakage per issue; `vitest --changed` runs every test that imports the changed module *transitively*, which covers the common cross-module regression cheaply. The full ~844-case suite is the safety net at the seal — and since you accumulate on one branch in one session, a red full-run is a cheap in-context bisect, not a cold one. **Do not run the full `npm test` per issue.**

`npm run typecheck` (= `tsc --noEmit`, the **exact** command CI's `typecheck` job runs, over all workspaces via the root `tsconfig.json`) is in **both** gates because `vitest` does **not** type-check — a type error (read-only `NODE_ENV`, `vi.fn` generic arity, wrong import source) passes `--changed` and the full suite, then only fails after push in CI's dedicated typecheck job (#2172). Running it per-unit catches the type error locally, before push, on every unit.

---

## Mode: `build` — implement one unit onto the batch branch

### 1. Claim the unit, then get on the batch branch

**Claim FIRST — before you touch a file.** The claim is what stops a second loop instance building the same issue:
```bash
npm run autoloop:queue -- claim <unit id>     # exit 0 = yours; exit 3 = NOT yours
```
**Exit 3 means you do not hold it — do NOT build.** It prints why: `held by another loop instance` (a rival won the ref) or `the claim could not be taken` (it could not be proven — fail closed). Return `Builder: unit <id> not claimed (<the reason>), nothing built.` The claim is an atomic `refs/autoloop/claim/<issue>` create (SKILL.md § state), so this is a real lock, not a hint; `autoloop:building` on the issue is its visible projection. If you bounce or abandon the unit, give the claim back with `npm run autoloop:queue -- unclaim <unit id>`.

Then the branch:
- `npm run autoloop:queue -- summary` — if `batch` is null: `git checkout main && git pull --ff-only && git checkout -b batch/$(date +%Y-%m-%d)<letter>`, then `npm run autoloop:queue -- batch new --branch <that branch>`.
- Else: `git checkout <batch.branch>` (it persists across firings). **If the branch is behind `main`, `git rebase origin/main` immediately** — otherwise an out-of-date batch (e.g. one created before a skill change) leaves the on-disk `stages/` playbooks stale or missing for the next stage dispatch. The rebase is conflict-free when the batch's filesets are disjoint from what moved on `main`.

### 2. Read the unit
`npm run autoloop:queue -- next` gives you the unit body (id, issues, scope, acceptance, gate) — that is the whole slice you need; never load a state file to find it.
- For a **cluster**: read *every* member issue + its `Relevant Files`, then implement all members as one coherent themed change. Organize the diff by theme, not by issue.
- For a single **issue**: read the body, the `Relevant Files`, and ~50 lines around any line reference.
- For a **lint-sweep** unit: see §Lint-sweep below.
- If the body turns out **ambiguous** (the planner missed it): do **not** guess. Revert any partial work, then `npm run autoloop:queue -- park <N> refinement --comment "<the specific question><AI marker>"` — one call labels it `autoloop:needs-refinement`, posts the question, releases your claim and drops the unit from rotation. Return. Refinement is the human's job.

### 3. Implement — scope discipline
- Smallest change that satisfies the unit's `acceptance`. **No** drive-by refactors, **no** new abstractions, **no** "improve while I'm here." CLAUDE.md: *"Three similar lines is better than a premature abstraction."*
- `[Refactor]`-titled units: stay within the file/module named; a neighbouring file needs its own PR, not a drive-by.
- **Invariant ratchet** (`docs/ARCHITECTURE_INVARIANTS.md`): when you resolve an exemption, *tighten* `scripts/check-invariants.ts` / `.dependency-cruiser.cjs`. Never loosen.
- **Cutting a god module into a directory:** update the depcruise rule to a directory-prefix rule and `git grep` the tests for any path/marker string that just moved, *before* the fast gate — both break silently otherwise (assist `autoloop-issue-pipeline`, "Mechanics that are easy to get wrong").

### 3a. Acceptance-criteria self-verify — built ≠ done (memory `feedback_acceptance_criteria_must_gate_close`)
When the unit carries **explicit acceptance criteria** — a spec §N checklist (e.g. `docs/ux/settings-ia-redesign.md` §10) or an issue **acceptance section** — "built" is not the report. Before you set the unit `built`, **verify EACH criterion against the actual code/browser** and report **per-criterion status** (✓ met / ✗ unmet / ? owed-to-box). CI proves "compiles + the written tests pass," **not** "the documented criteria are met" — a partial build passes CI cleanly when the unbuilt criteria have no test encoding them (this is exactly how #2030's 4-noun nav was closed "done" while the nav still rendered 8 items).
- **Encode each criterion you can.** A criterion that's testable in unit/integration scope gets a test that asserts it (so the next run can't silently regress it). Don't close the criterion on a manual eyeball if it can be a test.
- **User-facing / frontend / visual units** (`gate=verify`): do a real **browser/DOM** check against the criteria — render the page and assert the spec'd DOM/nav/redirect. **Headless Chromium works in this sandbox** (#2445) — provision it once with:
  ```bash
  npm run browser:sandbox      # idempotent; exit 0 = a real page load rendered visible text
  ```
  It apt-extracts the missing shared libs + `fonts-dejavu-core` into `~/.cache/servicebay-browser-sandbox` with **no root and no sudo**, then probes a live page load. `tests/e2e/playwright.config.ts` picks the sysroot up automatically; a script of your own gets it from `applyBrowserSandboxEnv()` in `scripts/provision-browser-sandbox.ts`. **Fonts are not optional**: without them Chromium lays the page out but every text node measures **zero height**, so Playwright reports every element `hidden` — a fake "CSS bug" that eats an hour. Also: `locator.fill('')` does **not** clear a React controlled input (use `press('Control+a')` + `press('Backspace')`), so a spec that clears a field that way silently asserts nothing.
  Deferring the visual criterion to box-verify is now the **exception, not the default** — reserve it for what genuinely needs the real box (live box data, the installed service, the proxy/SSO path). If `npm run browser:sandbox` exits non-zero, say so explicitly in the `built` notes, fall back to inspecting the **served markup / built bundle**, and flag the visual criterion as owed — but do not skip straight to the fallback.
- **If any criterion is unmet,** the unit is **not** built. Either finish it (preferred — smallest change to satisfy the remaining criteria, staying in scope) or, if a criterion needs a human decision, bounce it with `park <N> refinement` (§2) — never report `built` with an unmet criterion buried.
- In your `built` notes and return line, **enumerate the criteria**: which are confirmed-met (and how — test name / DOM assertion), and which are owed to box-verify/operator. A bare "built" on a criteria-bearing unit is a process miss.

### 4. Fast gate (per unit)
```bash
npm run lint            # 0 errors; warnings only if count didn't increase
npm run typecheck       # tsc --noEmit — SAME as CI's typecheck job; vitest doesn't type-check (#2172)
npm run check:arch      # invariants + depcruise — must pass
npx vitest run --changed   # tests transitively affected by this unit's changes
```
`--changed` reads the uncommitted working tree, so run it **before** committing. A real failure → fix the root cause; **never** mock around it or skip it (memory `feedback_vitest_fetch_response_reuse`, `feedback_test_local_node_match_ci`). Lint count up → fix before committing. **Read the vitest tally line, not just the command's exit code** — a compound `&&` gate can exit `0` while the tally underneath reads a failure (assist `autoloop-issue-pipeline`). This matters even more at the seal's full-suite run (below).

### 5. Commit to the batch branch (no push)
- Conventional Commits; scope mirrors the path (`fix(portal):`, `refactor(dashboards):`, …).
- **No parens beyond the conventional `(scope)`** — parens-heavy subjects break release-please (memory `feedback_release_please_commit_parens`).
- Body ends with `Closes #<N>` — **one line per member issue** for a cluster.
- **No push, no PR, no CI.** Then record it: `npm run autoloop:queue -- built <unit id>` (it appends the unit to the batch and recomputes `count` in **issues**, so a cluster counts as its members). Keep the claim — the unit stays claimed until the batch ships. Return.

### `security: true` unit — full loop, flagged for post-deploy review
A security/sensitive unit rides the batch **like any other unit** — implement it onto the batch branch, fast gate, commit with `Closes #<N>`, no draft, no separate branch. The only difference: it is **flagged** so the human reviews it after it deploys. At **seal**, run `npm run autoloop:queue -- park <N> review --comment "shipped in #<pr>, post-deploy eyeball<AI marker>"` for each shipped `security:true` unit. `autoloop:review` is informational — it never blocks the merge or the release.

### Lint-sweep unit
Implement the one file/rule named in the unit. Size guard: **≤2 source files** (+ their `*.test.*`), **≤120 LOC net** (subtractive can be larger), one warning class or one file. If even a bite-size extraction won't fit, `npm run autoloop:queue -- note "lint-sweep <file>: size guard exceeded, needs a decomposition ticket"` and return (a lint-sweep unit has no issue to label). Lint-sweep commits ride the batch branch like any other unit (no `Closes #`).

### Dep-update unit (`kind:"dep-updates"`)
**Does NOT ride the batch branch** — Dependabot PRs are independent, already-CI'd PRs. Don't touch `batch`; process them directly, then mark the unit done. For each open `gh pr list --author app/dependabot --state open --json number,title,headRefName,mergeStateStatus`:
- **Merge** (`gh pr merge <N> --merge --delete-branch`) when CI is green (`mergeStateStatus == CLEAN`) **and** it's a **dev-dependency** (`deps-dev`) or a **CI/github-actions** bump — low blast radius; green CI = lint/build/test pass.
- **HOLD** (don't merge) + `npm run autoloop:queue -- park <N> refinement --comment "<one line><AI marker>"` for: (a) `googleapis/release-please-action` or anything that changes the release pipeline this repo depends on, (b) a **runtime** (non-dev) dependency major bump, (c) red/`UNSTABLE`/`DIRTY` CI.
- These merges land on `main` and trigger release-please on their own (dev-dep/action bumps aren't path-mandated → nothing owed). `npm run autoloop:queue -- built dep-update-sweep` (nothing to seal) + a `note` carrying the merged/held numbers. Return one line: merged #s + held #s. Idempotent — next run handles whatever's still open.

---

## Mode: `seal` — ship the accumulated batch (once)

Precondition (re-assert), from `npm run autoloop:queue -- summary`: (`batch.count >= 8` **or** `next` returns `null`) **and** the verify status clear (`green`/`null`). Mid-batch → return "not ready to seal". Verify owed/verifying/red → return "blocked on box-verify, not sealing" (seal-ahead forbidden).

1. **Local safety net.** `git checkout <batch.branch> && git rebase origin/main`, then `npm run lint && npm run typecheck && npm run check:arch && npm test`. A full-suite failure the per-unit `--changed` runs missed → bisect the culprit commit (atomic, `Closes #N`), fix on the branch, re-run.

2. **Seal — run the script, don't hand-roll the mechanics** (why: `CLAUDE.md` "deterministic → scripts"; the invariants — `--no-verify` push, hard-capped CI poll that returns, merge-on-green — live in `scripts/autoloop-seal.ts`, not here):
   ```bash
   npm run autoloop:seal -- <batch.branch> --title "<conventional subject>" --body-file /tmp/seal-body.md
   ```
   It emits `AUTOLOOP_SEAL_RESULT {json}`. **Exit 0** → fold the JSON (step 3). **Exit 3** = CI red → *your judgment*: a first fixable gate (e.g. diff-coverage) → fix forward on the branch (real tests, don't ratchet) + re-run; red twice same-SHA no-change → post the failing-job link (AI marker), leave the PR open, return (hard-exit #1). **Exit 2** = setup error (dirty tree / bad branch / conflict) → fix + re-run. (`--body-file` is a normal PR body: `## What` / `Closes #a` per issue / `## Risk·Rollback`.)

3. **Fold the result.** First `npm run autoloop:classify -- <sha>^..<sha>`: a `"path":"none"` verdict means nothing box-observable shipped (playbooks/docs/scripts/tests, release-please noise, a `package.json` `scripts`/`devDependencies` entry) — leave the verify state clear, dispatch no Box-Verify even for a `gate:verify` unit, and `note` it (#2829). Otherwise `npm run autoloop:queue -- verify-set <sha> owed --detail "<path-mandated paths>" --pr <release PR>` when the JSON's `boxVerifyOwed` is true **OR** any sealed unit's `gate` was `verify` (a user-facing unit is `gate:verify` even if its files aren't path-mandated). `park <N> review --comment …` for every `security:true` unit, then `npm run autoloop:queue -- batch reset` — that releases the shipped units' claims and clears the batch; the durable record is the merged PR + the closed issues. (The release PR is merged later by orchestrator preflight, after box-verify is green.) The gate is canonical in the script, on **two axes** (#2700): `PATH_MANDATED_PATHS` (the *place* a change lives) and `durableStateEffects` (the *effect* it has — template schema migrations, saved-secrets writes, installed-manifest writes owe a box-verify from any directory). Edit them there, not here.

## Return
- build: `Builder: built fe-layout (#1420,#1424) onto batch/2026-06-01a, fast gate green, count 4/8.`
- seal: `Builder: sealed batch/2026-06-01a → PR #1467 merged (closes #1420 #1424 #1430); verify=owed (install path).`

## Never
- Never run the full `npm test` per unit (that's the seal's job) — fast gate only mid-batch.
- Never push / open a PR / trigger CI / merge while mid-batch (`count<8` and planned units remain).
- Never guess past an ambiguous issue — `park <N> refinement` with a precise question.
- Never build a unit whose `claim` exited 3 — another loop instance owns it.
- Never create, read or write `.claude/state/work-queue.json` (retired, #2639), and never hand-edit the broker cache.
- Never bump versions or edit `CHANGELOG.md`/`package.json`/the release manifest.
- Never reply to external commenters; never post a comment without the AI marker.
