# autoloop-issues — how to run

`autoloop-issues` is the **orchestrator** of a multi-agent pipeline. It spawns a fresh sub-agent per stage (Planner → Builder → Box-Verify), coordinated through the `autoloop:queue` state broker (durable state in GitHub `autoloop:*` labels + issue comments, a tiny gitignored local cache for in-flight run state), so the loop session stays clean.

## Self-paced loop (recommended)

```
/loop /autoloop-issues
```

`/loop` re-fires the orchestrator on its own cadence. GitHub labels + the local cache persist progress between firings, so context can roll over without losing the batch or the plan. Each stage runs in its own sub-agent context — the long-lived loop session only accumulates one-line summaries.

## Run the docs loop in parallel (separate, disjoint fileset)

```
/loop /docs-coherence
```

Docs-coherence is **not** dispatched by the orchestrator — it's a peer loop in its own git worktree. Run it alongside; the two never touch the same files.

## What each stage does

- **Planner** (`stages/planner.md`) — grooms/clusters open issues into units, decomposes epics, and **bounces every underspecified issue to an `autoloop:needs-refinement` comment with a specific question.** That label is your worklist.
- **Builder** (`stages/builder.md`) — implements one unit onto the persistent `batch/<id>` branch with **fast gates** (`lint` + `check:arch` + `vitest --changed`); at the batch boundary runs the **full** `npm test` + CI and merges.
- **Box-Verify** (`stages/box-verify.md`) — batched `:dev` flip-verify-flipback for path-mandated changes; gates the release PR.

## Where human attention goes

Drain `autoloop:needs-refinement` — sharpen the ambiguous issues / answer the planner's questions. Everything else (grouping, building, verifying, releasing) runs without you. Secondary: eyeball `autoloop:review` (shipped security changes) and let `/comment-responder` clear `autoloop:awaiting-user`.

## Stop a running loop

Interrupt the session. GitHub labels + the cache persist; the next firing resumes (mid-batch builds continue on the same branch). A claim the interrupted builder held stays held — `npm run autoloop:queue -- claims` shows it, `… -- unclaim <unit|issue>` gives it back.

## Inspecting / resetting state

Both tiers are inspectable without loading a big file into context:

- **GitHub** (durable): `gh issue list --label autoloop:needs-refinement,autoloop:blocked,autoloop:review,autoloop:awaiting-user --state open` is the whole human-facing worklist at a glance.
- **Local cache** (ephemeral, `.claude/state/autoloop-cache.json`, gitignored): `npm run autoloop:queue -- summary`.

Reset: `rm .claude/state/autoloop-cache.json` (or `npm run autoloop:queue -- rebuild --release-pr <n>`) — it is fully reconstructable from GitHub labels; nothing durable lives only in that file. There is no `work-queue.json` any more (retired in #2639) — don't recreate it.

## Tuning models

The orchestrator sets a model per stage (see the table in `SKILL.md` Step 2): Builder=`opus` for real code / `haiku` for lint sweeps, Planner/Box-Verify=`sonnet`. Edit that table to shift the cost/quality balance.

## Safety toggles

- **Pause all merges:** in `stages/builder.md` seal section, always pass `--draft` and skip the merge gate.
- **Single label only:** in `stages/planner.md` Step 4, filter selection to one bucket.
- **Extend the security gate:** in `stages/planner.md` classification, add labels to the security-gate bucket.

## When NOT to run

- Another session is actively editing files here (the orchestrator exits on a dirty tree).
- You haven't reviewed any of the first autonomous PRs yet — let humans eyeball the early output before going hands-off.
- You're mid-incident on the FCoS box.
