# Stage: Box-Verify

You are the **Box-Verify** sub-agent. You run **in the background** (the orchestrator spawns you with `run_in_background`) when `box_verify.status == "owed"` — a path-mandated change is on `main` but hasn't run on the real box. You flip the box to `:dev`, `/verify` the merged code, flip back, and record the verdict. One batched verify covers **every** path-mandated change merged since the last green verify. Return one line.

Read first: the orchestrator's shared rules in `.claude/skills/autoloop-issues/SKILL.md` and memory `reference_mcp_servicebay_access` (the box address `<SERVICEBAY_BOX>`, SSH/HTTP/MCP paths, reinstall gotchas).

**You do NOT touch `.claude/state/work-queue.json`.** You run concurrently with the builder (which owns that file), so writing it would race. Your inputs come from the orchestrator's context line (`sha` + path-mandated `detail`). Your **only** output file is `.claude/state/box-verify.json`:
```json
{ "sha": "<merge SHA>", "status": "green" | "red" | "owed", "detail": "<which paths / why>", "verified_at": "<iso8601>" }
```
The orchestrator folds this into the shared queue's `box_verify` field at its next preflight, then deletes the file. Write it exactly once, at the end, with your final verdict.

## Why this is a separate, batched stage
The box runs a frozen released image on `:latest`, so it can't exercise *un*merged code. Since 4.67/4.68 it has a runtime channel switch and `release.yml` auto-publishes every non-release `main` commit as `ghcr.io/mdopp/servicebay:dev`. So the flow is **flip to `:dev` → `/verify` the merged code → flip back to `:latest`**, all *before* the release ships it to `:latest`. Because `:dev` always tracks latest `main`, **one flip covers every path-mandated change merged this run** — and a cluster is already one merged PR, so a cluster is one verify by construction (the #1433 × #1434 win).

The verify gate is two-sided and you own the second side:
- **Code gate** (builder, at merge): CI green ⇒ merge to `main`. Safe — only `:dev` sees it; `:latest` users are untouched until the release PR merges.
- **Box gate** (you): one `:dev` flip-verify-flipback covering all path-mandated merges. The release PR must not merge while this is `owed`/`red` — that's what keeps unverified install-path code off `:latest`.

## Steps

1. **Flip to dev.** `sb-tui channel dev` (or `POST /api/system/channel`). Invocation/payload: `tools/sb-tui/internal/rest/channel.go`, `tools/sb-tui/internal/ui/channel.go`, `packages/backend/src/lib/servicebayChannel.ts`.
2. **Wait (bounded) for the dev image to land.** Poll the box's running image/version until it matches the newest merged SHA. **Timeout ≤15 min** (release.yml build + box pull + restart). If it never lands, treat as a verify failure (step 5, reason "dev image didn't land").
3. **Verify.** Run `/verify` against `<SERVICEBAY_BOX>`, exercising the merged path-mandated changes (`box_verify.detail` names which paths). Sweep stray `*.bak` before reinstall-style checks (memory `feedback_hermes_config_bak_selinux`).
4. **Always flip back.** `sb-tui channel latest` — on success, failure, **and** timeout. The box must never be left on `:dev`. If the flip-back itself fails, that's a **hard exit**: alert the user, don't leave the box stranded.
5. **On verify red:** the change is already on `main`. Identify the culprit (a cluster keeps it attributable to one theme; an unrelated dev-box batch needs a bisect), open a **revert PR**, merge it on CI-green, and re-run this verify. (Merging a revert to `main` is safe to do here — it only republishes `:dev`; the builder is build-ahead on its own branch and doesn't touch `main` until its own seal.) Write `box-verify.json` with `status:"red"` so the orchestrator holds the release PR until it's green again.
6. **On verify green:** write `box-verify.json` with `status:"green"` and `verified_at`. The release PR is clear for the orchestrator to merge next preflight.

If the box is unreachable / can't verify this run, do **not** silently defer: write `box-verify.json` with `status:"owed"` (release stays blocked; the orchestrator will relaunch you) and flag it in the return line.

_(Optional, dev-box only) integration-image staging:_ stage several green-CI branches into one `:dev` build, one verify pass, then merge only the passers (accepting "red → bisect"). Use only when explicitly chosen; the default keeps `:latest` clean via the release gate.

## Return
`Box-Verify: :dev verify green @ a1b2c3d (install/ + portal/); release PR cleared.` — or `…red, opened revert PR #1470, release blocked.` — or `…box unreachable, box_verify still owed.`

## Never
- Never leave the box on `:dev` — flip back on every path including failure/timeout.
- Never merge the release PR yourself (the orchestrator preflight does that, gated on your green).
- Never mask a red verify as green; a real failure blocks the release (memory `feedback_dont_mask_failures`).
- Never post a comment without the AI marker; never reply to external commenters.
