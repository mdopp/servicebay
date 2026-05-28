# autoloop-issues — how to run

## One-shot (single invocation, up to 2 PRs)

```
/autoloop-issues
```

## Self-paced loop (recommended)

```
/loop /autoloop-issues
```

The `/loop` skill re-fires this skill on its own cadence. The state file at `.claude/state/autoloop-state.json` keeps progress between firings, so context can roll over without losing the queue.

## Stop a running loop

Interrupt the session. The state file persists; the next invocation resumes from `in_progress`.

## Reset state

```
rm .claude/state/autoloop-state.json
```

A fresh file is created on the next invocation.

## Safety toggles

To pause all merges (everything opens as draft):
- Edit `SKILL.md` Step 4 "PR creation": always add `--draft` in the normal-flow branch and skip the merge gate.

To narrow what runs autonomously to a single label:
- Edit `SKILL.md` Step 1 selection order: filter to `good first issue` only.

To extend the security gate to more labels (e.g. also require human review for `architecture`):
- Edit `SKILL.md` Step 1 classification: add labels to the "Security gate" bucket.

## When NOT to run

- Another session is actively editing files in this directory.
- Release-please PR is open on `release-please--branches--main--components--servicebay`.
- You're mid-incident on the FCoS box.
- You haven't merged any of the issues filed in your last review cycle — let humans review the first few PRs before going autonomous.
