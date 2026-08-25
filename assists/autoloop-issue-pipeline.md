---
title: Autoloop — burn down a repo's backlog autonomously, and unblock the projects waiting on you
whenToUse: You want an agent loop that works a GitHub backlog on its own — planning, building, verifying on the real box — instead of one-issue-at-a-time sessions. Read this before writing your own orchestrator; it is the shape two repos converged on, plus the mistakes that cost real releases.
kind: guide
tags: [agent, loop, backlog, issues, pipeline, ci, release, verify, cross-repo, autonomy]
---

# Autoloop — an autonomous issue pipeline

Three stages, each a **fresh sub-agent** returning one line, dispatched by a small
long-lived orchestrator:

```
PLANNER  → groom issues into units, park what needs a human decision
BUILDER  → implement one unit onto a shared batch branch; at the boundary: seal → CI → merge
VERIFY   → deploy the merged artifact to the real box and check it (background)
```

Each stage starts cold, so the loop session stays small and every stage reasons in
clean context. Two reference implementations run this shape:
`mdopp/servicebay` `.claude/skills/autoloop-issues/` (broker: `scripts/autoloop-queue.ts`,
`npm run autoloop:queue`) and `mdopp/solarisbay` `.claude/skills/autoloop-issues/`
(broker: `queue.py`). Same design, different host language — pick whichever matches
the repo's house rule for scripts.

## The four rules that actually matter

**1. Batch economy.** The expensive pipeline — full gates, CI, real-box verify — runs
**once per batch**, never once per issue. Accumulate fixes on one branch; ship when it
holds N issues *or* the queue is empty. Shipping one issue as its own PR while planned
work remains defeats the whole design.

**2. Another project waiting on you comes first.** If an issue says another project
needs it, it outranks everything else — that team is stalled until you ship, so one
unit there unblocks more work than any local fix. You know it because **the issue says
so** (it names the repo, links their issue, someone from there asked). Don't infer it
and don't maintain a list of projects. Same rule outbound: when you find something that
belongs to another repo, **file an issue there** — symptom + repro + starting-point
files, no fix-plan. Filing the issue *is* the handoff; never open a cross-repo PR.

**3. Finish to production.** Done means merged, released, and verified running — not
"drafted, ready for review". Never end a run with the loop stopped and work remaining.
When you genuinely need the operator, **ask with concrete options**, written for
someone who hasn't looked at the project for weeks — name the thing, say what it
changes in the real world, say what each option causes ("the assistant may unlock the
front door", not "adds `lock` to the domain allowlist") — then carry on to done. A
question is a checkpoint, not an exit.

**4. Tests prove code, the box proves the feature.** CI builds images; it does not
exercise the assembled system. Anything path-mandated (deployables, templates,
migrations) gets a real deployment and a real check before the release is considered
good. Verify runs in the background so building continues while it does; only the
seal→release critical section serialises.

## State: durable in GitHub, ephemeral in a tiny cache

Put **durable** state where it survives crashes, machines, and concurrent loop
instances: GitHub. Work status as labels (`autoloop:queued|building|blocked|
needs-refinement|review|awaiting-user`), human questions and park reasons as issue
comments, completion as closed issue + merged PR.

Keep **ephemeral** run state in a small gitignored cache reached only through a broker
script (`summary|candidates|plan|next|claim|unclaim|built|batch|verify-set|park|note`).
No stage ever reads a big JSON blob into context — each asks for the slice it needs,
and the caps (bounded notes ring, dropped finished units, clipped free text) are
enforced in the broker's code, not in prose a model must remember each run.

> **Footgun, learned the hard way:** an earlier version kept one fat `work-queue.json`
> re-read in full every tick (~82 KB). It burned tokens for nothing and was unsafe with
> two loop instances. If your design has a growing file every stage reads, that is the
> bug.

### The claim must be atomic, not merely "usually right"

The whole point of moving state to GitHub is that two loop instances can share it. That
only holds if the claim — "this issue is mine to build" — is a real lock. **A label is
not one.** `gh issue edit --add-label autoloop:building` succeeds when the label is
already present, so both instances read "success" and both build the same issue. A
racing claim is worse than the local file it replaced, because now you *believe* it is
safe.

Use the one primitive GitHub gives with genuine compare-and-set semantics:
**create a git ref.** `POST /repos/{owner}/{repo}/git/refs` returns **HTTP 422
"Reference already exists"** when the ref is already there, so exactly one creator wins.
Claim with `refs/<loop>/claim/<issue>`; treat the visible label as the *projection* of
that ref, applied only after it is won. Then:

- **Fail closed.** A conflict *and* a transport error both mean "not proven mine". A
  claim you cannot prove you hold is not yours.
- **All-or-nothing for a cluster.** Claim the member issues in ascending order (so two
  racers collide on the same ref first) and roll back a partial win — otherwise two
  instances deadlock, each holding half a cluster.
- **Give it back.** A claim outlives the process that took it, so the broker needs
  `unclaim` and a `claims` listing, and shipping a batch must release its claims.
- **Test the race, don't reason about it.** Run N real processes against a stub whose
  ref store is a POSIX `mkdir` (same create-if-not-exists contract) and assert exactly
  one wins; then mutate the conflict check and confirm the test goes red. A claim guard
  no test can break is a claim guard nobody has checked.

## Footguns that cost real releases

- **Silent truncation.** A verify checklist clipped at 280 chars lost its pass/fail
  criteria and still read as complete. Bound fields generously and mark the cut
  (`… [clipped, N chars dropped]`); a caller must never mistake a fragment for the whole.
- **Batch PR titles must not be Conventional Commits.** Merging with a merge commit puts
  the PR title in the merge body, and release-please counts it as another commit — every
  batch then lands in the changelog twice, once as its umbrella title and once per
  commit. Title batches `Batch <id>: <theme>`.
- **Revert commits need git's canonical form** — `Revert "<original subject>"` plus
  `This reverts commit <sha>.` A hand-written `revert(scope): …` left the reverted fix
  listed in the changelog as delivered, closing an issue whose code was no longer in the
  tree. Check the release PR after any revert; don't assume the tooling cancels it.
- **A non-blocking check is not a check.** A `continue-on-error` dependency audit sat red
  for months — not because of findings, but because it crashed at install on a Python
  version mismatch. Nobody looked, because it was allowed to fail. Either make it
  blocking or delete it.
- **Don't infer an ordering from a value that can rot.** A warm-load order keyed on a
  reported size field passed every unit test and inverted itself on real hardware,
  because the field didn't track the cost it was standing in for. Prefer identity from
  config over a measurement you don't control — and fixture the *misleading* real values
  in the test so the regression can't return.

## Human attention goes to one place

Design so the operator's whole job is answering specific questions. Every ambiguous
issue becomes one sharp question ("A or B?", not "please clarify") posted as a comment
and labelled; everything else — grouping, building, sealing, verifying, releasing —
runs without them.

## Adopting it

Copy the reference `SKILL.md` + `stages/` + the broker script, then replace: the repo
name, the path-mandated list (what must be verified on the box), the gate commands, and
what "deploy to the real environment" means for you. The stage split, the batch economy,
the GitHub-durable state, the atomic claim and the four rules above are the portable
part.

If a standard here made you guess or turned out wrong, report it back
(`report-standards-gaps`) — that is how this entry got written.
