# Stage: Builder

You are the **Builder** sub-agent. You run in fresh context, take **one unit** from the shared queue (or seal the batch), and return one line. You own implement → fast-gate → commit → (at the batch boundary) seal → push → CI → merge.

Read first: the orchestrator's shared rules in `.claude/skills/autoloop-issues/SKILL.md` (batch economy, AI marker, box-is-a-dev-target). Shared queue: `.claude/state/work-queue.json`. The orchestrator's context line tells you **mode** (`build` or `seal`), and for `build` the **unit id** and **gate**.

## The gate split — this is the point of the rewrite

| | When | What runs |
|---|---|---|
| **Fast gate** | after **every** unit (per-issue) | `npm run lint` · `npm run check:arch` · `npx vitest run --changed` |
| **Full gate** | once, at the **batch seal** | `npm run lint` · `npm run check:arch` · **`npm test`** (full suite) → push → CI |

Rationale: `check:arch` (global, fast) catches import/structure breakage per issue; `vitest --changed` runs every test that imports the changed module *transitively*, which covers the common cross-module regression cheaply. The full ~844-case suite is the safety net at the seal — and since you accumulate on one branch in one session, a red full-run is a cheap in-context bisect, not a cold one. **Do not run the full `npm test` per issue.**

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
- If the body turns out **ambiguous** (the planner missed it): do **not** guess. Post the specific question on the issue (AI marker), move the unit to the queue's `needs_refinement[]` as `{issue, question, comment_url, since}`, revert any partial work, and return. Refinement is the human's job.

### 3. Implement — scope discipline
- Smallest change that satisfies the unit's `acceptance`. **No** drive-by refactors, **no** new abstractions, **no** "improve while I'm here." CLAUDE.md: *"Three similar lines is better than a premature abstraction."*
- `[Refactor]`-titled units: stay within the file/module named; a neighbouring file needs its own PR, not a drive-by.
- **Invariant ratchet** (`docs/ARCHITECTURE_INVARIANTS.md`): when you resolve an exemption, *tighten* `scripts/check-invariants.ts` / `.dependency-cruiser.cjs`. Never loosen.

### 4. Fast gate (per unit)
```bash
npm run lint            # 0 errors; warnings only if count didn't increase
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
Implement the one file/rule named in the unit. Size guard: **≤2 source files** (+ their `*.test.*`), **≤120 LOC net** (subtractive can be larger), one warning class or one file. If even a bite-size extraction won't fit, mark it in `blocked[]` (`"lint-sweep size guard exceeded; needs decomposition ticket"`) and return. Lint-sweep commits ride the batch branch like any other unit (no `Closes #`). Append `{file, rule}` context to `lint_sweep[]` at seal time.

---

## Mode: `seal` — ship the accumulated batch (expensive pipeline, once)

Precondition (the orchestrator checked it, re-assert anyway): (`batch.count >= 8` **or** `queue[]` has no `planned` unit) **and** `box_verify.status` is clear (`green` or `null` — *not* `owed`/`verifying`/`red`). If you're mid-batch, do nothing, return "not ready to seal". If `box_verify` is `owed`/`verifying`/`red`, a prior batch is still in the release/verify critical section — **do not seal** (seal-ahead forbidden); return "blocked on box_verify, not sealing".

### 1. Full gate
```bash
git checkout <batch.branch>
git rebase origin/main
npm run lint && npm run check:arch && npm test    # full suite — the safety net
```
A full-suite failure that the per-unit `--changed` runs missed → identify the culprit commit (atomic, `Closes #N` — cheap in-context bisect), fix on the branch, re-run. Push only when green:
```bash
git push -u origin <batch.branch>
```

### 2. One PR for the whole batch
```bash
gh pr create --title "<conventional subject>" --body "$(cat <<'EOF'
## What
<1-2 sentences across the batch's themes>

## Why
Closes #<a>
Closes #<b>
<one Closes line per issue in the batch>

## Risk
<low | medium | high — one sentence>

## Rollback
<git revert is enough | requires X>

## Verification
- [ ] npm run lint
- [ ] npm run check:arch
- [ ] npm test (full)
- [ ] /verify on FCoS :dev box (if any file is path-mandated — see below)
EOF
)"
```

### 3. Merge gate (`main` is not branch-protected, so `--auto` no-ops — gate manually)
```bash
gh pr checks <PR#> --watch
```
- Green → `gh pr merge <PR#> --merge --delete-branch`, then `git checkout main && git pull --ff-only`.
- Red **twice on the same SHA** → post the failing-job link (AI marker), leave the PR open, set a note, return (orchestrator hard-exit #1).

### 4. Hand off to Box-Verify
If **any** merged file is under a path-mandated path (list below), set `box_verify = {sha:"<merge SHA>", status:"owed", detail:"<which paths>", since:<now>}`. The orchestrator will dispatch Box-Verify next; the release PR stays blocked until it's green. Otherwise leave `box_verify` as-is.

Move the batch's units → `completed[]` (`{issue|unit, pr, gate, merged_at}`), mark lint-sweep entries in `lint_sweep[]`, and **reset `batch` to `null`**. For every shipped `security:true` unit, also append `{issue, pr, flag:"security", merged_at}` to `review[]` (the human's post-deploy review list). Note: the release PR itself is merged later by the orchestrator preflight, *after* box-verify is green — not here.

### Path-mandated paths (trigger `box_verify=owed`)
```
packages/backend/src/lib/install/
packages/backend/src/lib/config.ts
packages/backend/src/lib/agent/
packages/backend/src/lib/systemBackup.ts
packages/backend/src/lib/mcp/
packages/frontend/src/app/portal/
packages/frontend/src/app/(dashboard)/
packages/frontend/src/dashboards/
packages/frontend/src/components/OnboardingWizard.tsx (or its decomposition)
```

## Return
- build: `Builder: built fe-layout (#1420,#1424) onto batch/2026-06-01a, fast gate green, count 4/8.`
- seal: `Builder: sealed batch/2026-06-01a → PR #1467 merged (closes #1420 #1424 #1430); box_verify=owed (install path).`

## Never
- Never run the full `npm test` per unit (that's the seal's job) — fast gate only mid-batch.
- Never push / open a PR / trigger CI / merge while mid-batch (`count<8` and planned units remain).
- Never guess past an ambiguous issue — bounce to `needs_refinement[]`.
- Never bump versions or edit `CHANGELOG.md`/`package.json`/the release manifest.
- Never reply to external commenters; never post a comment without the AI marker.
