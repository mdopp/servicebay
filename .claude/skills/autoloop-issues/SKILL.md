---
name: autoloop-issues
description: Orchestrates an autonomous issue-resolution pipeline — Planner → Builder → Box-Verify — coordinated through a shared work queue, spawning each stage as a fresh sub-agent so the loop session stays clean. Fast per-issue gates, expensive pipeline (CI + release + real-box /verify) once per batch. `security`-labelled issues run the full loop too and are flagged in the deployed list for post-deploy review. Resumable via .claude/state/work-queue.json. Use when the user asks to "burn down the backlog", "work the issues autonomously", or invokes /loop with this skill.
---

# Autoloop orchestrator

You are the **coordinator** of an autonomous issue-resolution pipeline. You do **not** write code, groom issues, or verify the box yourself — you run a tight dispatch loop that **spawns a fresh sub-agent per stage** and routes work between them through one shared file, `.claude/state/work-queue.json`.

Why this shape: each sub-agent starts cold and returns only a one-line summary, so the long-lived loop session stays small and every stage reasons in clean context. The pipeline is built so **human attention goes to one place: refining issues** (`needs_refinement[]`). Everything downstream — grouping, building, verifying — runs without you.

```
            ┌──────────────────────── you (orchestrator, this session) ───────────────────────┐
            │  preflight → read queue → dispatch ONE stage agent → re-read queue → cadence     │
            └──────────────────────────────────────────────────────────────────────────────────┘
 PLANNER ──fills──▶ work-queue.json ──┬─▶ BUILDER ──merges, sets box_verify=owed──┐
 groom/cluster/                       │   fast gates, batch seal,                  │
 decompose/refine                     │   push→CI→merge                            ▼
                                      └─▶ BUILDER build-aheads     BOX-VERIFY (background) ──gates──▶ release PR
                                          next batch concurrently  :dev flip-verify-flipback
                                          (no main, no box)         writes box-verify.json result file
  BOX-VERIFY runs in the BACKGROUND (Agent run_in_background) and writes its result to its OWN file
  (.claude/state/box-verify.json); the orchestrator folds it into box_verify at preflight (single writer).
  While it runs, the builder keeps BUILDING the next batch. Only the seal→release→verify critical
  section serializes; building is concurrent with it.
  DOCS-COHERENCE runs as a separate parallel /loop (own worktree, disjoint fileset) — not dispatched here.
```

The user's recurring rules (in `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md`) override anything in this skill if they conflict. Read it before the first iteration of a fresh /loop run.

**The ServiceBay box is a dev/test target for this loop, not production — exercise it freely.** Stage agents use SSH, the MCP token, the HTTP API, and Playwright/Chrome to implement and verify changes, and flip the `:dev` channel without hesitation. **Do not ask the user for permission to use or flip the box** (access: memory `reference_mcp_servicebay_access`).

## The shared work queue (the only handoff)

`.claude/state/work-queue.json` is the single source of truth between stages. Stage agents read it, do their work, **write their results back into it**, and return a one-line summary. You re-read it after every spawn. Schema in `work-queue-template.json` (same dir); create from that template if absent.

Key fields:
- `queue[]` — **units** the builder consumes, in selection order. A unit is `{id, kind: "cluster"|"issue"|"lint-sweep", issues[], theme, region, scope, acceptance, gate: "normal"|"verify", security: false, status: "planned"|"in_progress"|"built"|"blocked", pr, notes}`. A cluster is the work-unit; its member issues never appear as standalone units. `gate` is the verification level (path-mandated **or** user-facing/visual ⇒ `verify`); `security: true` flags a sensitive change for **post-deploy** review — it does **not** block the merge. **A unit/slice/epic with explicit acceptance criteria closes only when those criteria are verified criterion-by-criterion (builder self-verify + box-verify acceptance check), never on a "built" claim + green CI** — see the close/gate rules in `stages/{planner,builder,box-verify}.md` (memory `feedback_acceptance_criteria_must_gate_close`).
- `batch` — the persistent integration branch: `{branch, units[], count, sealed}`. **Survives across firings.** Reset to `null` after its release PR merges.
- `needs_refinement[]` — **the human's worklist.** `{issue, question, comment_url, since}`. The planner parks any issue it can't make actionable without a human decision here, with the *specific* question. This is the one queue a human is expected to drain.
- `awaiting_user[]` — external human comment unanswered; `/comment-responder`'s job, never the pipeline's.
- `review[]` — **your post-deploy review list**: `{issue, pr, flag, merged_at}` for shipped `security:true` (and other sensitive) changes. Informational — the loop merges and deploys them like anything else; this is just what you eyeball after the fact. **Not** a merge gate.
- `box_verify` — `{sha, status: "owed"|"verifying"|"red"|"green", detail, since}`. Gates the release PR. State machine: `owed` (path-mandated change merged, not yet verified) → `verifying` (a background Box-Verify agent is in flight) → `green`|`red`. (Box-Verify picks a **LIGHT** path — scratch `nginx -t` + `:latest` probes, no `:dev` flip — for render-only changes, or the **FULL** `:dev` flip for app-behavior changes; see `stages/box-verify.md` Step 0. Orchestrator-transparent — the gate semantics are identical.) You set `verifying` when you launch the background agent; the agent writes its verdict to `.claude/state/box-verify.json` (its own file, **not** the shared queue), and you fold that verdict back into this field at preflight. A `verifying` entry whose `since` is >20 min old with no result file = the agent died → reset to `owed` (it'll relaunch).
- `blocked[]` — parked work, each entry `{issue, blocked_by, reason, since}` where `blocked_by` is a **machine-checkable unblock condition** (`"#<N>"` dependency · `"capability:browser-verify"` · `"capability:real-box-verify"` · `"decomposition"` · `"epic"`). The planner rechecks the condition **every run** (Step 1b: cheap check all, deep re-examine only the tripped) — not a stale list. `completed[]`, `lint_sweep[]`, `release_warnings[]`, `last_codebase_eval`, `notes[]` — as before.

**Label mirror (one-way projection).** The queue file is the source of truth; three human-facing states are *mirrored* to GitHub labels so a human sees the same worklist and can pick up: `blocked[]` → `autoloop:blocked`, `needs_refinement[]` → `autoloop:needs-refinement` (both reconciled by the **planner**, Step 6 of `planner.md`), and `box_verify` → `autoloop:box-verify-pending`/`-failed` on the **release PR** (set here in preflight). Labels are derived from the file every run — never the reverse — so drift is cosmetic and self-heals. (The pre-existing `autoloop-open` is unrelated: it's a human-set *planner-skip* exclusion, not part of this mirror.)

## Batch economy — the prime directive (ENFORCED)

The expensive pipeline — full `npm test`, CI, release-please, real-box `/verify` — runs **once per batch (up to 8 closed issues), never once per issue** (#1432/#1433/#1434). All fixes accumulate on ONE long-lived branch `batch/<id>`; it is pushed / PR'd / CI'd / merged / released / verified **only when it holds 8 closed issues OR the queue of planned units is empty.** A firing that ships one issue as its own PR+release while planned units remain is a **failure of this pipeline**.

The builder enforces the per-issue side (fast gates only, commit to the batch branch, no push). You enforce the batch side: **never dispatch a seal/verify/release step while `batch.count < 8` AND planned units remain.**

**Build-ahead is allowed; seal-ahead is not.** Box-Verify runs in the background (it touches only the box and its own result file). The builder may keep **building** the next batch onto a fresh `batch/<id>` branch while a prior batch is being verified — building writes neither `main` nor the box, so it's safe to overlap. What must **not** overlap is the singleton critical section: there is one `main`, one release PR, and one `box_verify` field, so **a new batch may not be *sealed* while `box_verify.status` is `owed`/`verifying`/`red`** (a prior batch is still in release/verify). Build up to 8 and then *wait* for the verify to clear before sealing. This caps in-flight to one batch in the critical section while keeping the builder busy.

## Step 0 — Preflight (every firing)

1. **Working tree clean?** `git status --porcelain`. If dirty, exit — another session owns this tree. Don't stash or switch branches.
2. **On `main`, up to date?** `git fetch origin && git checkout main && git pull --ff-only`. If FF fails, exit and report.
3. **Lock check.** If `.claude/state/autoloop.lock` exists with mtime < 10 min, another firing is running — exit. Otherwise touch it.
4. **Read the work queue.** Create from `work-queue-template.json` if absent. Seed `started`/`last_invocation`.
5. **Fold in any background Box-Verify result.** If `.claude/state/box-verify.json` exists, the background agent finished: copy its `{sha, status, detail, verified_at}` into `box_verify` (you are the single writer of the shared queue's `box_verify` field), then **delete the result file**. If `box_verify.status == "verifying"` but no result file exists and `since` is >20 min old, the agent died — reset `box_verify.status` to `"owed"` so it relaunches.
6. **Release-PR gate.** `gh pr list --head release-please--branches--main--components--servicebay --state open --json number,title`. If a release PR is open:
   - **Mirror `box_verify` onto the release PR as a label** (the human-visible projection of the box gate — labels only, never the PR body, which release-please owns): `owed`/`verifying` → ensure `autoloop:box-verify-pending`; `red` → ensure `autoloop:box-verify-failed`; `green`/`null` → remove both. Swap, don't stack (the two are mutually exclusive).
   - If `box_verify.status` is `"owed"`, `"verifying"`, or `"red"` → a path-mandated change is on `main` but not yet `:dev`-verified green. **Do not merge the release PR.** Don't block the firing on it either — fall through to dispatch (which launches/awaits the background Box-Verify and keeps building). Only merge the release PR once `box_verify.status` is `"green"` (or nothing path-mandated is pending).
   - Else wait for its CI (`gh pr checks <PR#> --watch`). Green → `gh pr merge <PR#> --merge --delete-branch`, then `git pull --ff-only`, then reset `batch` to `null`. Red → post the failing-job link on the release PR (with the AI marker) and **stop** (hard exit #2 territory — a regression is hiding under the version bump). **Never edit the release PR's contents** — release-please owns version/CHANGELOG/manifest (memory: *"NEVER manually bump versions"*).

## Step 1 — Dispatch (the loop body)

**First, a non-blocking side-action (does NOT consume the tick):** if `box_verify.status == "owed"`, launch Box-Verify **in the background** (Step 2, `run_in_background: true`), set `box_verify.status = "verifying"` and `since = now`, and **fall through** to pick a foreground stage below. If `box_verify.status == "verifying"`, an agent is already in flight — don't relaunch; just fall through. The background verify clears the release gate on its own time; you don't wait on it here.

Then pick **exactly one** foreground stage this tick, by the first rule that matches, and spawn it (Step 2). Then re-read the queue and loop.

1. **Seal — you run the script yourself (no sub-agent)** — if a `batch` exists and (`batch.count >= 8` **or** `queue[]` has no `status:"planned"` unit) and it isn't merged **and `box_verify.status` is clear** (`green`/`null`). The seal (push → CI → merge → path-mandated) is deterministic, so **the orchestrator runs it directly** — never a wedge-prone seal builder (memory `feedback_seal_builder_ci_watch_wedge`): run the local safety-net gate (`npm run lint && npm run typecheck && npm run check:arch && npm test`) on the batch branch, write the PR body to a temp file, then `npm run autoloop:seal -- <batch.branch> --title "<subject>" --body-file <f>`. **Exit 0** → fold the `AUTOLOOP_SEAL_RESULT` JSON: `box_verify=owed` when `boxVerifyOwed` **or** any sealed unit's `gate` was `verify`; units → `completed[]` (+ `review[]` for `security:true`); `batch=null`. **Exit 3** (CI red) → dispatch a **Builder** to diagnose + fix-forward on the batch branch (real fix, don't ratchet), then re-run the script; a same-SHA re-red with no change → hard-exit #1. **Exit 2** (setup: dirty tree / conflict) → fix + re-run. **Seal-ahead is forbidden:** if `box_verify` is `owed`/`verifying`/`red`, a prior batch is still in the release/verify critical section — don't seal; build-ahead (rule 2) or idle-wait (Step 3).
2. **Builder — build** — if `queue[]` has a `planned` unit and `batch.count < 8`. The builder implements the next unit onto the batch branch with fast gates only. **This is the build-ahead path** — it's eligible even while a background Box-Verify runs, because building touches neither `main` nor the box.
3. **Planner** — if there is no actionable unit (queue has no `planned` units and no open batch to seal). The planner refills the queue: groom + cluster open issues, decompose epics, park refinement/awaiting-user (security issues become normal `security:true` units, not parked), or (queue genuinely dry) enqueue lint-sweep units or run a codebase eval.

If a rule's preconditions are met but you're mid-batch (`batch.count < 8` and planned units remain), **never** jump to seal/verify/release — that's the prime-directive violation. Keep building. If the only thing left to do is wait on a background Box-Verify (batch built out to 8, nothing to plan), don't dispatch a foreground stage — go to Step 3 and schedule a short wakeup.

## Step 2 — Spawning a stage agent

Use the **Agent** tool, `subagent_type: "general-purpose"` (it needs Bash, gh, the box MCP tools, Edit/Write).

**Planner and Builder run foreground (blocking)** — they share `main`, the batch branch, and the shared queue file, so only the seal→release→verify critical section serializes; one foreground stage per tick keeps that file single-writer. **Box-Verify runs in the background** (`run_in_background: true`) — it touches only the box and its own result file, so it overlaps with the builder safely.

Foreground (Planner / Builder) prompt template — they read & write the shared queue:

```
Read .claude/skills/autoloop-issues/stages/<planner|builder>.md and follow it exactly.
Context for this run: <the specific unit id / batch state it should act on>.
The shared queue is .claude/state/work-queue.json — read it, write your results back into it
(update unit status, append to completed/review/needs_refinement/etc., set box_verify=owed at seal), and
return ONE line: what you did + the queue mutations you made. Do not narrate.
```

Background (Box-Verify) prompt template — it does **not** touch the shared queue (avoids a write-race with the concurrent builder); it writes its verdict to its own file:

```
Read .claude/skills/autoloop-issues/stages/box-verify.md and follow it exactly.
Context for this run: verify SHA <box_verify.sha>, path-mandated paths: <box_verify.detail>.
Do NOT write .claude/state/work-queue.json. Write your verdict to .claude/state/box-verify.json as
{sha, status:"green"|"red"|"owed", detail, verified_at}. The orchestrator folds it into the queue.
Return ONE line: the verdict + any revert PR you opened. Do not narrate.
```

Builder mode (`build` vs `seal`) is passed in the context line. For the builder, also pass the unit's `gate` (`normal`/`verify`) and `security` flag.

After a **foreground** agent returns: **re-read `work-queue.json`** (the agent is authoritative; trust the file, not the summary), append the agent's one-liner to your own running tally, and go back to Step 1. The **background** Box-Verify does not block — you proceed immediately; its result is folded in at the next preflight (Step 0, the fold-in step), and the harness re-invokes the loop when it completes.

### Model per stage — match the model to the cost of being wrong

Set `model` on each Agent call. The principle: a weak model on real code *costs* time (rework, bad merges) — don't downgrade where being wrong is expensive; do downgrade mechanical/procedural work.

| Stage / unit | Model | Why |
|---|---|---|
| **Builder** — real code (`kind:"cluster"` or `"issue"`) | `opus` | Code quality is where rework hurts most; never skimp here. |
| **Builder** — `kind:"lint-sweep"` | `haiku` | Mechanical single-file extraction; cheap and fast. |
| **Planner** | `sonnet` | Triage/clustering/refinement-question judgment; bump to `opus` if the backlog is gnarly. |
| **Box-Verify** | `sonnet` | Mostly procedural (flip, poll, run `/verify`); a red result it can't diagnose it just leaves red for a human. |

(Docs-coherence runs as its own `/loop` — set its model there, `sonnet` is the right fit.) The orchestrator itself is pure dispatch/bookkeeping and runs at the session's model — `/fast` or a lighter session model is fine for it.

## Step 3 — Cadence (dynamic /loop mode)

**Never sleep while there is eligible work** — go straight to the next dispatch in the same turn. A **background Box-Verify in flight is not a reason to sleep** if there's still a unit to build: launch/leave it running and keep building the next batch. Schedule a wakeup (`ScheduleWakeup`) only when:
- **Mid-pipeline, waiting on an external gate** (release-please CI running, a `:dev` image still building / box restarting) → `delaySeconds ≤ 480`, prefer ~60s if you expect it imminently.
- **Build-ahead exhausted, only a background Box-Verify outstanding** (batch built out, nothing left to plan, can't seal until verify clears) → `delaySeconds ≤ 480`. The harness also re-invokes you when the background agent completes, so this is just a fallback heartbeat.
- **Queue empty and planner found nothing** → idle heartbeat `delaySeconds ≤ 480`.

Every `ScheduleWakeup` from this loop stays **≤480s** (memory `feedback_autoloop_wakeup_cap`). Pass the same `/loop /autoloop-issues` input back. Do **not** insert an 8-minute nap between dispatches when work remains (memory `feedback_autoloop_throughput`).

## Comment hygiene

Every GitHub comment any stage posts ends with the AI marker (memory `feedback_ai_comment_marker`):

```
<!-- sb-ai-comment -->
🤖 _AI-generated, acting for @mdopp._
```

It posts as `mdopp`, so without the marker no one can tell it's AI-written. Keep comments short and sharp (memory `feedback_concise_answers`). **No stage ever replies to an external human commenter** — those tickets are parked on `awaiting_user[]` for `/comment-responder` + human confirm. The stage playbooks restate this; it is not negotiable.

## End-of-firing summary

When you sleep or exit, print a tally to stdout:

```
Autoloop firing complete.
  Built this firing: <unit ids> → batch/<id> (count N/8)
  Merged batches:    PR #<n> (closes #a #b …)
  Box-verify:        green @ <sha> | verifying (background) | owed | red (<detail>)
  Review post-deploy: #<issue> (#<pr>) — security-flagged, shipped   ← eyeball these
  Needs refinement:  #<issue> — "<question>"   ← your worklist
  Awaiting user:     #<issue> (external comment)
Next: <building #x | sealing batch | verifying | planner refill | idle heartbeat>.
```

The **Needs refinement** line is the point of the whole pipeline — it's what you, the human, act on.

## Hard exit conditions (stop the loop; do not reschedule)

1. A stage agent reports CI red twice on the same SHA with no code change between.
2. Release-PR CI is red and preflight auto-merge failed twice (a regression hides under the bump — human eyes needed).
3. _(reserved)_ — security changes no longer block the loop; they ship and are flagged in `review[]` for post-deploy review.
4. Working tree was dirty at preflight on two consecutive firings (another session is active here).
5. A box `/verify` failed twice on the same SHA with no change between, **or** the `:dev`→`:latest` flip-back failed (box must never be stranded on `:dev`).
6. Both the planner's issue queue and lint set are empty **and** the codebase eval was run within the last ~5 firings (truly nothing mechanical left).

## Things this orchestrator explicitly does NOT do

- Does not write code, groom issues, or run `/verify` itself — it dispatches stage agents for those, and runs deterministic **scripts** for mechanics (e.g. `autoloop:seal` — push/CI/merge; it does not spawn a seal sub-agent).
- Does not run `gh pr merge --auto` (no branch protection on this repo — it silently no-ops).
- Does not bump versions or edit the release-please PR's contents.
- Does not dispatch a seal/release step while mid-batch (prime directive).
- Does not **seal** a new batch while a prior batch's `box_verify` is `owed`/`verifying`/`red` (seal-ahead forbidden — one batch in the release/verify critical section at a time). It *may* build-ahead.
- Does not block the loop on Box-Verify — that runs in the background; the builder keeps building while it does.
- Does not ship a path-mandated change to `:latest` without a green `:dev` box `/verify` (release gate via `box_verify`).
- Does not reply to external human commenters, and never posts a comment without the AI marker.

## Reference

- Stage playbooks: `stages/planner.md`, `stages/builder.md`, `stages/box-verify.md` (this dir).
- Queue schema: `work-queue-template.json` (this dir).
- Parallel docs loop: `.claude/skills/docs-coherence/SKILL.md` (run as its own `/loop /docs-coherence`).
- Memory index: `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md`.
- Real-box access: memory `reference_mcp_servicebay_access`. `<SERVICEBAY_BOX>` lives there, not in this public repo.
- Release flow: release-please PR on `release-please--branches--main--components--servicebay`.
