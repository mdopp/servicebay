---
name: autoloop-issues
description: Orchestrates an autonomous issue-resolution pipeline — Planner → Builder → Box-Verify — coordinated through a shared work queue, spawning each stage as a fresh sub-agent so the loop session stays clean. Fast per-issue gates, expensive pipeline (CI + release + real-box /verify) once per batch. `security`-labelled issues open as draft and wait for human review. Resumable via .claude/state/work-queue.json. Use when the user asks to "burn down the backlog", "work the issues autonomously", or invokes /loop with this skill.
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
                                      └────────────────────────────────────  BOX-VERIFY ──gates──▶ release PR
                                                                              :dev flip-verify-flipback
  DOCS-COHERENCE runs as a separate parallel /loop (own worktree, disjoint fileset) — not dispatched here.
```

The user's recurring rules (in `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md`) override anything in this skill if they conflict. Read it before the first iteration of a fresh /loop run.

**The ServiceBay box is a dev/test target for this loop, not production — exercise it freely.** Stage agents use SSH, the MCP token, the HTTP API, and Playwright/Chrome to implement and verify changes, and flip the `:dev` channel without hesitation. **Do not ask the user for permission to use or flip the box** (access: memory `reference_mcp_servicebay_access`).

## The shared work queue (the only handoff)

`.claude/state/work-queue.json` is the single source of truth between stages. Stage agents read it, do their work, **write their results back into it**, and return a one-line summary. You re-read it after every spawn. Schema in `work-queue-template.json` (same dir); create from that template if absent.

Key fields:
- `queue[]` — **units** the builder consumes, in selection order. A unit is `{id, kind: "cluster"|"issue"|"lint-sweep", issues[], theme, region, scope, acceptance, gate: "normal"|"verify"|"security", status: "planned"|"in_progress"|"built"|"blocked", pr, notes}`. A cluster is the work-unit; its member issues never appear as standalone units.
- `batch` — the persistent integration branch: `{branch, units[], count, sealed}`. **Survives across firings.** Reset to `null` after its release PR merges.
- `needs_refinement[]` — **the human's worklist.** `{issue, question, comment_url, since}`. The planner parks any issue it can't make actionable without a human decision here, with the *specific* question. This is the one queue a human is expected to drain.
- `awaiting_user[]` — external human comment unanswered; `/comment-responder`'s job, never the pipeline's.
- `review[]` — security-gate draft PRs awaiting human review; never auto-merged.
- `box_verify` — `{sha, status: "owed"|"red"|"green", detail, since}`. Gates the release PR.
- `blocked[]`, `completed[]`, `lint_sweep[]`, `release_warnings[]`, `last_codebase_eval`, `notes[]` — as before.

## Batch economy — the prime directive (ENFORCED)

The expensive pipeline — full `npm test`, CI, release-please, real-box `/verify` — runs **once per batch (up to 8 closed issues), never once per issue** (#1432/#1433/#1434). All fixes accumulate on ONE long-lived branch `batch/<id>`; it is pushed / PR'd / CI'd / merged / released / verified **only when it holds 8 closed issues OR the queue of planned units is empty.** A firing that ships one issue as its own PR+release while planned units remain is a **failure of this pipeline**.

The builder enforces the per-issue side (fast gates only, commit to the batch branch, no push). You enforce the batch side: **never dispatch a seal/verify/release step while `batch.count < 8` AND planned units remain.**

## Step 0 — Preflight (every firing)

1. **Working tree clean?** `git status --porcelain`. If dirty, exit — another session owns this tree. Don't stash or switch branches.
2. **On `main`, up to date?** `git fetch origin && git checkout main && git pull --ff-only`. If FF fails, exit and report.
3. **Lock check.** If `.claude/state/autoloop.lock` exists with mtime < 10 min, another firing is running — exit. Otherwise touch it.
4. **Read the work queue.** Create from `work-queue-template.json` if absent. Seed `started`/`last_invocation`.
5. **Release-PR gate.** `gh pr list --head release-please--branches--main--components--servicebay --state open --json number,title`. If a release PR is open:
   - If `box_verify.status` is `"owed"` or `"red"` → a path-mandated change is on `main` but unverified on `:dev`. **Do not merge the release PR.** Make the next dispatch a **Box-Verify** (see dispatch). Only proceed once `box_verify.status` is `"green"` (or nothing path-mandated is pending).
   - Else wait for its CI (`gh pr checks <PR#> --watch`). Green → `gh pr merge <PR#> --merge --delete-branch`, then `git pull --ff-only`, then reset `batch` to `null`. Red → post the failing-job link on the release PR (with the AI marker) and **stop** (hard exit #2 territory — a regression is hiding under the version bump). **Never edit the release PR's contents** — release-please owns version/CHANGELOG/manifest (memory: *"NEVER manually bump versions"*).

## Step 1 — Dispatch (the loop body)

Pick **exactly one** stage this tick, by the first rule that matches, and spawn it (Step 2). Then re-read the queue and loop.

1. **Box-Verify** — if `box_verify.status == "owed"` (a path-mandated change merged but isn't `:dev`-verified). Verifying clears the release gate, so it comes first.
2. **Builder — seal** — if a `batch` exists and (`batch.count >= 8` **or** `queue[]` has no `status:"planned"` unit) and the batch isn't already merged. The builder pushes the accumulated branch, runs full gates + CI, merges, and sets `box_verify=owed` if any merged file was path-mandated.
3. **Builder — build** — if `queue[]` has a `planned` unit and `batch.count < 8`. The builder implements the next unit onto the batch branch with fast gates only.
4. **Planner** — if there is no actionable unit (queue has no `planned` units and no open batch to seal). The planner refills the queue: groom + cluster open issues, decompose epics, park refinement/awaiting-user/security, or (queue genuinely dry) enqueue lint-sweep units or run a codebase eval.

If a rule's preconditions are met but you're mid-batch (`batch.count < 8` and planned units remain), **never** jump to seal/verify/release — that's the prime-directive violation. Keep building.

## Step 2 — Spawning a stage agent

Use the **Agent** tool, `subagent_type: "general-purpose"` (it needs Bash, gh, the box MCP tools, Edit/Write). Run **foreground** (blocking) — stages serialize because they share the batch branch, `main`, and the box. Prompt template:

```
Read .claude/skills/autoloop-issues/stages/<planner|builder|box-verify>.md and follow it exactly.
Context for this run: <the specific unit id / batch state / box_verify entry it should act on>.
The shared queue is .claude/state/work-queue.json — read it, write your results back into it
(update unit status, append to completed/review/needs_refinement/etc., set box_verify), and
return ONE line: what you did + the queue mutations you made. Do not narrate.
```

Builder mode (`build` vs `seal`) is passed in the context line. For the builder, also pass the gate (`normal`/`verify`/`security`) of the unit.

After the agent returns: **re-read `work-queue.json`** (the agent is authoritative; trust the file, not the summary), append the agent's one-liner to your own running tally, and go back to Step 1.

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

**Never sleep while there is eligible work** — go straight to the next dispatch in the same turn. Schedule a wakeup (`ScheduleWakeup`) only when:
- **Mid-pipeline, waiting on an external gate** (release-please CI running, a `:dev` image still building / box restarting) → `delaySeconds ≤ 480`, prefer ~60s if you expect it imminently.
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
  Box-verify:        green @ <sha> | owed | red (<detail>)
  Security drafts:   #<pr> (#<issue>)
  Needs refinement:  #<issue> — "<question>"   ← your worklist
  Awaiting user:     #<issue> (external comment)
Next: <building #x | sealing batch | verifying | planner refill | idle heartbeat>.
```

The **Needs refinement** line is the point of the whole pipeline — it's what you, the human, act on.

## Hard exit conditions (stop the loop; do not reschedule)

1. A stage agent reports CI red twice on the same SHA with no code change between.
2. Release-PR CI is red and preflight auto-merge failed twice (a regression hides under the bump — human eyes needed).
3. `review[]` has >3 security drafts unreviewed (review backlog, not a code problem).
4. Working tree was dirty at preflight on two consecutive firings (another session is active here).
5. A box `/verify` failed twice on the same SHA with no change between, **or** the `:dev`→`:latest` flip-back failed (box must never be stranded on `:dev`).
6. Both the planner's issue queue and lint set are empty **and** the codebase eval was run within the last ~5 firings (truly nothing mechanical left).

## Things this orchestrator explicitly does NOT do

- Does not write code, groom issues, or run `/verify` itself — it only dispatches stage agents.
- Does not run `gh pr merge --auto` (no branch protection on this repo — it silently no-ops).
- Does not bump versions or edit the release-please PR's contents.
- Does not dispatch a seal/verify/release step while mid-batch (prime directive).
- Does not ship a path-mandated change to `:latest` without a green `:dev` box `/verify` (release gate via `box_verify`).
- Does not reply to external human commenters, and never posts a comment without the AI marker.

## Reference

- Stage playbooks: `stages/planner.md`, `stages/builder.md`, `stages/box-verify.md` (this dir).
- Queue schema: `work-queue-template.json` (this dir).
- Parallel docs loop: `.claude/skills/docs-coherence/SKILL.md` (run as its own `/loop /docs-coherence`).
- Memory index: `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md`.
- Real-box access: memory `reference_mcp_servicebay_access`. `<SERVICEBAY_BOX>` lives there, not in this public repo.
- Release flow: release-please PR on `release-please--branches--main--components--servicebay`.
